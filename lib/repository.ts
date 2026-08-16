import type { Actor } from "./auth";
import {
  canAssignRole,
  canEditContent,
  canManageGrant,
  canTransferOwnership,
  normalizeGrantRole,
  type AccessRole,
  type GrantRole,
  type ShareableResourceType,
} from "./access";
import {
  assertAdmin,
  buildAdminOverview,
  isAdminEmail,
  type AdminUserAggregate,
} from "./admin";
import {
  assertReleaseProject,
  ConflictError,
  NotFoundError,
  optionalDate,
  optionalEstimate,
  optionalText,
  PermissionError,
  priority,
  requireTitle,
  statusTimestamps,
  ValidationError,
} from "./domain";
import type {
  AppSnapshot,
  CollaboratorRecord,
  ExternalSourceRecord,
  LabelRecord,
  Priority,
  ProjectRecord,
  ReleaseRecord,
  SavedViewRecord,
  StatusCategory,
  TaskLabelAssignment,
  TaskDetailRecord,
  TaskRelationRecord,
  TaskRecord,
  UserRecord,
  WorkflowStatusRecord,
} from "./types";
import {
  parseStoredViewDisplay,
  parseStoredViewQuery,
  validateViewDisplay,
  validateViewQuery,
} from "./view-contract";
import { getD1 } from "@/db";
import { getRuntimeEnvironment } from "./runtime-environment";
import { encodeWorkspaceSyncCursor } from "./workspace-sync-cursor";

type DbRow = Record<string, unknown>;

export const MAX_UI_SNAPSHOT_TASKS = 2_000;
export const INITIAL_UI_SNAPSHOT_TASKS = 40;

const defaultStatuses: Array<[
  string,
  StatusCategory,
  string,
  number,
  number,
]> = [
  ["Backlog", "backlog", "#6b7280", 0, 0],
  ["Todo", "unstarted", "#94a3b8", 1, 1],
  ["In Progress", "started", "#f59e0b", 2, 0],
  ["Done", "completed", "#22c55e", 3, 0],
  ["Canceled", "canceled", "#ef4444", 4, 0],
];

const editableTaskWhere = `(
  (tasks.project_id IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = tasks.project_id AND p.owner_user_id = ?
    ) OR EXISTS (
      SELECT 1 FROM access_grants ag
      WHERE ag.resource_type = 'project' AND ag.resource_id = tasks.project_id
        AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
        AND ag.permission IN ('editor', 'manager', 'full_access')
    )
  )) OR (tasks.project_id IS NULL AND (
    tasks.owner_user_id = ? OR EXISTS (
      SELECT 1 FROM access_grants ag
      WHERE ag.resource_type = 'task' AND ag.resource_id = tasks.id
        AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
        AND ag.permission IN ('editor', 'full_access')
    )
  ))
)`;

const snapshotTaskIdScopeCte = `WITH scoped_task_ids AS (
  SELECT t.id, t.updated_at,
    CASE
      WHEN t.project_id IS NOT NULL AND p.owner_user_id = ? THEN 1
      WHEN t.project_id IS NOT NULL THEN EXISTS (
        SELECT 1 FROM access_grants ag
        WHERE ag.resource_type = 'project' AND ag.resource_id = t.project_id
          AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
      )
      WHEN t.owner_user_id = ? THEN 1
      ELSE EXISTS (
        SELECT 1 FROM access_grants ag
        WHERE ag.resource_type = 'task' AND ag.resource_id = t.id
          AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
      )
    END AS is_visible
  FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
), visible_task_ids AS (
  SELECT id FROM scoped_task_ids WHERE is_visible = 1
  ORDER BY updated_at DESC, id DESC LIMIT ?
)`;

const snapshotTaskProjection = `
  t.id, t.public_id, t.owner_user_id, t.creator_user_id,
  t.identifier, t.sequence_number, t.title, NULL AS description,
  t.status_id, t.priority, t.assignee_user_id, t.project_id, t.release_id,
  t.estimate, t.due_date, t.parent_task_id, t.rank,
  t.started_at, t.completed_at, t.canceled_at, t.archived_at,
  t.comment_count, t.version, t.created_at, t.updated_at`;

export async function getOrCreateUser(actor: Actor): Promise<UserRecord> {
  const db = getD1();
  const existing = await db
    .prepare(
      `UPDATE users
       SET display_name = ?, email = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = (
         SELECT user_id FROM user_identities
         WHERE provider = ? AND provider_account_key = ?
       )
       RETURNING id, display_name, email, timezone`,
    )
    .bind(
      actor.displayName,
      actor.email,
      actor.provider,
      actor.providerAccountKey,
    )
    .first<DbRow>();

  if (existing) return mapUser(existing);

  const userId = `usr_${crypto.randomUUID()}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, display_name, email)
         VALUES (?, ?, ?)`,
      )
      .bind(userId, actor.displayName, actor.email),
    db
      .prepare(
        `INSERT INTO user_identities
          (user_id, provider, provider_account_key, verified_email)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(userId, actor.provider, actor.providerAccountKey, actor.email),
    ...defaultStatuses.map(([name, category, color, position, isDefault]) =>
      db
        .prepare(
          `INSERT INTO workflow_statuses
            (id, owner_user_id, name, category, color, position, is_default)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `status:${userId}:${category}`,
          userId,
          name,
          category,
          color,
          position,
          isDefault,
        ),
    ),
  ]);
  return {
    id: userId,
    displayName: actor.displayName,
    email: actor.email,
    timezone: "UTC",
  };
}

export async function getSnapshot(
  user: UserRecord,
  options: { includeAdminOverview?: boolean; taskLimit?: number } = {},
): Promise<AppSnapshot> {
  const db = getD1();
  const requestedTaskLimit = Number(options.taskLimit ?? MAX_UI_SNAPSHOT_TASKS);
  const taskLimit = Number.isSafeInteger(requestedTaskLimit)
    ? Math.min(MAX_UI_SNAPSHOT_TASKS, Math.max(1, requestedTaskLimit))
    : MAX_UI_SNAPSHOT_TASKS;
  const configuredAdminEmails = adminEmailsFromEnvironment();
  const isAdmin = isAdminEmail(user.email, configuredAdminEmails);
  const [snapshotResults, admin] = await Promise.all([
    db.batch<DbRow>([
      db
        .prepare(
          `SELECT last_sequence FROM workspace_sync_sequences
           WHERE audience_user_id = ?`,
        )
        .bind(user.id),
      db
        .prepare(
          `WITH scoped AS (
             SELECT ${snapshotTaskProjection},
               EXISTS (
                 SELECT 1 FROM external_records er
                 WHERE er.target_type = 'task' AND er.target_id = t.id
               ) AS has_external_source,
               CASE
                 WHEN t.project_id IS NOT NULL AND p.owner_user_id = ? THEN 'owner'
                 WHEN t.project_id IS NOT NULL THEN (
                   SELECT CASE ag.permission
                     WHEN 'full_access' THEN 'manager'
                     WHEN 'manager' THEN 'manager'
                     WHEN 'editor' THEN 'editor'
                     WHEN 'viewer' THEN 'viewer'
                   END
                   FROM access_grants ag
                   WHERE ag.resource_type = 'project'
                     AND ag.resource_id = t.project_id
                     AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                   LIMIT 1
                 )
                 WHEN t.owner_user_id = ? THEN 'owner'
                 ELSE (
                   SELECT CASE ag.permission
                     WHEN 'full_access' THEN 'editor'
                     WHEN 'editor' THEN 'editor'
                     WHEN 'viewer' THEN 'viewer'
                   END
                   FROM access_grants ag
                   WHERE ag.resource_type = 'task' AND ag.resource_id = t.id
                     AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                   LIMIT 1
                 )
               END AS access_role
             FROM tasks t
             LEFT JOIN projects p ON p.id = t.project_id
           )
           SELECT * FROM scoped WHERE access_role IS NOT NULL
           ORDER BY updated_at DESC, id DESC
           LIMIT ?`,
        )
        .bind(user.id, user.id, user.id, user.id, taskLimit + 1),
      db
        .prepare(
          `WITH scoped AS (
             SELECT p.*,
               CASE WHEN p.owner_user_id = ? THEN 'owner' ELSE (
                 SELECT CASE ag.permission
                   WHEN 'full_access' THEN 'manager'
                   WHEN 'manager' THEN 'manager'
                   WHEN 'editor' THEN 'editor'
                   WHEN 'viewer' THEN 'viewer'
                 END
                 FROM access_grants ag
                 WHERE ag.resource_type = 'project' AND ag.resource_id = p.id
                   AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                 LIMIT 1
               ) END AS access_role
             FROM projects p WHERE p.archived_at IS NULL
           )
           SELECT * FROM scoped WHERE access_role IS NOT NULL
           ORDER BY updated_at DESC`,
        )
        .bind(user.id, user.id),
      db
        .prepare(
          `WITH scoped AS (
             SELECT r.*,
               CASE WHEN p.owner_user_id = ? THEN 'owner' ELSE (
                 SELECT CASE ag.permission
                   WHEN 'full_access' THEN 'manager'
                   WHEN 'manager' THEN 'manager'
                   WHEN 'editor' THEN 'editor'
                   WHEN 'viewer' THEN 'viewer'
                 END
                 FROM access_grants ag
                 WHERE ag.resource_type = 'project'
                   AND ag.resource_id = r.project_id
                   AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                 LIMIT 1
               ) END AS access_role
             FROM releases r JOIN projects p ON p.id = r.project_id
           )
           SELECT * FROM scoped WHERE access_role IS NOT NULL
           ORDER BY created_at DESC`,
        )
        .bind(user.id, user.id),
      db
        .prepare(
          `WITH scoped AS (
             SELECT v.*,
               CASE
                 WHEN v.scope_project_id IS NOT NULL AND p.owner_user_id = ? THEN 'owner'
                 WHEN v.scope_project_id IS NOT NULL THEN (
                   SELECT CASE ag.permission
                     WHEN 'full_access' THEN 'manager'
                     WHEN 'manager' THEN 'manager'
                     WHEN 'editor' THEN 'editor'
                     WHEN 'viewer' THEN 'viewer'
                   END
                   FROM access_grants ag
                   WHERE ag.resource_type = 'project'
                     AND ag.resource_id = v.scope_project_id
                     AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                   LIMIT 1
                 )
                 WHEN v.owner_user_id = ? THEN 'owner'
                 ELSE (
                   SELECT CASE ag.permission
                     WHEN 'full_access' THEN 'editor'
                     WHEN 'editor' THEN 'editor'
                     WHEN 'viewer' THEN 'viewer'
                   END
                   FROM access_grants ag
                   WHERE ag.resource_type = 'saved_view' AND ag.resource_id = v.id
                     AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                   LIMIT 1
                 )
               END AS access_role
             FROM saved_views v
             LEFT JOIN projects p ON p.id = v.scope_project_id
           )
           SELECT * FROM scoped WHERE access_role IS NOT NULL
           ORDER BY updated_at DESC`,
        )
        .bind(user.id, user.id, user.id, user.id),
      db
        .prepare(
          `SELECT s.* FROM workflow_statuses s
           WHERE s.owner_user_id = ?
              OR EXISTS (
                SELECT 1 FROM projects p
                WHERE p.owner_user_id = s.owner_user_id AND (
                  p.owner_user_id = ? OR EXISTS (
                    SELECT 1 FROM access_grants ag
                    WHERE ag.resource_type = 'project' AND ag.resource_id = p.id
                      AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                  )
                )
              )
              OR EXISTS (
                SELECT 1 FROM tasks t
                LEFT JOIN projects p ON p.id = t.project_id
                WHERE t.status_id = s.id AND (
                  (t.project_id IS NOT NULL AND (
                    p.owner_user_id = ? OR EXISTS (
                      SELECT 1 FROM access_grants ag
                      WHERE ag.resource_type = 'project'
                        AND ag.resource_id = t.project_id
                        AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                    )
                  )) OR (t.project_id IS NULL AND (
                    t.owner_user_id = ? OR EXISTS (
                      SELECT 1 FROM access_grants ag
                      WHERE ag.resource_type = 'task' AND ag.resource_id = t.id
                        AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                    )
                  ))
                )
              )
           ORDER BY s.owner_user_id, s.position`,
        )
        .bind(
          user.id,
          user.id,
          user.id,
          user.id,
          user.id,
          user.id,
          user.id,
        ),
      db
        .prepare(
          `SELECT DISTINCT u.id, u.display_name, u.email, u.timezone
           FROM users u
           WHERE u.id = ? OR EXISTS (
             SELECT 1 FROM projects p
             WHERE (
               p.owner_user_id = ? OR EXISTS (
                 SELECT 1 FROM access_grants actor_grant
                 WHERE actor_grant.resource_type = 'project'
                   AND actor_grant.resource_id = p.id
                   AND actor_grant.grantee_user_id = ?
                   AND actor_grant.revoked_at IS NULL
               )
             ) AND (
               p.owner_user_id = u.id OR EXISTS (
                 SELECT 1 FROM access_grants member_grant
                 WHERE member_grant.resource_type = 'project'
                   AND member_grant.resource_id = p.id
                   AND member_grant.grantee_user_id = u.id
                   AND member_grant.revoked_at IS NULL
               )
             )
           ) OR EXISTS (
             SELECT 1 FROM tasks t
             WHERE t.project_id IS NULL AND (
               t.owner_user_id = ? OR EXISTS (
                 SELECT 1 FROM access_grants actor_grant
                 WHERE actor_grant.resource_type = 'task'
                   AND actor_grant.resource_id = t.id
                   AND actor_grant.grantee_user_id = ?
                   AND actor_grant.revoked_at IS NULL
               )
             ) AND (
               t.owner_user_id = u.id OR EXISTS (
                 SELECT 1 FROM access_grants member_grant
                 WHERE member_grant.resource_type = 'task'
                   AND member_grant.resource_id = t.id
                   AND member_grant.grantee_user_id = u.id
                   AND member_grant.revoked_at IS NULL
               )
             )
           ) ORDER BY u.display_name, u.id`,
        )
        .bind(user.id, user.id, user.id, user.id, user.id),
      db
        .prepare(
          `SELECT ag.id, ag.resource_type, ag.resource_id, ag.permission,
                  u.id AS user_id, u.display_name, u.email
           FROM access_grants ag
           JOIN users u ON u.id = ag.grantee_user_id
           WHERE ag.revoked_at IS NULL AND (
             (ag.resource_type = 'project' AND EXISTS (
               SELECT 1 FROM projects p
               WHERE p.id = ag.resource_id AND (
                 p.owner_user_id = ? OR EXISTS (
                   SELECT 1 FROM access_grants actor_grant
                   WHERE actor_grant.resource_type = 'project'
                     AND actor_grant.resource_id = p.id
                     AND actor_grant.grantee_user_id = ?
                     AND actor_grant.revoked_at IS NULL
                 )
               )
             )) OR
             (ag.resource_type = 'task' AND EXISTS (
               SELECT 1 FROM tasks t
               WHERE t.id = ag.resource_id AND t.project_id IS NULL
                 AND (t.owner_user_id = ? OR EXISTS (
                   SELECT 1 FROM access_grants actor_grant
                   WHERE actor_grant.resource_type = 'task'
                     AND actor_grant.resource_id = t.id
                     AND actor_grant.grantee_user_id = ?
                     AND actor_grant.revoked_at IS NULL
                 ))
             )) OR
             (ag.resource_type = 'saved_view' AND EXISTS (
               SELECT 1 FROM saved_views v
               WHERE v.id = ag.resource_id AND v.scope_project_id IS NULL
                 AND v.owner_user_id = ?
             ))
           )
           ORDER BY ag.created_at DESC`,
        )
        .bind(user.id, user.id, user.id, user.id, user.id),
      db
        .prepare(
          `${snapshotTaskIdScopeCte}
           SELECT l.* FROM labels l
           WHERE l.owner_user_id = ?
              OR EXISTS (
                SELECT 1 FROM task_labels tl
                JOIN visible_task_ids visible ON visible.id = tl.task_id
                WHERE tl.label_id = l.id
              )
           ORDER BY l.name`,
        )
        .bind(...snapshotTaskScopeParameters(user.id, taskLimit), user.id),
      db
        .prepare(
          `${snapshotTaskIdScopeCte}
           SELECT tl.* FROM task_labels tl
           JOIN visible_task_ids visible ON visible.id = tl.task_id`,
        )
        .bind(...snapshotTaskScopeParameters(user.id, taskLimit)),
      db
        .prepare(
          `${snapshotTaskIdScopeCte}
           SELECT tr.source_task_id, tr.target_task_id, tr.type
           FROM task_relations tr
           JOIN visible_task_ids source_visible
             ON source_visible.id = tr.source_task_id
           JOIN visible_task_ids target_visible
             ON target_visible.id = tr.target_task_id`,
        )
        .bind(...snapshotTaskScopeParameters(user.id, taskLimit)),
    ]),
    isAdmin && options.includeAdminOverview
      ? getAdminOverview(user, configuredAdminEmails)
      : Promise.resolve(null),
  ]);

  const [
    syncState,
    tasks,
    projects,
    releases,
    views,
    statuses,
    users,
    collaborators,
    labels,
    taskLabels,
    relations,
  ] = snapshotResults;

  const boundedTaskRows = tasks.results.slice(0, taskLimit);
  const boundedTaskIds = new Set(boundedTaskRows.map((row) => String(row.id)));
  const boundedTaskLabels = taskLabels.results.filter((row) =>
    boundedTaskIds.has(String(row.task_id)),
  );
  const boundedLabelIds = new Set(boundedTaskLabels.map((row) => String(row.label_id)));

  return {
    user,
    isAdmin,
    admin,
    users: users.results.map(mapUser),
    statuses: statuses.results.map(mapStatus),
    projects: projects.results.map(mapProject),
    releases: releases.results.map(mapRelease),
    tasks: boundedTaskRows.map(mapTask),
    taskWindow: { limit: taskLimit, truncated: tasks.results.length > taskLimit },
    labels: labels.results
      .filter((row) => String(row.owner_user_id) === user.id || boundedLabelIds.has(String(row.id)))
      .map(mapLabel),
    taskLabels: boundedTaskLabels.map(mapTaskLabel),
    relations: relations.results
      .filter((row) => boundedTaskIds.has(String(row.source_task_id)) && boundedTaskIds.has(String(row.target_task_id)))
      .map(mapRelation),
    views: views.results.map(mapView),
    collaborators: collaborators.results.map(mapCollaborator),
    syncCursor: encodeWorkspaceSyncCursor(
      Number((syncState.results[0] as DbRow | undefined)?.last_sequence ?? 0),
    ),
  };
}

export async function getTaskExternalSource(
  currentUser: UserRecord,
  taskId: string,
): Promise<ExternalSourceRecord | null> {
  await loadAccessibleTask(currentUser.id, taskId);
  const row = await getD1()
    .prepare(
      `SELECT target_type, target_id, source, source_id, source_url, metadata_json
       FROM external_records
       WHERE target_type = 'task' AND target_id = ? AND source = 'linear'
       ORDER BY imported_at DESC
       LIMIT 1`,
    )
    .bind(taskId)
    .first<DbRow>();
  return row ? mapExternalSource(row) : null;
}

export async function getTask(
  currentUser: UserRecord,
  taskId: string,
): Promise<TaskRecord> {
  return loadAccessibleTask(currentUser.id, taskId);
}

export async function getTaskDetail(
  currentUser: UserRecord,
  taskId: string,
): Promise<TaskDetailRecord> {
  const task = await loadAccessibleTask(currentUser.id, taskId);
  const db = getD1();
  const [labelRows, relationRows, childRows] = await db.batch([
    db
      .prepare(
        `SELECT l.* FROM labels l
         JOIN task_labels tl ON tl.label_id = l.id
         WHERE tl.task_id = ?
         ORDER BY l.name, l.id`,
      )
      .bind(task.id),
    db
      .prepare(
        `SELECT source_task_id, target_task_id, type
         FROM task_relations
         WHERE source_task_id = ? OR target_task_id = ?
         ORDER BY created_at, source_task_id, target_task_id, type`,
      )
      .bind(task.id, task.id),
    db
      .prepare(
        `SELECT id FROM tasks
         WHERE parent_task_id = ?
         ORDER BY rank, id`,
      )
      .bind(task.id),
  ]);

  const relationRecords = (relationRows.results as DbRow[]).map(mapRelation);
  const contextIds = new Set<string>();
  if (task.parentTaskId) contextIds.add(task.parentTaskId);
  for (const row of childRows.results as DbRow[]) contextIds.add(String(row.id));
  for (const relation of relationRecords) {
    if (relation.sourceTaskId !== task.id) contextIds.add(relation.sourceTaskId);
    if (relation.targetTaskId !== task.id) contextIds.add(relation.targetTaskId);
  }

  const relatedTasks = (
    await Promise.all(
      [...contextIds].map(async (id) => {
        try {
          return await loadAccessibleTask(currentUser.id, id);
        } catch (error) {
          if (error instanceof NotFoundError) return null;
          throw error;
        }
      }),
    )
  ).filter((item): item is TaskRecord => item !== null);
  const visibleIds = new Set([task.id, ...relatedTasks.map((item) => item.id)]);
  const labels = (labelRows.results as DbRow[]).map(mapLabel);

  return {
    task,
    relatedTasks,
    labels,
    taskLabels: labels.map((label) => ({ taskId: task.id, labelId: label.id })),
    relations: relationRecords.filter(
      (relation) =>
        visibleIds.has(relation.sourceTaskId) &&
        visibleIds.has(relation.targetTaskId),
    ),
  };
}

export async function searchTaskIds(
  currentUser: UserRecord,
  input: string,
): Promise<string[]> {
  return (await searchTaskSummaries(currentUser, input)).map((task) => task.id);
}

export async function searchTaskSummaries(
  currentUser: UserRecord,
  input: string,
): Promise<TaskRecord[]> {
  const query = input.trim().toLowerCase();
  if (!query) return [];
  if (query.length > 200) {
    throw new ValidationError("Task search is limited to 200 characters");
  }
  const rows = await getD1()
    .prepare(
      `WITH scoped AS (
         SELECT ${snapshotTaskProjection},
           EXISTS (
             SELECT 1 FROM external_records er
             WHERE er.target_type = 'task' AND er.target_id = t.id
           ) AS has_external_source,
           CASE
             WHEN t.project_id IS NOT NULL AND p.owner_user_id = ? THEN 'owner'
             WHEN t.project_id IS NOT NULL THEN (
               SELECT CASE ag.permission
                 WHEN 'full_access' THEN 'manager'
                 WHEN 'manager' THEN 'manager'
                 WHEN 'editor' THEN 'editor'
                 WHEN 'viewer' THEN 'viewer'
               END
               FROM access_grants ag
               WHERE ag.resource_type = 'project' AND ag.resource_id = t.project_id
                 AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
               LIMIT 1
             )
             WHEN t.owner_user_id = ? THEN 'owner'
             ELSE (
               SELECT CASE ag.permission
                 WHEN 'full_access' THEN 'editor'
                 WHEN 'editor' THEN 'editor'
                 WHEN 'viewer' THEN 'viewer'
               END
               FROM access_grants ag
               WHERE ag.resource_type = 'task' AND ag.resource_id = t.id
                 AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
               LIMIT 1
             )
           END AS access_role
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         WHERE instr(lower(t.identifier), ?) > 0
            OR instr(lower(t.title), ?) > 0
            OR instr(lower(COALESCE(t.description, '')), ?) > 0
       )
       SELECT * FROM scoped WHERE access_role IS NOT NULL
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .bind(
      currentUser.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      query,
      query,
      query,
      MAX_UI_SNAPSHOT_TASKS,
    )
    .all<DbRow>();
  return rows.results.map(mapTask);
}

export async function getAdminOverview(
  currentUser: UserRecord,
  configuredAdminEmails = adminEmailsFromEnvironment(),
) {
  assertAdmin(currentUser, configuredAdminEmails);
  const rows = await getD1()
    .prepare(
      `SELECT
         u.id, u.display_name, u.email, u.created_at, u.updated_at,
         COALESCE(task_stats.task_count, 0) AS task_count,
         COALESCE(task_stats.recent_task_count, 0) AS recent_task_count,
         task_stats.last_task_activity_at,
         COALESCE(project_stats.project_count, 0) AS project_count,
         project_stats.last_project_activity_at,
         COALESCE(release_stats.release_count, 0) AS release_count,
         release_stats.last_release_activity_at,
         COALESCE(view_stats.view_count, 0) AS view_count,
         view_stats.last_view_activity_at
       FROM users u
       LEFT JOIN (
         SELECT owner_user_id,
                COUNT(*) AS task_count,
                SUM(CASE
                  WHEN datetime(updated_at) >= datetime('now', '-7 days')
                  THEN 1 ELSE 0
                END) AS recent_task_count,
                MAX(updated_at) AS last_task_activity_at
         FROM tasks
         GROUP BY owner_user_id
       ) task_stats ON task_stats.owner_user_id = u.id
       LEFT JOIN (
         SELECT owner_user_id,
                COUNT(*) AS project_count,
                MAX(updated_at) AS last_project_activity_at
         FROM projects
         GROUP BY owner_user_id
       ) project_stats ON project_stats.owner_user_id = u.id
       LEFT JOIN (
         SELECT owner_user_id,
                COUNT(*) AS release_count,
                MAX(updated_at) AS last_release_activity_at
         FROM releases
         GROUP BY owner_user_id
       ) release_stats ON release_stats.owner_user_id = u.id
       LEFT JOIN (
         SELECT owner_user_id,
                COUNT(*) AS view_count,
                MAX(updated_at) AS last_view_activity_at
         FROM saved_views
         GROUP BY owner_user_id
       ) view_stats ON view_stats.owner_user_id = u.id
       ORDER BY datetime(u.updated_at) DESC, datetime(u.created_at) DESC`,
    )
    .all<DbRow>();

  return buildAdminOverview(
    rows.results.map(mapAdminUserAggregate),
    configuredAdminEmails,
  );
}

export async function createTask(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const db = getD1();
  const title = requireTitle(input.title);
  const project = input.projectId
    ? await loadAccessibleProject(currentUser.id, String(input.projectId))
    : null;
  if (project) requireContentEdit(project.accessRole);
  const ownerUserId = project?.ownerUserId ?? currentUser.id;
  const status = await loadStatus(
    ownerUserId,
    input.statusId ? String(input.statusId) : null,
  );
  const release = input.releaseId
    ? await loadAccessibleRelease(currentUser.id, String(input.releaseId))
    : null;
  if (release) requireContentEdit(release.accessRole);
  assertReleaseProject(project?.id ?? null, release?.projectId ?? null);
  const assigneeUserId = Object.hasOwn(input, "assigneeUserId")
    ? requestedAssigneeUserId(input.assigneeUserId)
    : currentUser.id;
  await assertTaskAssigneeAccess(
    assigneeUserId,
    ownerUserId,
    project?.id ?? null,
    null,
  );

  const sequenceRow = await db
    .prepare(
      `INSERT INTO task_sequences (owner_user_id, last_value)
       VALUES (?, (
         SELECT COALESCE(MAX(sequence_number), 0) + 1
         FROM tasks WHERE owner_user_id = ?
       ))
       ON CONFLICT(owner_user_id) DO UPDATE SET last_value = MAX(
         task_sequences.last_value + 1,
         (SELECT COALESCE(MAX(sequence_number), 0) + 1
          FROM tasks WHERE owner_user_id = ?)
       )
       RETURNING last_value`,
    )
    .bind(ownerUserId, ownerUserId, ownerUserId)
    .first<{ last_value: number }>();
  const rankRow = await db
    .prepare(
      "SELECT COALESCE(MAX(rank), 0) + 1000 AS next FROM tasks WHERE owner_user_id = ? AND status_id = ?",
    )
    .bind(ownerUserId, status.id)
    .first<{ next: number }>();
  if (!sequenceRow) throw new Error("Task sequence allocation failed");
  const sequence = sequenceRow.last_value;
  const now = new Date().toISOString();
  const timestamps = statusTimestamps(
    status.category,
    { startedAt: null, completedAt: null, canceledAt: null },
    now,
  );
  const taskId = `task_${crypto.randomUUID()}`;
  const publicId = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO tasks (
        id, public_id, owner_user_id, creator_user_id, identifier, sequence_number,
        title, description, status_id, priority, assignee_user_id,
        project_id, release_id, estimate, due_date, rank,
        started_at, completed_at, canceled_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      taskId,
      publicId,
      ownerUserId,
      currentUser.id,
      `TM-${sequence}`,
      sequence,
      title,
      optionalText(input.description),
      status.id,
      input.priority ? priority(input.priority) : "none",
      assigneeUserId,
      project?.id ?? null,
      release?.id ?? null,
      optionalEstimate(input.estimate),
      optionalDate(input.dueDate),
      rankRow?.next ?? 1000,
      timestamps.startedAt,
      timestamps.completedAt,
      timestamps.canceledAt,
      now,
      now,
    )
    .run();
  return { id: taskId, publicId };
}

export async function updateTask(
  currentUser: UserRecord,
  taskId: string,
  input: Record<string, unknown>,
) {
  const task = await loadAccessibleTask(currentUser.id, taskId);
  requireContentEdit(task.accessRole);
  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== task.version) {
    throw new ConflictError("Task was changed in another session");
  }

  let projectId = task.projectId;
  if (Object.hasOwn(input, "projectId")) {
    const targetProject = input.projectId
      ? await loadAccessibleProject(currentUser.id, String(input.projectId))
      : null;
    if (targetProject) requireContentEdit(targetProject.accessRole);
    if (task.projectId && !targetProject && currentUser.id !== task.ownerUserId) {
      throw new ValidationError(
        "Only the task owner can move project work back to standalone",
      );
    }
    if (task.projectId && targetProject && targetProject.id !== task.projectId) {
      const sourceProject = await loadAccessibleProject(
        currentUser.id,
        task.projectId,
      );
      requireContentEdit(sourceProject.accessRole);
      if (
        sourceProject.ownerUserId !== targetProject?.ownerUserId ||
        task.ownerUserId !== sourceProject.ownerUserId
      ) {
        throw new ValidationError(
          "Moving work across project ownership boundaries is not supported",
        );
      }
    }
    if (targetProject && targetProject.ownerUserId !== task.ownerUserId) {
      throw new ValidationError("Moving work between owners is not supported");
    }
    if (targetProject && task.projectId == null) {
      const grant = await getD1()
        .prepare(
          `SELECT id FROM access_grants
           WHERE resource_type = 'task' AND resource_id = ? AND revoked_at IS NULL
           LIMIT 1`,
        )
        .bind(task.id)
        .first();
      if (grant) {
        throw new ValidationError(
          "Revoke direct task access before adding it to a project",
        );
      }
    }
    projectId = targetProject?.id ?? null;
  }

  let releaseId = task.releaseId;
  if (Object.hasOwn(input, "releaseId")) {
    const release = input.releaseId
      ? await loadAccessibleRelease(currentUser.id, String(input.releaseId))
      : null;
    if (release) requireContentEdit(release.accessRole);
    assertReleaseProject(projectId, release?.projectId ?? null);
    releaseId = release?.id ?? null;
  } else if (task.projectId !== projectId && task.releaseId) {
    releaseId = null;
  }

  const assigneeUserId = Object.hasOwn(input, "assigneeUserId")
    ? requestedAssigneeUserId(input.assigneeUserId)
    : task.assigneeUserId;
  await assertTaskAssigneeAccess(
    assigneeUserId,
    task.ownerUserId,
    projectId,
    task.id,
  );

  const status = Object.hasOwn(input, "statusId")
    ? await loadStatus(task.ownerUserId, String(input.statusId))
    : await loadStatus(task.ownerUserId, task.statusId);
  const now = new Date().toISOString();
  const timestamps = statusTimestamps(status.category, task, now);
  const title = Object.hasOwn(input, "title")
    ? requireTitle(input.title)
    : task.title;
  const description = Object.hasOwn(input, "description")
    ? optionalText(input.description)
    : task.description;
  const nextPriority = Object.hasOwn(input, "priority")
    ? priority(input.priority)
    : task.priority;
  const dueDate = Object.hasOwn(input, "dueDate")
    ? optionalDate(input.dueDate)
    : task.dueDate;
  const estimate = Object.hasOwn(input, "estimate")
    ? optionalEstimate(input.estimate)
    : task.estimate;
  const archivedAt = Object.hasOwn(input, "archived")
    ? input.archived
      ? now
      : null
    : task.archivedAt;
  const rank = Object.hasOwn(input, "rank")
    ? finiteNumber(input.rank, "Rank")
    : task.rank;

  const result = await getD1()
    .prepare(
      `UPDATE tasks SET
        title = ?, description = ?, status_id = ?, priority = ?,
        assignee_user_id = ?, project_id = ?, release_id = ?, estimate = ?, due_date = ?, rank = ?,
        started_at = ?, completed_at = ?, canceled_at = ?, archived_at = ?,
        version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND (
         (tasks.project_id IS NOT NULL AND (
           EXISTS (
             SELECT 1 FROM projects p
             WHERE p.id = tasks.project_id AND p.owner_user_id = ?
           ) OR EXISTS (
             SELECT 1 FROM access_grants ag
             WHERE ag.resource_type = 'project'
               AND ag.resource_id = tasks.project_id
               AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
               AND ag.permission IN ('editor', 'manager', 'full_access')
           )
         )) OR (tasks.project_id IS NULL AND (
           owner_user_id = ? OR EXISTS (
             SELECT 1 FROM access_grants ag
             WHERE ag.resource_type = 'task' AND ag.resource_id = tasks.id
               AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
               AND ag.permission IN ('editor', 'full_access')
           )
         ))
       )`,
    )
    .bind(
      title,
      description,
      status.id,
      nextPriority,
      assigneeUserId,
      projectId,
      releaseId,
      estimate,
      dueDate,
      rank,
      timestamps.startedAt,
      timestamps.completedAt,
      timestamps.canceledAt,
      archivedAt,
      now,
      taskId,
      expectedVersion,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
    )
    .run();
  if ((result.meta.changes ?? 0) < 1) {
    throw new ConflictError("Task was changed in another session");
  }
  return loadAccessibleTask(currentUser.id, taskId);
}

export async function bulkUpdateTasks(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const ids = Array.isArray(input.ids) ? [...new Set(input.ids.map(String))] : [];
  if (ids.length === 0 || ids.length > 100) {
    throw new ValidationError("Select between 1 and 100 tasks");
  }
  const field = input.field;
  if (field !== "statusId" && field !== "priority" && field !== "archived") {
    throw new ValidationError("Unsupported bulk action");
  }
  const tasks = await loadAccessibleTasks(currentUser.id, ids);
  tasks.forEach((task) => requireContentEdit(task.accessRole));
  const now = new Date().toISOString();
  const db = getD1();
  const nextPriority = field === "priority" ? priority(input.value) : null;
  const targetStatus = field === "statusId"
    ? await loadStatus(tasks[0]!.ownerUserId, String(input.value))
    : null;
  if (targetStatus && tasks.some((task) => task.ownerUserId !== targetStatus.ownerUserId)) {
    throw new ValidationError("Bulk status changes require tasks from one workflow owner");
  }
  const statements: D1PreparedStatement[] = [];
  for (const task of tasks) {
    if (field === "priority") {
      statements.push(
        db
          .prepare(
            `UPDATE tasks SET priority = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND ${editableTaskWhere}`,
          )
          .bind(
            nextPriority,
            now,
            task.id,
            task.version,
            currentUser.id,
            currentUser.id,
            currentUser.id,
            currentUser.id,
          ),
      );
    } else if (field === "archived") {
      statements.push(
        db
          .prepare(
            `UPDATE tasks SET archived_at = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND ${editableTaskWhere}`,
          )
          .bind(
            input.value ? now : null,
            now,
            task.id,
            task.version,
            currentUser.id,
            currentUser.id,
            currentUser.id,
            currentUser.id,
          ),
      );
    } else {
      const timestamps = statusTimestamps(targetStatus!.category, task, now);
      statements.push(
        db
          .prepare(
            `UPDATE tasks SET status_id = ?, started_at = ?, completed_at = ?,
              canceled_at = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND ${editableTaskWhere}`,
          )
          .bind(
            targetStatus!.id,
            timestamps.startedAt,
            timestamps.completedAt,
            timestamps.canceledAt,
            now,
            task.id,
            task.version,
            currentUser.id,
            currentUser.id,
            currentUser.id,
            currentUser.id,
          ),
      );
    }
  }
  const results = await db.batch(statements);
  if (results.some((result) => (result.meta.changes ?? 0) < 1)) {
    throw new ConflictError("One or more tasks changed in another session");
  }
  return loadAccessibleTasks(currentUser.id, ids);
}

export async function createProject(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const now = new Date().toISOString();
  await getD1()
    .prepare(
      `INSERT INTO projects
        (id, public_id, owner_user_id, creator_user_id, name, summary, description,
         target_date, lead_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `project_${crypto.randomUUID()}`,
      crypto.randomUUID(),
      currentUser.id,
      currentUser.id,
      requireTitle(input.name),
      optionalText(input.summary, 500),
      optionalText(input.description),
      optionalDate(input.targetDate),
      currentUser.id,
      now,
      now,
    )
    .run();
}

export async function createRelease(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  if (!input.projectId) throw new ValidationError("Project is required");
  const project = await loadAccessibleProject(
    currentUser.id,
    String(input.projectId),
  );
  requireContentEdit(project.accessRole);
  const now = new Date().toISOString();
  await getD1()
    .prepare(
      `INSERT INTO releases
        (id, public_id, project_id, owner_user_id, creator_user_id, name, description,
         status, target_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `release_${crypto.randomUUID()}`,
      crypto.randomUUID(),
      project.id,
      project.ownerUserId,
      currentUser.id,
      requireTitle(input.name),
      optionalText(input.description),
      "planned",
      optionalDate(input.targetDate),
      now,
      now,
    )
    .run();
}

export async function createSavedView(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const query = validateViewQuery(input.query);
  const display = validateViewDisplay(input.display);
  const project = input.scopeProjectId
    ? await loadAccessibleProject(currentUser.id, String(input.scopeProjectId))
    : null;
  if (project) requireContentEdit(project.accessRole);
  await getD1()
    .prepare(
      `INSERT INTO saved_views
        (id, public_id, owner_user_id, name, scope_project_id, query_json, display_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `view_${crypto.randomUUID()}`,
      crypto.randomUUID(),
      project?.ownerUserId ?? currentUser.id,
      requireTitle(input.name),
      project?.id ?? null,
      JSON.stringify(query),
      JSON.stringify(display),
    )
    .run();
}

export async function grantAccess(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const resourceType = shareableResourceType(input.resourceType);
  const resourceId = String(input.resourceId ?? "");
  const target = await loadShareTarget(currentUser.id, resourceType, resourceId);
  const permission = requestedGrantRole(input.permission);
  if (!canAssignRole(target.actorRole, resourceType, permission)) {
    throw new PermissionError("You cannot assign that role");
  }
  const email = String(input.email ?? "").trim().toLowerCase();
  const matches = await getD1()
    .prepare("SELECT id FROM users WHERE lower(email) = ? ORDER BY id LIMIT 2")
    .bind(email)
    .all<{ id: string }>();
  if (matches.results.length === 0) {
    throw new NotFoundError("That user must sign in once before you can share");
  }
  if (matches.results.length > 1) {
    throw new ValidationError("More than one account uses that email");
  }
  const grantee = matches.results[0]!;
  if (grantee.id === target.ownerUserId) {
    throw new ValidationError("The owner already has access");
  }
  const existing = await getD1()
    .prepare(
      `SELECT permission FROM access_grants
       WHERE resource_type = ? AND resource_id = ? AND grantee_user_id = ?
         AND revoked_at IS NULL`,
    )
    .bind(resourceType, resourceId, grantee.id)
    .first<{ permission: string }>();
  const existingRole = existing
    ? normalizeGrantRole(resourceType, existing.permission)
    : null;
  if (
    existingRole &&
    !canManageGrant(target.actorRole, resourceType, existingRole)
  ) {
    throw new PermissionError("You cannot change that participant");
  }
  await getD1()
    .prepare(
      `INSERT INTO access_grants
        (id, resource_type, resource_id, owner_user_id, grantee_user_id,
         granted_by_user_id, permission, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(resource_type, resource_id, grantee_user_id)
       DO UPDATE SET owner_user_id = excluded.owner_user_id,
         permission = excluded.permission, revoked_at = NULL,
         granted_by_user_id = excluded.granted_by_user_id`,
    )
    .bind(
      `grant_${crypto.randomUUID()}`,
      resourceType,
      resourceId,
      target.ownerUserId,
      grantee.id,
      currentUser.id,
      permission,
    )
    .run();
}

export async function revokeAccess(currentUser: UserRecord, grantId: string) {
  const grant = await loadGrantForManagement(currentUser.id, grantId);
  if (!canManageGrant(grant.actorRole, grant.resourceType, grant.permission)) {
    throw new PermissionError("You cannot remove that participant");
  }
  const db = getD1();
  const now = new Date().toISOString();
  const clearAssignee = grant.resourceType === "project"
    ? db
        .prepare(
          `UPDATE tasks SET assignee_user_id = NULL,
             version = version + 1, updated_at = ?
           WHERE project_id = ? AND assignee_user_id = ?`,
        )
        .bind(now, grant.resourceId, grant.granteeUserId)
    : grant.resourceType === "task"
      ? db
          .prepare(
            `UPDATE tasks SET assignee_user_id = NULL,
               version = version + 1, updated_at = ?
             WHERE id = ? AND project_id IS NULL AND assignee_user_id = ?`,
          )
          .bind(now, grant.resourceId, grant.granteeUserId)
      : db.prepare("SELECT 1");
  const results = await db.batch([
    db
      .prepare(
        `UPDATE access_grants SET revoked_at = ?
         WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
      )
      .bind(now, grantId, grant.ownerUserId),
    clearAssignee,
  ]);
  if ((results[0]?.meta.changes ?? 0) < 1) {
    throw new NotFoundError("Grant not found");
  }
}

export async function updateAccessRole(
  currentUser: UserRecord,
  grantId: string,
  input: Record<string, unknown>,
) {
  const grant = await loadGrantForManagement(currentUser.id, grantId);
  const permission = requestedGrantRole(input.permission);
  if (
    !canManageGrant(grant.actorRole, grant.resourceType, grant.permission) ||
    !canAssignRole(grant.actorRole, grant.resourceType, permission)
  ) {
    throw new PermissionError("You cannot change that participant");
  }
  const result = await getD1()
    .prepare(
      `UPDATE access_grants
       SET permission = ?, granted_by_user_id = ?
       WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
    )
    .bind(permission, currentUser.id, grantId, grant.ownerUserId)
    .run();
  if ((result.meta.changes ?? 0) < 1) throw new NotFoundError("Grant not found");
}

export async function transferProjectOwnership(
  currentUser: UserRecord,
  projectId: string,
  targetUserId: string,
) {
  const project = await loadAccessibleProject(currentUser.id, projectId);
  if (!canTransferOwnership(project.accessRole)) {
    throw new PermissionError("Only the project owner can transfer ownership");
  }
  const targetGrant = await getD1()
    .prepare(
      `SELECT id FROM access_grants
       WHERE resource_type = 'project' AND resource_id = ?
         AND grantee_user_id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
    )
    .bind(project.id, targetUserId, currentUser.id)
    .first<{ id: string }>();
  if (!targetGrant) {
    throw new ValidationError("Ownership can only be transferred to a project member");
  }

  const now = new Date().toISOString();
  const db = getD1();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE projects
         SET owner_user_id = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND owner_user_id = ?`,
      )
      .bind(targetUserId, now, project.id, currentUser.id),
    db
      .prepare(
        `UPDATE access_grants SET owner_user_id = ?
         WHERE resource_type = 'project' AND resource_id = ?
           AND owner_user_id = ?`,
      )
      .bind(targetUserId, project.id, currentUser.id),
    db
      .prepare(
        `UPDATE access_grants SET revoked_at = ?
         WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
      )
      .bind(now, targetGrant.id, targetUserId),
    db
      .prepare(
        `INSERT INTO access_grants
          (id, resource_type, resource_id, owner_user_id, grantee_user_id,
           granted_by_user_id, permission, revoked_at, created_at)
         SELECT ?, 'project', ?, ?, ?, ?, 'manager', NULL, ?
         FROM projects WHERE id = ? AND owner_user_id = ?
         ON CONFLICT(resource_type, resource_id, grantee_user_id)
         DO UPDATE SET owner_user_id = excluded.owner_user_id,
           permission = 'manager', revoked_at = NULL,
           granted_by_user_id = excluded.granted_by_user_id`,
      )
      .bind(
        `grant_${crypto.randomUUID()}`,
        project.id,
        targetUserId,
        currentUser.id,
        currentUser.id,
        now,
        project.id,
        targetUserId,
      ),
  ]);
  if ((results[0]?.meta.changes ?? 0) < 1) {
    throw new ConflictError("Project ownership changed in another session");
  }
}

async function loadAccessibleTasks(userId: string, taskIds: string[]) {
  if (!taskIds.length) return [];
  const placeholders = taskIds.map(() => "?").join(", ");
  const rows = await getD1()
    .prepare(
      `WITH scoped AS (
         SELECT t.*,
           EXISTS (
             SELECT 1 FROM external_records er
             WHERE er.target_type = 'task' AND er.target_id = t.id
           ) AS has_external_source,
           CASE
             WHEN t.project_id IS NOT NULL AND p.owner_user_id = ? THEN 'owner'
             WHEN t.project_id IS NOT NULL THEN (
               SELECT CASE ag.permission
                 WHEN 'full_access' THEN 'manager'
                 WHEN 'manager' THEN 'manager'
                 WHEN 'editor' THEN 'editor'
                 WHEN 'viewer' THEN 'viewer'
               END
               FROM access_grants ag
               WHERE ag.resource_type = 'project' AND ag.resource_id = t.project_id
                 AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL LIMIT 1
             )
             WHEN t.owner_user_id = ? THEN 'owner'
             ELSE (
               SELECT CASE ag.permission
                 WHEN 'full_access' THEN 'editor'
                 WHEN 'editor' THEN 'editor'
                 WHEN 'viewer' THEN 'viewer'
               END
               FROM access_grants ag
               WHERE ag.resource_type = 'task' AND ag.resource_id = t.id
                 AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL LIMIT 1
             )
           END AS access_role
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.id IN (${placeholders}) OR t.public_id IN (${placeholders})
       ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    )
    .bind(userId, userId, userId, userId, ...taskIds, ...taskIds)
    .all<DbRow>();
  if (rows.results.length !== taskIds.length) {
    throw new NotFoundError("One or more tasks were not found");
  }
  const taskByAddress = new Map<string, TaskRecord>();
  for (const row of rows.results) {
    const task = mapTask(row);
    taskByAddress.set(task.id, task);
    taskByAddress.set(task.publicId, task);
  }
  return taskIds.map((taskId) => taskByAddress.get(taskId)!);
}

async function loadAccessibleTask(userId: string, taskId: string) {
  const [task] = await loadAccessibleTasks(userId, [taskId]);
  return task!;
}

async function loadAccessibleProject(userId: string, projectId: string) {
  const row = await getD1()
    .prepare(
      `WITH scoped AS (
         SELECT p.*,
           CASE WHEN p.owner_user_id = ? THEN 'owner' ELSE (
             SELECT CASE ag.permission
               WHEN 'full_access' THEN 'manager'
               WHEN 'manager' THEN 'manager'
               WHEN 'editor' THEN 'editor'
               WHEN 'viewer' THEN 'viewer'
             END
             FROM access_grants ag
             WHERE ag.resource_type = 'project' AND ag.resource_id = p.id
               AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL LIMIT 1
           ) END AS access_role
         FROM projects p WHERE p.id = ?
       ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    )
    .bind(userId, userId, projectId)
    .first<DbRow>();
  if (!row) throw new NotFoundError("Project not found");
  return mapProject(row);
}

async function loadAccessibleRelease(userId: string, releaseId: string) {
  const row = await getD1()
    .prepare(
      `WITH scoped AS (
         SELECT r.*,
           CASE WHEN p.owner_user_id = ? THEN 'owner' ELSE (
             SELECT CASE ag.permission
               WHEN 'full_access' THEN 'manager'
               WHEN 'manager' THEN 'manager'
               WHEN 'editor' THEN 'editor'
               WHEN 'viewer' THEN 'viewer'
             END
             FROM access_grants ag
             WHERE ag.resource_type = 'project' AND ag.resource_id = r.project_id
               AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL LIMIT 1
           ) END AS access_role
         FROM releases r JOIN projects p ON p.id = r.project_id
         WHERE r.id = ?
       ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    )
    .bind(userId, userId, releaseId)
    .first<DbRow>();
  if (!row) throw new NotFoundError("Release not found");
  return mapRelease(row);
}

async function loadAccessibleView(userId: string, viewId: string) {
  const row = await getD1()
    .prepare(
      `WITH scoped AS (
         SELECT v.*,
           CASE
             WHEN v.scope_project_id IS NOT NULL AND p.owner_user_id = ? THEN 'owner'
             WHEN v.scope_project_id IS NOT NULL THEN (
               SELECT CASE ag.permission
                 WHEN 'full_access' THEN 'manager'
                 WHEN 'manager' THEN 'manager'
                 WHEN 'editor' THEN 'editor'
                 WHEN 'viewer' THEN 'viewer'
               END
               FROM access_grants ag
               WHERE ag.resource_type = 'project'
                 AND ag.resource_id = v.scope_project_id
                 AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL LIMIT 1
             )
             WHEN v.owner_user_id = ? THEN 'owner'
             ELSE (
               SELECT CASE ag.permission
                 WHEN 'full_access' THEN 'editor'
                 WHEN 'editor' THEN 'editor'
                 WHEN 'viewer' THEN 'viewer'
               END
               FROM access_grants ag
               WHERE ag.resource_type = 'saved_view' AND ag.resource_id = v.id
                 AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL LIMIT 1
             )
           END AS access_role
         FROM saved_views v LEFT JOIN projects p ON p.id = v.scope_project_id
         WHERE v.id = ?
       ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    )
    .bind(userId, userId, userId, userId, viewId)
    .first<DbRow>();
  if (!row) throw new NotFoundError("View not found");
  return mapView(row);
}

function requireContentEdit(role: AccessRole) {
  if (!canEditContent(role)) {
    throw new PermissionError("Editor access is required");
  }
}

async function loadStatus(ownerUserId: string, statusId: string | null) {
  const row = statusId
    ? await getD1()
        .prepare(
          `SELECT * FROM workflow_statuses
           WHERE id = ? AND owner_user_id = ?`,
        )
        .bind(statusId, ownerUserId)
        .first<DbRow>()
    : await getD1()
        .prepare(
          `SELECT * FROM workflow_statuses
           WHERE owner_user_id = ?
           ORDER BY is_default DESC, position ASC LIMIT 1`,
        )
        .bind(ownerUserId)
        .first<DbRow>();
  if (!row) throw new ValidationError("Status is not available for this task");
  return mapStatus(row);
}

function requestedAssigneeUserId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 200) {
    throw new ValidationError("Assignee is invalid");
  }
  return value;
}

async function assertTaskAssigneeAccess(
  assigneeUserId: string | null,
  ownerUserId: string,
  projectId: string | null,
  taskId: string | null,
) {
  if (assigneeUserId === null) return;

  let row: DbRow | null;
  if (projectId) {
    row = await getD1()
      .prepare(
        `SELECT u.id FROM users u
         JOIN projects p ON p.id = ?
         WHERE u.id = ? AND (
           p.owner_user_id = u.id OR EXISTS (
             SELECT 1 FROM access_grants ag
             WHERE ag.resource_type = 'project'
               AND ag.resource_id = p.id
               AND ag.grantee_user_id = u.id
               AND ag.revoked_at IS NULL
           )
         )`,
      )
      .bind(projectId, assigneeUserId)
      .first<DbRow>();
  } else if (assigneeUserId === ownerUserId) {
    row = { id: assigneeUserId };
  } else if (taskId) {
    row = await getD1()
      .prepare(
        `SELECT u.id FROM users u
         WHERE u.id = ? AND EXISTS (
           SELECT 1 FROM access_grants ag
           WHERE ag.resource_type = 'task'
             AND ag.resource_id = ?
             AND ag.grantee_user_id = u.id
             AND ag.revoked_at IS NULL
         )`,
      )
      .bind(assigneeUserId, taskId)
      .first<DbRow>();
  } else {
    row = null;
  }

  if (!row) {
    throw new ValidationError("Assignee must have access to the task");
  }
}

function shareableResourceType(value: unknown): ShareableResourceType {
  if (value === "project" || value === "task" || value === "saved_view") {
    return value;
  }
  throw new ValidationError("Unsupported share target");
}

function requestedGrantRole(value: unknown): GrantRole {
  if (value === "manager" || value === "editor" || value === "viewer") {
    return value;
  }
  throw new ValidationError("Choose a valid access role");
}

async function loadShareTarget(
  userId: string,
  resourceType: ShareableResourceType,
  resourceId: string,
) {
  if (resourceType === "project") {
    const project = await loadAccessibleProject(userId, resourceId);
    return {
      ownerUserId: project.ownerUserId,
      actorRole: project.accessRole,
    };
  }
  if (resourceType === "task") {
    const task = await loadAccessibleTask(userId, resourceId);
    if (task.projectId) {
      throw new ValidationError("Manage access on the project instead");
    }
    return { ownerUserId: task.ownerUserId, actorRole: task.accessRole };
  }
  const view = await loadAccessibleView(userId, resourceId);
  if (view.scopeProjectId) {
    throw new ValidationError("Manage access on the project instead");
  }
  return { ownerUserId: view.ownerUserId, actorRole: view.accessRole };
}

async function loadGrantForManagement(userId: string, grantId: string) {
  const row = await getD1()
    .prepare(
      `SELECT resource_type, resource_id, owner_user_id, grantee_user_id, permission
       FROM access_grants WHERE id = ? AND revoked_at IS NULL`,
    )
    .bind(grantId)
    .first<{
      resource_type: string;
      resource_id: string;
      owner_user_id: string;
      grantee_user_id: string;
      permission: string;
    }>();
  if (!row) throw new NotFoundError("Grant not found");
  const resourceType = shareableResourceType(row.resource_type);
  const permission = normalizeGrantRole(resourceType, row.permission);
  if (!permission) throw new PermissionError("Grant role is invalid");
  const target = await loadShareTarget(userId, resourceType, row.resource_id);
  return {
    resourceType,
    resourceId: row.resource_id,
    ownerUserId: target.ownerUserId,
    granteeUserId: row.grantee_user_id,
    actorRole: target.actorRole,
    permission,
  };
}

function finiteNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ValidationError(`${label} is invalid`);
  return number;
}

function mapUser(row: DbRow): UserRecord {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    email: String(row.email),
    timezone: String(row.timezone),
  };
}

function mapAdminUserAggregate(row: DbRow): AdminUserAggregate {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    email: String(row.email),
    registeredAt: String(row.created_at),
    lastSeenAt: String(row.updated_at),
    taskCount: Number(row.task_count ?? 0),
    recentTaskCount: Number(row.recent_task_count ?? 0),
    projectCount: Number(row.project_count ?? 0),
    releaseCount: Number(row.release_count ?? 0),
    viewCount: Number(row.view_count ?? 0),
    lastTaskActivityAt: nullableString(row.last_task_activity_at),
    lastProjectActivityAt: nullableString(row.last_project_activity_at),
    lastReleaseActivityAt: nullableString(row.last_release_activity_at),
    lastViewActivityAt: nullableString(row.last_view_activity_at),
  };
}

function adminEmailsFromEnvironment(): string {
  return getRuntimeEnvironment().TASK_MANAGER_ADMIN_EMAILS ?? "";
}

function snapshotTaskScopeParameters(userId: string, taskLimit: number) {
  return [userId, userId, userId, userId, taskLimit + 1];
}

function mapStatus(row: DbRow): WorkflowStatusRecord {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    category: String(row.category) as StatusCategory,
    color: String(row.color),
    position: Number(row.position),
    isDefault: Boolean(row.is_default),
  };
}

function mapProject(row: DbRow): ProjectRecord {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    ownerUserId: String(row.owner_user_id),
    creatorUserId: String(row.creator_user_id),
    name: String(row.name),
    summary: String(row.summary ?? ""),
    description: String(row.description ?? ""),
    status: String(row.status),
    leadUserId: nullableString(row.lead_user_id),
    startDate: nullableString(row.start_date),
    targetDate: nullableString(row.target_date),
    color: String(row.color),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    accessRole: effectiveRole(row.access_role),
  };
}

function mapRelease(row: DbRow): ReleaseRecord {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    projectId: String(row.project_id),
    ownerUserId: String(row.owner_user_id),
    creatorUserId: String(row.creator_user_id),
    name: String(row.name),
    description: String(row.description ?? ""),
    status: String(row.status) as ReleaseRecord["status"],
    targetDate: nullableString(row.target_date),
    releasedAt: nullableString(row.released_at),
    releaseNotes: String(row.release_notes ?? ""),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    accessRole: effectiveRole(row.access_role),
  };
}

function mapTask(row: DbRow): TaskRecord {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    ownerUserId: String(row.owner_user_id),
    creatorUserId: String(row.creator_user_id),
    identifier: String(row.identifier),
    sequenceNumber: Number(row.sequence_number),
    title: String(row.title),
    description: row.description == null ? null : String(row.description),
    statusId: String(row.status_id),
    priority: String(row.priority) as Priority,
    assigneeUserId: nullableString(row.assignee_user_id),
    projectId: nullableString(row.project_id),
    releaseId: nullableString(row.release_id),
    estimate: row.estimate == null ? null : Number(row.estimate),
    dueDate: nullableString(row.due_date),
    parentTaskId: nullableString(row.parent_task_id),
    rank: Number(row.rank),
    startedAt: nullableString(row.started_at),
    completedAt: nullableString(row.completed_at),
    canceledAt: nullableString(row.canceled_at),
    archivedAt: nullableString(row.archived_at),
    commentCount: Number(row.comment_count ?? 0),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    accessRole: effectiveRole(row.access_role),
    hasExternalSource: Number(row.has_external_source ?? 0) === 1,
  };
}

function mapLabel(row: DbRow): LabelRecord {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    color: String(row.color),
  };
}

function mapTaskLabel(row: DbRow): TaskLabelAssignment {
  return {
    taskId: String(row.task_id),
    labelId: String(row.label_id),
  };
}

function mapRelation(row: DbRow): TaskRelationRecord {
  return {
    sourceTaskId: String(row.source_task_id),
    targetTaskId: String(row.target_task_id),
    type: String(row.type) as TaskRelationRecord["type"],
  };
}

function mapExternalSource(row: DbRow): ExternalSourceRecord {
  const metadata = safeJson<Record<string, unknown>>(row.metadata_json, {});
  const attachments = Array.isArray(metadata.attachments)
    ? metadata.attachments
        .map((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return null;
          }
          const attachment = value as Record<string, unknown>;
          if (
            typeof attachment.title !== "string" ||
            typeof attachment.url !== "string"
          ) {
            return null;
          }
          return {
            title: attachment.title,
            subtitle:
              typeof attachment.subtitle === "string"
                ? attachment.subtitle
                : null,
            url: attachment.url,
          };
        })
        .filter(
          (
            value,
          ): value is ExternalSourceRecord["attachments"][number] =>
            value !== null,
        )
    : [];
  const comments = Array.isArray(metadata.comments)
    ? metadata.comments
        .map((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return null;
          }
          const comment = value as Record<string, unknown>;
          const author =
            comment.author &&
            typeof comment.author === "object" &&
            !Array.isArray(comment.author)
              ? (comment.author as Record<string, unknown>)
              : {};
          if (
            typeof comment.id !== "string" ||
            typeof comment.body !== "string" ||
            typeof comment.createdAt !== "string" ||
            typeof comment.updatedAt !== "string"
          ) {
            return null;
          }
          return {
            id: comment.id,
            body: comment.body,
            authorName:
              typeof author.name === "string" ? author.name : "Linear user",
            createdAt: comment.createdAt,
            updatedAt: comment.updatedAt,
            parentId:
              typeof comment.parentId === "string" ? comment.parentId : null,
            quotedText:
              typeof comment.quotedText === "string"
                ? comment.quotedText
                : null,
          };
        })
        .filter(
          (
            value,
          ): value is ExternalSourceRecord["comments"][number] => value !== null,
        )
    : [];
  return {
    targetType: String(
      row.target_type,
    ) as ExternalSourceRecord["targetType"],
    targetId: String(row.target_id),
    source: "linear",
    sourceId: String(row.source_id),
    sourceUrl: nullableString(row.source_url),
    gitBranchName:
      typeof metadata.gitBranchName === "string"
        ? metadata.gitBranchName
        : null,
    attachments,
    stateHistoryEntries: Array.isArray(metadata.stateHistory)
      ? metadata.stateHistory.length
      : 0,
    commentEntries: comments.length,
    comments,
  };
}

function mapView(row: DbRow): SavedViewRecord {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    scopeProjectId: nullableString(row.scope_project_id),
    query: parseStoredViewQuery(row.query_json),
    display: parseStoredViewDisplay(row.display_json),
    version: Number(row.version),
    accessRole: effectiveRole(row.access_role),
  };
}

function mapCollaborator(row: DbRow): CollaboratorRecord {
  return {
    grantId: String(row.id),
    resourceType: String(row.resource_type) as CollaboratorRecord["resourceType"],
    resourceId: String(row.resource_id),
    userId: String(row.user_id),
    displayName: String(row.display_name),
    email: String(row.email),
    permission:
      normalizeGrantRole(
        String(row.resource_type) as ShareableResourceType,
        row.permission,
      ) ?? "viewer",
  };
}

function effectiveRole(value: unknown): AccessRole {
  if (
    value === "owner" ||
    value === "manager" ||
    value === "editor" ||
    value === "viewer"
  ) {
    return value;
  }
  return "viewer";
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
