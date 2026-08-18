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
import { scanAttachmentStorageOwnership } from "./attachment-storage-audit";
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
  ProjectStatus,
  ReleaseRecord,
  ReleaseStatus,
  SavedViewRecord,
  StatusCategory,
  TaskLabelAssignment,
  TaskDetailRecord,
  TaskRelationRecord,
  TaskRecord,
  UserRecord,
  ViewFilterCondition,
  ViewQuery,
  WorkflowStatusRecord,
} from "./types";
import {
  parseStoredViewDisplay,
  parseStoredViewQuery,
  validateViewDisplay,
  validateViewQuery,
} from "./view-contract";
import {
  canonicalViewQuery,
  queryExplicitlyFiltersArchived,
  taskFilterSql,
} from "./task-filter";
import { getD1 } from "@/db";
import { getRuntimeEnvironment } from "./runtime-environment";
import { encodeWorkspaceSyncCursor } from "./workspace-sync-cursor";
import {
  taskDescriptionAttachmentPredicate,
  validateTaskDescriptionAttachments,
} from "./task-description-attachments";
import {
  activityBatchAssertion,
  activityEventStatement,
  changedFields,
  newActivityId,
} from "./activity-write";

type DbRow = Record<string, unknown>;

export const MAX_UI_SNAPSHOT_TASKS = 2_000;
export const INITIAL_UI_SNAPSHOT_TASKS = 40;

const defaultStatuses: Array<[
  string,
  StatusCategory,
  string,
  number,
  number,
  "duplicate" | null,
]> = [
  ["Backlog", "backlog", "#6b7280", 0, 0, null],
  ["Todo", "unstarted", "#94a3b8", 1, 1, null],
  ["In Progress", "started", "#f59e0b", 2, 0, null],
  ["Done", "completed", "#22c55e", 3, 0, null],
  ["Canceled", "canceled", "#ef4444", 4, 0, null],
  ["Duplicate", "canceled", "#9ca3af", 5, 0, "duplicate"],
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
    ...defaultStatuses.map(([name, category, color, position, isDefault, systemRole]) =>
      db
        .prepare(
          `INSERT INTO workflow_statuses
            (id, owner_user_id, name, category, color, position, is_default, system_role)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `status:${userId}:${systemRole ?? category}`,
          userId,
          name,
          category,
          color,
          position,
          isDefault,
          systemRole,
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
             FROM projects p
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
           SELECT tr.id, tr.source_task_id, tr.target_task_id, tr.type,
             tr.version, tr.created_at, tr.updated_at
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

export type WorkspaceSyncProjectionInput = {
  taskIds: readonly string[];
  projectIds: readonly string[];
  releaseIds: readonly string[];
  viewIds: readonly string[];
  invalidatedTaskIds: readonly string[];
};

export type WorkspaceSyncProjection = {
  tasks: TaskRecord[];
  projects: ProjectRecord[];
  releases: ReleaseRecord[];
  views: SavedViewRecord[];
  labels: LabelRecord[];
  taskLabels: TaskLabelAssignment[];
  labelContextTaskIds: string[];
  accessibleTaskIds: string[];
};

/**
 * Reprojects only IDs named by one incremental journal page. Missing rows are
 * intentional remove candidates; every returned row has been rechecked against
 * the current principal instead of the bounded UI bootstrap window.
 */
export async function getWorkspaceSyncProjection(
  user: UserRecord,
  input: WorkspaceSyncProjectionInput,
): Promise<WorkspaceSyncProjection> {
  const db = getD1();
  const allTaskIds = [...new Set([...input.taskIds, ...input.invalidatedTaskIds])];
  const taskPlaceholders = sqlPlaceholders(allTaskIds);
  const projectPlaceholders = sqlPlaceholders(input.projectIds);
  const releasePlaceholders = sqlPlaceholders(input.releaseIds);
  const viewPlaceholders = sqlPlaceholders(input.viewIds);
  const [tasks, projects, releases, views] = await db.batch<DbRow>([
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
           WHERE t.id IN (${taskPlaceholders})
         )
         SELECT * FROM scoped WHERE access_role IS NOT NULL`,
      )
      .bind(user.id, user.id, user.id, user.id, ...allTaskIds),
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
           FROM projects p
           WHERE p.id IN (${projectPlaceholders})
         )
         SELECT * FROM scoped WHERE access_role IS NOT NULL`,
      )
      .bind(user.id, user.id, ...input.projectIds),
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
           WHERE r.id IN (${releasePlaceholders})
         )
         SELECT * FROM scoped WHERE access_role IS NOT NULL`,
      )
      .bind(user.id, user.id, ...input.releaseIds),
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
           WHERE v.id IN (${viewPlaceholders})
         )
         SELECT * FROM scoped WHERE access_role IS NOT NULL`,
      )
      .bind(user.id, user.id, user.id, user.id, ...input.viewIds),
  ]);

  const taskRecords = tasks.results.map(mapTask);
  const requestedTasks = new Set(input.taskIds);
  const invalidatedTasks = new Set(input.invalidatedTaskIds);
  const accessibleInvalidatedTaskIds = taskRecords
    .filter((task) => invalidatedTasks.has(task.id))
    .map((task) => task.id);
  const labelContext = accessibleInvalidatedTaskIds.length
    ? await db.prepare(
      `SELECT tl.task_id, tl.label_id,
         l.owner_user_id, l.name, l.color, l.description, l.archived_at,
         l.version, l.created_at, l.updated_at
       FROM task_labels tl JOIN labels l ON l.id = tl.label_id
       WHERE tl.task_id IN (${sqlPlaceholders(accessibleInvalidatedTaskIds)})
       ORDER BY tl.task_id, lower(l.name), l.id`,
    ).bind(...accessibleInvalidatedTaskIds).all<DbRow>()
    : { results: [] as DbRow[] };
  return {
    tasks: taskRecords.filter((task) => requestedTasks.has(task.id)),
    projects: projects.results.map(mapProject),
    releases: releases.results.map(mapRelease),
    views: views.results.map(mapView),
    labels: [...new Map(labelContext.results.map((row) => [
      String(row.label_id),
      mapLabel({ ...row, id: row.label_id }),
    ])).values()],
    taskLabels: labelContext.results.map(mapTaskLabel),
    labelContextTaskIds: accessibleInvalidatedTaskIds,
    accessibleTaskIds: taskRecords.map((task) => task.id),
  };
}

function sqlPlaceholders(values: readonly string[]): string {
  return values.length ? values.map(() => "?").join(", ") : "NULL";
}

export async function getTaskExternalSource(
  currentUser: UserRecord,
  taskId: string,
): Promise<ExternalSourceRecord | null> {
  await loadAccessibleTask(currentUser.id, taskId);
  const row = await getD1()
    .prepare(
      `SELECT er.target_type, er.target_id, er.source, er.source_id,
              er.source_url, er.metadata_json,
              (SELECT COUNT(*) FROM comment_migration_outcomes outcome
               WHERE outcome.source_record_id = er.id AND outcome.outcome = 'migrated') AS comments_migrated,
              (SELECT COUNT(*) FROM comment_migration_outcomes outcome
               WHERE outcome.source_record_id = er.id AND outcome.outcome = 'exception') AS comment_exceptions
              ,(SELECT COUNT(*) FROM activity_migration_outcomes outcome
               WHERE outcome.source_record_id = er.id AND outcome.outcome = 'migrated') AS activity_migrated
              ,(SELECT COUNT(*) FROM activity_migration_outcomes outcome
               WHERE outcome.source_record_id = er.id AND outcome.outcome = 'exception') AS activity_exceptions
       FROM external_records er
       WHERE er.target_type = 'task' AND er.target_id = ? AND er.source = 'linear'
       ORDER BY er.imported_at DESC
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
        `SELECT id, source_task_id, target_task_id, type, version,
           created_at, updated_at
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

  const relatedTasks = contextIds.size
    ? (await getWorkspaceSyncProjection(currentUser, {
        taskIds: [...contextIds],
        projectIds: [],
        releaseIds: [],
        viewIds: [],
        invalidatedTaskIds: [],
      })).tasks
    : [];
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
            OR EXISTS (
              SELECT 1 FROM task_identifier_aliases alias
              WHERE alias.task_id = t.id
                AND instr(lower(alias.identifier), ?) > 0
            )
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
      query,
      MAX_UI_SNAPSHOT_TASKS,
    )
    .all<DbRow>();
  return rows.results.map(mapTask);
}

export type TaskQueryInput = {
  query?: ViewQuery;
  surface?: string;
  scopeProjectId?: string | null;
  limit?: number;
  after?: { updatedAt: string; id: string } | null;
};

export async function queryTaskSummaries(
  currentUser: UserRecord,
  input: TaskQueryInput,
) {
  const query = validateViewQuery(input.query);
  const surface = typeof input.surface === "string" && input.surface.length <= 240
    ? input.surface
    : "all";
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1)) {
    throw new ValidationError("Task query limit must be a positive integer");
  }
  const limit = Math.min(Number(input.limit ?? 500), MAX_UI_SNAPSHOT_TASKS);
  if (input.after !== undefined && input.after !== null && (
    typeof input.after !== "object" ||
    typeof input.after.updatedAt !== "string" ||
    !input.after.updatedAt ||
    typeof input.after.id !== "string" ||
    !input.after.id
  )) {
    throw new ValidationError("Task query cursor is invalid");
  }
  const after = input.after ?? null;
  const scopeProject = input.scopeProjectId
    ? await loadAccessibleProject(currentUser.id, String(input.scopeProjectId))
    : null;
  await validateTaskFilterReferences(currentUser, query, scopeProject);

  const builtInSurfaces = new Set(["all", "active", "backlog", "archived", "shared"]);
  if (surface.startsWith("view:")) {
    const view = await loadAccessibleView(currentUser.id, surface.slice(5));
    if (view.archivedAt) throw new NotFoundError("Saved View not found");
  } else if (
    !builtInSurfaces.has(surface) &&
    !surface.startsWith("project:") &&
    !surface.startsWith("release:")
  ) {
    throw new ValidationError("Task query surface is invalid");
  }

  const compiled = taskFilterSql(query, {
    alias: "v",
    timezone: currentUser.timezone,
  });
  const predicates = [compiled.sql];
  const parameters: unknown[] = [
    currentUser.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
    ...compiled.parameters,
  ];

  if (scopeProject) {
    predicates.push("v.project_id = ?");
    parameters.push(scopeProject.id);
  }
  if (surface === "shared") {
    predicates.push("v.access_role <> 'owner'");
  } else if (surface.startsWith("project:")) {
    const project = await loadAccessibleProject(currentUser.id, surface.slice(8));
    predicates.push("v.project_id = ?");
    parameters.push(project.id);
  } else if (surface.startsWith("release:")) {
    const release = await loadAccessibleRelease(currentUser.id, surface.slice(8));
    predicates.push("v.release_id = ?");
    parameters.push(release.id);
  } else if (surface === "active") {
    predicates.push("v.status_category IN ('unstarted', 'started')");
  } else if (surface === "backlog") {
    predicates.push("v.status_category = 'backlog'");
  }

  if (surface === "archived") {
    predicates.push("v.archived_at IS NOT NULL");
  } else if (!queryExplicitlyFiltersArchived(query)) {
    predicates.push("v.archived_at IS NULL");
  }
  if (after) {
    predicates.push("(v.updated_at < ? OR (v.updated_at = ? AND v.id < ?))");
    parameters.push(after.updatedAt, after.updatedAt, after.id);
  }
  parameters.push(limit + 1);

  const rows = await getD1().prepare(
    `WITH scoped AS (
       SELECT t.*, s.category AS status_category,
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
       FROM tasks t
       JOIN workflow_statuses s ON s.id = t.status_id
       LEFT JOIN projects p ON p.id = t.project_id
     ), visible_tasks AS (
       SELECT * FROM scoped WHERE access_role IS NOT NULL
     )
     SELECT
       v.id, v.public_id, v.owner_user_id, v.creator_user_id,
       v.identifier, v.sequence_number, v.title, NULL AS description,
       v.status_id, v.priority, v.assignee_user_id, v.project_id, v.release_id,
       v.estimate, v.due_date, v.parent_task_id, v.rank,
       v.started_at, v.completed_at, v.canceled_at, v.archived_at,
       v.comment_count, v.version, v.created_at, v.updated_at,
       v.has_external_source, v.access_role
     FROM visible_tasks v
     WHERE ${predicates.join(" AND ")}
     ORDER BY v.updated_at DESC, v.id DESC
     LIMIT ?`,
  ).bind(...parameters).all<DbRow>();

  const visible = rows.results.slice(0, limit);
  const last = visible.at(-1);
  return {
    taskIds: visible.map((row) => String(row.id)),
    tasks: visible.map(mapTask),
    page: {
      hasMore: rows.results.length > limit,
      next: rows.results.length > limit && last
        ? { updatedAt: String(last.updated_at), id: String(last.id) }
        : null,
    },
    referenceTime: new Date().toISOString(),
  };
}

export async function getAdminOverview(
  currentUser: UserRecord,
  configuredAdminEmails = adminEmailsFromEnvironment(),
) {
  assertAdmin(currentUser, configuredAdminEmails);
  const db = getD1();
  const [rows, storage] = await Promise.all([
    db
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
         view_stats.last_view_activity_at,
         COALESCE(attachment_stats.attachment_count, 0) AS attachment_count,
         COALESCE(attachment_stats.attachment_bytes, 0) AS attachment_bytes,
         COALESCE(attachment_stats.pending_attachment_count, 0) AS pending_attachment_count,
         COALESCE(attachment_stats.failed_attachment_count, 0) AS failed_attachment_count,
         COALESCE(attachment_stats.deleted_attachment_count, 0) AS deleted_attachment_count
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
       LEFT JOIN (
         SELECT COALESCE(p.owner_user_id, t.owner_user_id) AS owner_user_id,
                COUNT(*) AS attachment_count,
                COALESCE(SUM(a.byte_size), 0) AS attachment_bytes,
                SUM(CASE WHEN a.state IN ('pending', 'uploading') THEN 1 ELSE 0 END)
                  AS pending_attachment_count,
                SUM(CASE WHEN a.state = 'failed' THEN 1 ELSE 0 END)
                  AS failed_attachment_count,
                SUM(CASE WHEN a.state = 'deleted' THEN 1 ELSE 0 END)
                  AS deleted_attachment_count
         FROM attachments a JOIN tasks t ON t.id = a.task_id
         LEFT JOIN projects p ON p.id = t.project_id
         GROUP BY COALESCE(p.owner_user_id, t.owner_user_id)
       ) attachment_stats ON attachment_stats.owner_user_id = u.id
       ORDER BY datetime(u.updated_at) DESC, datetime(u.created_at) DESC`,
    )
    .all<DbRow>(),
    scanAttachmentStorageOwnership(db),
  ]);

  return buildAdminOverview(
    rows.results.map(mapAdminUserAggregate),
    configuredAdminEmails,
    Date.now(),
    storage,
  );
}

export async function createTask(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const db = getD1();
  const title = requireTitle(input.title);
  const description = optionalText(input.description);
  await validateTaskDescriptionAttachments(null, description);
  if (!input.projectId) throw new ValidationError("Project is required");
  const project = await loadAccessibleProject(
    currentUser.id,
    String(input.projectId),
  );
  requireContentEdit(project.accessRole);
  if (project.status === "canceled") {
    throw new ValidationError("Tasks cannot be created in a canceled project");
  }
  const ownerUserId = project.ownerUserId;
  const status = await loadStatus(
    ownerUserId,
    input.statusId ? String(input.statusId) : null,
  );
  const release = input.releaseId
    ? await loadAccessibleRelease(currentUser.id, String(input.releaseId))
    : null;
  if (release) requireContentEdit(release.accessRole);
  assertReleaseProject(project.id, release?.projectId ?? null);
  assertReleasedCompositionChange(null, release, input);
  const assigneeUserId = Object.hasOwn(input, "assigneeUserId")
    ? requestedAssigneeUserId(input.assigneeUserId)
    : currentUser.id;
  await assertTaskAssigneeAccess(
    assigneeUserId,
    ownerUserId,
    project.id,
    null,
  );
  const labelIds = await validateActiveLabelIds(ownerUserId, input.labelIds);

  const sequenceRow = await db
    .prepare(
      `UPDATE projects SET
         task_sequence = MAX(
           task_sequence + 1,
           (SELECT COALESCE(MAX(sequence_number), 0) + 1
            FROM tasks WHERE project_id = projects.id)
         ),
         code_locked_at = COALESCE(code_locked_at, ?)
       WHERE id = ? AND archived_at IS NULL AND (
         owner_user_id = ? OR EXISTS (
           SELECT 1 FROM access_grants ag
           WHERE ag.resource_type = 'project' AND ag.resource_id = projects.id
             AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
             AND ag.permission IN ('editor', 'manager', 'full_access')
         )
       )
       RETURNING task_sequence AS last_value, task_code`,
    )
    .bind(new Date().toISOString(), project.id, currentUser.id, currentUser.id)
    .first<{ last_value: number; task_code: string }>();
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
  const activity = activityEventStatement(db, currentUser, {
    taskId,
    eventType: "task_created",
    payload: {
      identifier: `${sequenceRow.task_code}-${sequence}`,
      project: { id: project.id, name: project.name },
      status: { id: status.id, name: status.name },
    },
    createdAt: now,
  });

  await db.batch([
    db.prepare(
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
      `${sequenceRow.task_code}-${sequence}`,
      sequence,
      title,
      description,
      status.id,
      input.priority ? priority(input.priority) : "none",
      assigneeUserId,
      project.id,
      release?.id ?? null,
      optionalEstimate(input.estimate),
      optionalDate(input.dueDate),
      rankRow?.next ?? 1000,
      timestamps.startedAt,
      timestamps.completedAt,
      timestamps.canceledAt,
      now,
      now,
    ),
    ...labelIds.map((labelId) => db.prepare(
      `INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)`,
    ).bind(taskId, labelId)),
    activity.statement,
  ]);
  return { id: taskId, publicId };
}

export async function createSubtask(
  currentUser: UserRecord,
  parentTaskId: string,
  input: Record<string, unknown>,
): Promise<TaskRecord> {
  const parent = await loadAccessibleTask(currentUser.id, parentTaskId);
  requireContentEdit(parent.accessRole);
  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== parent.version) {
    throw new ConflictError("Parent Task was changed in another session");
  }
  if (parent.archivedAt) {
    throw new ValidationError("Subtasks cannot be added to an archived Task");
  }

  const project = await loadAccessibleProject(currentUser.id, parent.projectId);
  requireContentEdit(project.accessRole);
  if (project.archivedAt || project.status === "canceled") {
    throw new ValidationError("Subtasks require an active Project");
  }
  const title = requireTitle(input.title);
  const description = optionalText(input.description);
  await validateTaskDescriptionAttachments(null, description);
  const status = await loadStatus(
    parent.ownerUserId,
    input.statusId ? String(input.statusId) : null,
  );
  const release = input.releaseId
    ? await loadAccessibleRelease(currentUser.id, String(input.releaseId))
    : null;
  if (release) requireContentEdit(release.accessRole);
  assertReleaseProject(project.id, release?.projectId ?? null);
  assertReleasedCompositionChange(null, release, input);
  const assigneeUserId = Object.hasOwn(input, "assigneeUserId")
    ? requestedAssigneeUserId(input.assigneeUserId)
    : currentUser.id;
  await assertTaskAssigneeAccess(
    assigneeUserId,
    parent.ownerUserId,
    project.id,
    null,
  );
  const labelIds = await validateActiveLabelIds(parent.ownerUserId, input.labelIds);
  const rankRow = await getD1()
    .prepare(
      "SELECT COALESCE(MAX(rank), 0) + 1000 AS next FROM tasks WHERE owner_user_id = ? AND status_id = ?",
    )
    .bind(parent.ownerUserId, status.id)
    .first<{ next: number }>();
  const now = new Date().toISOString();
  const timestamps = statusTimestamps(
    status.category,
    { startedAt: null, completedAt: null, canceledAt: null },
    now,
  );
  const taskId = `task_${crypto.randomUUID()}`;
  const publicId = crypto.randomUUID();
  const assertionId = `subtask_assert_${crypto.randomUUID()}`;
  const db = getD1();
  const activity = activityEventStatement(db, currentUser, {
    taskId,
    eventType: "task_created",
    payload: {
      parentTaskId: parent.id,
      project: { id: project.id, name: project.name },
      status: { id: status.id, name: status.name },
    },
    createdAt: now,
  });

  try {
    const results = await db.batch([
      db.prepare(
        `UPDATE projects SET
           task_sequence = MAX(
             task_sequence + 1,
             (SELECT COALESCE(MAX(sequence_number), 0) + 1
              FROM tasks WHERE project_id = projects.id)
           ),
           code_locked_at = COALESCE(code_locked_at, ?),
           version = version + 1,
           updated_at = ?
         WHERE id = ? AND archived_at IS NULL AND status <> 'canceled'
           AND EXISTS (
             SELECT 1 FROM tasks parent
             WHERE parent.id = ? AND parent.project_id = projects.id
               AND parent.version = ? AND parent.archived_at IS NULL
           )
           AND (
             owner_user_id = ? OR EXISTS (
               SELECT 1 FROM access_grants ag
               WHERE ag.resource_type = 'project' AND ag.resource_id = projects.id
                 AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                 AND ag.permission IN ('editor', 'manager', 'full_access')
             )
           )`,
      ).bind(
        now,
        now,
        project.id,
        parent.id,
        expectedVersion,
        currentUser.id,
        currentUser.id,
      ),
      moveBatchAssertion(db, assertionId, "allocator"),
      db.prepare(
        `INSERT INTO tasks (
           id, public_id, owner_user_id, creator_user_id, identifier,
           sequence_number, title, description, status_id, priority,
           assignee_user_id, project_id, release_id, estimate, due_date,
           parent_task_id, rank, started_at, completed_at, canceled_at,
           created_at, updated_at
         )
         SELECT ?, ?, p.owner_user_id, ?, p.task_code || '-' || p.task_sequence,
           p.task_sequence, ?, ?, ?, ?, ?, p.id, ?, ?, ?, parent.id, ?, ?, ?, ?, ?, ?
         FROM projects p JOIN tasks parent ON parent.project_id = p.id
         WHERE p.id = ? AND parent.id = ? AND parent.version = ?
           AND parent.archived_at IS NULL AND p.archived_at IS NULL
           AND p.status <> 'canceled'
           AND (
             p.owner_user_id = ? OR EXISTS (
               SELECT 1 FROM access_grants ag
               WHERE ag.resource_type = 'project' AND ag.resource_id = p.id
                 AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                 AND ag.permission IN ('editor', 'manager', 'full_access')
             )
           )`,
      ).bind(
        taskId,
        publicId,
        currentUser.id,
        title,
        description,
        status.id,
        input.priority ? priority(input.priority) : "none",
        assigneeUserId,
        release?.id ?? null,
        optionalEstimate(input.estimate),
        optionalDate(input.dueDate),
        rankRow?.next ?? 1000,
        timestamps.startedAt,
        timestamps.completedAt,
        timestamps.canceledAt,
        now,
        now,
        project.id,
        parent.id,
        expectedVersion,
        currentUser.id,
        currentUser.id,
      ),
      moveBatchAssertion(db, `${assertionId}_task`, "task"),
      db.prepare(
        `UPDATE tasks SET version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND project_id = ?
           AND ${editableTaskWhere}`,
      ).bind(
        now,
        parent.id,
        expectedVersion,
        project.id,
        currentUser.id,
        currentUser.id,
        currentUser.id,
        currentUser.id,
      ),
      moveBatchAssertion(db, `${assertionId}_parent`, "parent"),
      ...labelIds.map((labelId) => db.prepare(
        `INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)`,
      ).bind(taskId, labelId)),
      activity.statement,
    ]);
    if (
      (results[0]?.meta.changes ?? 0) < 1 ||
      (results[2]?.meta.changes ?? 0) < 1 ||
      (results[4]?.meta.changes ?? 0) < 1
    ) {
      throw new ConflictError("Subtask could not be created atomically");
    }
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    if (isConstraintError(error)) {
      throw new ConflictError(
        "Parent Task, Project access, or Project sequence changed before the subtask committed",
      );
    }
    throw error;
  }

  return loadAccessibleTask(currentUser.id, taskId);
}

export async function setTaskParent(
  currentUser: UserRecord,
  taskId: string,
  input: Record<string, unknown>,
): Promise<TaskRecord> {
  const task = await loadAccessibleTask(currentUser.id, taskId);
  requireContentEdit(task.accessRole);
  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== task.version) {
    throw new ConflictError("Task was changed in another session");
  }
  const parentTaskId = input.parentTaskId == null
    ? null
    : String(input.parentTaskId);
  if (parentTaskId === task.id) {
    throw new ValidationError("A Task cannot be its own parent");
  }
  if (parentTaskId === task.parentTaskId) return task;

  if (parentTaskId) {
    const parent = await loadAccessibleTask(currentUser.id, parentTaskId);
    requireContentEdit(parent.accessRole);
    if (parent.projectId !== task.projectId) {
      throw new ValidationError("Parent and subtask must belong to the same Project");
    }
    if (parent.archivedAt) {
      throw new ValidationError("An archived Task cannot become a new parent");
    }
    const cycle = await getD1().prepare(
      `WITH RECURSIVE ancestors(id, parent_task_id) AS (
         SELECT id, parent_task_id FROM tasks WHERE id = ?
         UNION ALL
         SELECT parent.id, parent.parent_task_id
         FROM tasks parent JOIN ancestors child ON parent.id = child.parent_task_id
       )
       SELECT 1 AS found FROM ancestors WHERE id = ? LIMIT 1`,
    ).bind(parentTaskId, task.id).first<{ found: number }>();
    if (cycle) throw new ValidationError("Task hierarchy cannot contain a cycle");
  }

  const now = new Date().toISOString();
  const oldParentTaskId = task.parentTaskId;
  const db = getD1();
  const activity = activityEventStatement(db, currentUser, {
    taskId: task.id,
    eventType: "hierarchy_changed",
    payload: {
      changes: {
        parentTaskId: { before: oldParentTaskId, after: parentTaskId },
      },
    },
    createdAt: now,
  });
  const parentGuard = parentTaskId
    ? `EXISTS (
         SELECT 1 FROM tasks parent
         WHERE parent.id = ? AND parent.id <> tasks.id
           AND parent.project_id = tasks.project_id
           AND parent.archived_at IS NULL
       ) AND NOT EXISTS (
         WITH RECURSIVE ancestors(id, parent_task_id) AS (
           SELECT id, parent_task_id FROM tasks WHERE id = ?
           UNION ALL
           SELECT parent.id, parent.parent_task_id
           FROM tasks parent JOIN ancestors child
             ON parent.id = child.parent_task_id
         )
         SELECT 1 FROM ancestors WHERE id = tasks.id
       )`
    : "1 = 1";
  const parentBindings = parentTaskId ? [parentTaskId, parentTaskId] : [];
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
      `UPDATE tasks SET parent_task_id = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND project_id IS NOT NULL
         AND ${parentGuard} AND ${editableTaskWhere}`,
    ).bind(
      parentTaskId,
      now,
      task.id,
      expectedVersion,
      ...parentBindings,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
    ),
    activityBatchAssertion(
      db,
      `activity_assert_${crypto.randomUUID()}`,
      now,
    ),
    activity.statement,
    db.prepare(
      `INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
       SELECT ?, 'task_detail'
       WHERE ? IS NOT NULL AND EXISTS (
         SELECT 1 FROM tasks child
         WHERE child.id = ? AND child.version = ? AND child.parent_task_id IS ?
       )`,
    ).bind(
      oldParentTaskId,
      oldParentTaskId,
      task.id,
      expectedVersion + 1,
      parentTaskId,
    ),
    db.prepare(
      `INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
       SELECT ?, 'task_detail'
       WHERE ? IS NOT NULL AND ? IS NOT ? AND EXISTS (
         SELECT 1 FROM tasks child
         WHERE child.id = ? AND child.version = ? AND child.parent_task_id IS ?
       )`,
    ).bind(
      parentTaskId,
      parentTaskId,
      parentTaskId,
      oldParentTaskId,
      task.id,
      expectedVersion + 1,
      parentTaskId,
      ),
    ]);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError(
        "Task hierarchy, Project access, or Task version changed before the update committed",
      );
    }
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) < 1) {
    throw new ConflictError(
      "Task hierarchy, Project access, or Task version changed before the update committed",
    );
  }
  return loadAccessibleTask(currentUser.id, task.id);
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
    if (!input.projectId) throw new ValidationError("Project cannot be cleared");
    const targetProject = await loadAccessibleProject(
      currentUser.id,
      String(input.projectId),
    );
    requireContentEdit(targetProject.accessRole);
    if (targetProject.id !== task.projectId) {
      throw new ValidationError("Use the explicit Task move command to change Project");
    }
    projectId = targetProject.id;
  }

  let releaseId = task.releaseId;
  let selectedRelease: ReleaseRecord | null = null;
  if (Object.hasOwn(input, "releaseId")) {
    selectedRelease = input.releaseId
      ? await loadAccessibleRelease(currentUser.id, String(input.releaseId))
      : null;
    if (selectedRelease) requireContentEdit(selectedRelease.accessRole);
    assertReleaseProject(projectId, selectedRelease?.projectId ?? null);
    const currentRelease = task.releaseId
      ? await loadAccessibleRelease(currentUser.id, task.releaseId)
      : null;
    assertReleasedCompositionChange(currentRelease, selectedRelease, input);
    releaseId = selectedRelease?.id ?? null;
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
    : await loadStatus(task.ownerUserId, task.statusId, { allowArchived: true });
  const previousStatus = status.id === task.statusId
    ? status
    : await loadStatus(task.ownerUserId, task.statusId, { allowArchived: true });
  const now = new Date().toISOString();
  const timestamps = statusTimestamps(status.category, task, now);
  const title = Object.hasOwn(input, "title")
    ? requireTitle(input.title)
    : task.title;
  const descriptionChanged = Object.hasOwn(input, "description");
  const description = descriptionChanged
    ? optionalText(input.description)
    : task.description ?? "";
  const descriptionRefs = descriptionChanged
    ? await validateTaskDescriptionAttachments(task.id, description)
    : [];
  const descriptionPredicate = taskDescriptionAttachmentPredicate(descriptionRefs);
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

  const changes = changedFields([
    ["title", task.title, title],
    ["description", task.description ?? "", description],
    ["status", { id: task.statusId, name: previousStatus.name }, { id: status.id, name: status.name }],
    ["priority", task.priority, nextPriority],
    ["assigneeUserId", task.assigneeUserId, assigneeUserId],
    ["projectId", task.projectId, projectId],
    ["releaseId", task.releaseId, releaseId],
    ["estimate", task.estimate, estimate],
    ["dueDate", task.dueDate, dueDate],
    ["rank", task.rank, rank],
    ["archivedAt", task.archivedAt, archivedAt],
  ]);
  if (Object.keys(changes).length === 0) return task;
  if (Object.hasOwn(changes, "description")) {
    changes.description = {
      before: task.description ? "Set" : "Empty",
      after: description ? "Set" : "Empty",
    };
  }
  const eventType = Object.hasOwn(changes, "archivedAt")
    ? archivedAt ? "task_archived" : "task_restored"
    : Object.keys(changes).length === 1 && Object.hasOwn(changes, "status")
      ? "status_changed"
      : "task_updated";
  const db = getD1();
  const activity = activityEventStatement(db, currentUser, {
    taskId,
    eventType,
    payload: { changes },
    createdAt: now,
  });

  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
      `UPDATE tasks SET
        title = ?, description = ?, status_id = ?, priority = ?,
        assignee_user_id = ?, project_id = ?, release_id = ?, estimate = ?, due_date = ?, rank = ?,
        started_at = ?, completed_at = ?, canceled_at = ?, archived_at = ?,
        version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?${descriptionPredicate.sql} AND (
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
       )
       AND (
         ? = 1 OR release_id IS ? OR NOT EXISTS (
           SELECT 1 FROM releases locked_release
           WHERE locked_release.id IN (tasks.release_id, ?)
             AND locked_release.status = 'released'
         )
       )`,
      ).bind(
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
      ...descriptionPredicate.bindings,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      input.confirmReleasedComposition === true ? 1 : 0,
      releaseId,
      releaseId,
      ),
      activityBatchAssertion(
        db,
        `activity_assert_${crypto.randomUUID()}`,
        now,
      ),
      activity.statement,
    ]);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError("Task was changed in another session");
    }
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) < 1) {
    throw new ConflictError("Task was changed in another session");
  }
  return loadAccessibleTask(currentUser.id, taskId);
}

export async function moveTask(
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
  if (!input.targetProjectId) {
    throw new ValidationError("Target Project is required");
  }

  const sourceProject = await loadAccessibleProject(currentUser.id, task.projectId);
  requireContentEdit(sourceProject.accessRole);
  const targetProject = await loadAccessibleProject(
    currentUser.id,
    String(input.targetProjectId),
  );
  requireContentEdit(targetProject.accessRole);
  if (targetProject.id === sourceProject.id) return task;
  if (targetProject.archivedAt) {
    throw new ValidationError("Tasks cannot be moved to an archived Project");
  }
  if (targetProject.status === "canceled") {
    throw new ValidationError("Tasks cannot be moved to a canceled Project");
  }

  const currentRelease = task.releaseId
    ? await loadAccessibleRelease(currentUser.id, task.releaseId)
    : null;
  let releaseId: string | null;
  let selectedRelease: ReleaseRecord | null = null;
  if (Object.hasOwn(input, "releaseId")) {
    selectedRelease = input.releaseId
      ? await loadAccessibleRelease(currentUser.id, String(input.releaseId))
      : null;
    if (selectedRelease) requireContentEdit(selectedRelease.accessRole);
    assertReleaseProject(targetProject.id, selectedRelease?.projectId ?? null);
    releaseId = selectedRelease?.id ?? null;
  } else if (task.releaseId) {
    throw new ValidationError(
      "Choose a Release in the target Project or explicitly clear the current Release",
    );
  } else {
    releaseId = null;
  }
  assertReleasedCompositionChange(currentRelease, selectedRelease, input);

  const assigneeUserId = Object.hasOwn(input, "assigneeUserId")
    ? requestedAssigneeUserId(input.assigneeUserId)
    : task.assigneeUserId;
  try {
    await assertTaskAssigneeAccess(
      assigneeUserId,
      task.ownerUserId,
      targetProject.id,
      task.id,
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(
        "Choose an assignee with access to the target Project or explicitly clear the assignee",
      );
    }
    throw error;
  }

  const hierarchy = await getD1()
    .prepare(
      `SELECT
         EXISTS (SELECT 1 FROM tasks child WHERE child.parent_task_id = ?) AS has_children`,
    )
    .bind(task.id)
    .first<{ has_children: number }>();
  if (task.parentTaskId || Number(hierarchy?.has_children ?? 0) === 1) {
    throw new ValidationError(
      "Detach or reparent this Task hierarchy before moving it to another Project",
    );
  }

  const now = new Date().toISOString();
  const db = getD1();
  const guardSql = `
    SELECT 1
    FROM tasks moving
    JOIN projects source ON source.id = moving.project_id
    JOIN projects target ON target.id = ?
    WHERE moving.id = ? AND moving.version = ? AND moving.project_id = ?
      AND target.archived_at IS NULL AND target.status <> 'canceled'
      AND (
        source.owner_user_id = ? OR EXISTS (
          SELECT 1 FROM access_grants source_grant
          WHERE source_grant.resource_type = 'project'
            AND source_grant.resource_id = source.id
            AND source_grant.grantee_user_id = ?
            AND source_grant.revoked_at IS NULL
            AND source_grant.permission IN ('editor', 'manager', 'full_access')
        )
      )
      AND (
        target.owner_user_id = ? OR EXISTS (
          SELECT 1 FROM access_grants target_grant
          WHERE target_grant.resource_type = 'project'
            AND target_grant.resource_id = target.id
            AND target_grant.grantee_user_id = ?
            AND target_grant.revoked_at IS NULL
            AND target_grant.permission IN ('editor', 'manager', 'full_access')
        )
      )
      AND moving.parent_task_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM tasks child WHERE child.parent_task_id = moving.id
      )
      AND (
        ? IS NULL OR EXISTS (
          SELECT 1 FROM releases selected_release
          WHERE selected_release.id = ?
            AND selected_release.project_id = target.id
        )
      )
      AND (
        ? IS NULL OR EXISTS (
          SELECT 1 FROM users assignee
          WHERE assignee.id = ? AND (
            target.owner_user_id = assignee.id OR EXISTS (
              SELECT 1 FROM access_grants assignee_grant
              WHERE assignee_grant.resource_type = 'project'
                AND assignee_grant.resource_id = target.id
                AND assignee_grant.grantee_user_id = assignee.id
                AND assignee_grant.revoked_at IS NULL
            )
          )
        )
      )
      AND (
        ? = 1 OR NOT EXISTS (
          SELECT 1 FROM releases locked_release
          WHERE locked_release.id IN (moving.release_id, ?)
            AND locked_release.status = 'released'
        )
      )`;
  const guardBindings = [
    targetProject.id,
    task.id,
    expectedVersion,
    sourceProject.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
    releaseId,
    releaseId,
    assigneeUserId,
    assigneeUserId,
    input.confirmReleasedComposition === true ? 1 : 0,
    releaseId,
  ];
  const assertionId = `move_assert_${crypto.randomUUID()}`;
  const aliasId = `alias_${crypto.randomUUID()}`;
  const activityId = newActivityId();
  const activityInsert = db.prepare(
    `INSERT INTO activity_events
      (id, task_id, schema_version, event_type, actor_kind, actor_user_id,
       actor_name, payload_json, source, created_at)
     SELECT ?, moved.id, 1, 'task_moved', 'user', ?, ?,
       json_object('changes', json_object(
         'project', json_object(
           'before', json_object('id', ?, 'name', ?),
           'after', json_object('id', ?, 'name', ?)
         ),
         'identifier', json_object('before', ?, 'after', moved.identifier),
         'releaseId', json_object('before', ?, 'after', moved.release_id),
         'assigneeUserId', json_object('before', ?, 'after', moved.assignee_user_id)
       )),
       'native', ?
     FROM tasks moved WHERE moved.id = ? AND moved.version = ?`,
  ).bind(
    activityId,
    currentUser.id,
    currentUser.displayName,
    sourceProject.id,
    sourceProject.name,
    targetProject.id,
    targetProject.name,
    task.identifier,
    task.releaseId,
    task.assigneeUserId,
    now,
    task.id,
    expectedVersion + 1,
  );

  try {
    const results = await db.batch([
      db
        .prepare(
          `WITH move_guard AS (${guardSql})
           UPDATE projects SET
             task_sequence = MAX(
               task_sequence + 1,
               (SELECT COALESCE(MAX(sequence_number), 0) + 1
                FROM tasks WHERE project_id = projects.id)
             ),
             code_locked_at = COALESCE(code_locked_at, ?),
             version = version + 1,
             updated_at = ?
           WHERE id = ? AND EXISTS (SELECT 1 FROM move_guard)`,
        )
        .bind(...guardBindings, now, now, targetProject.id),
      moveBatchAssertion(db, assertionId, "allocator"),
      db
        .prepare(
          `WITH move_guard AS (${guardSql})
           UPDATE tasks SET
             project_id = ?,
             sequence_number = (
               SELECT task_sequence FROM projects WHERE id = ?
             ),
             identifier = (
               SELECT task_code || '-' || task_sequence
               FROM projects WHERE id = ?
             ),
             release_id = ?,
             assignee_user_id = ?,
             version = version + 1,
             updated_at = ?
           WHERE id = ? AND version = ?
             AND EXISTS (SELECT 1 FROM move_guard)`,
        )
        .bind(
          ...guardBindings,
          targetProject.id,
          targetProject.id,
          targetProject.id,
          releaseId,
          assigneeUserId,
          now,
          task.id,
          expectedVersion,
        ),
      moveBatchAssertion(db, `${assertionId}_task`, "task"),
      db
        .prepare(
          `INSERT OR IGNORE INTO task_identifier_aliases
             (id, task_id, identifier, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(aliasId, task.id, task.identifier, now),
      activityInsert,
    ]);
    if (
      (results[0]?.meta.changes ?? 0) < 1 ||
      (results[2]?.meta.changes ?? 0) < 1
    ) {
      throw new ConflictError("Task move could not be committed atomically");
    }
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    if (isConstraintError(error)) {
      throw new ConflictError(
        "Task, Project access, or target sequence changed before the move committed",
      );
    }
    throw error;
  }

  return loadAccessibleTask(currentUser.id, task.id);
}

function moveBatchAssertion(
  db: D1Database,
  assertionId: string,
  step: string,
) {
  return db
    .prepare(
      `INSERT INTO task_identifier_aliases (id, task_id, identifier)
       SELECT ?, NULL, ? WHERE changes() = 0`,
    )
    .bind(assertionId, `move-assert-${step}`);
}

function isConstraintError(error: unknown) {
  return error instanceof Error && /constraint|unique|not null/i.test(error.message);
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
  const primaryIndexes: number[] = [];
  for (const task of tasks) {
    let update: D1PreparedStatement;
    let eventType: string;
    let changes: Record<string, unknown>;
    if (field === "priority") {
      if (task.priority === nextPriority) continue;
      update = db
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
        );
      eventType = "task_updated";
      changes = { priority: { before: task.priority, after: nextPriority } };
    } else if (field === "archived") {
      const desiredArchived = Boolean(input.value);
      if (Boolean(task.archivedAt) === desiredArchived) continue;
      const nextArchivedAt = desiredArchived ? now : null;
      update = db
        .prepare(
          `UPDATE tasks SET archived_at = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND ${editableTaskWhere}`,
        )
        .bind(
          nextArchivedAt,
          now,
          task.id,
          task.version,
          currentUser.id,
          currentUser.id,
          currentUser.id,
          currentUser.id,
        );
      eventType = desiredArchived ? "task_archived" : "task_restored";
      changes = { archivedAt: { before: task.archivedAt, after: nextArchivedAt } };
    } else {
      if (task.statusId === targetStatus!.id) continue;
      const timestamps = statusTimestamps(targetStatus!.category, task, now);
      update = db
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
        );
      eventType = "status_changed";
      changes = {
        status: {
          before: { id: task.statusId },
          after: { id: targetStatus!.id, name: targetStatus!.name },
        },
      };
    }
    primaryIndexes.push(statements.length);
    const activity = activityEventStatement(db, currentUser, {
      taskId: task.id,
      eventType,
      payload: { changes, bulk: true },
      createdAt: now,
    });
    statements.push(
      update,
      activityBatchAssertion(
        db,
        `activity_assert_${crypto.randomUUID()}`,
        now,
      ),
      activity.statement,
    );
  }
  if (!statements.length) return tasks;
  let results: D1Result<unknown>[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError("One or more tasks changed in another session");
    }
    throw error;
  }
  if (primaryIndexes.some((index) => (results[index]?.meta.changes ?? 0) < 1)) {
    throw new ConflictError("One or more tasks changed in another session");
  }
  return loadAccessibleTasks(currentUser.id, ids);
}

export type LabelSettingsRecord = LabelRecord & { taskCount: number };

export async function listOwnedLabels(
  currentUser: UserRecord,
): Promise<LabelSettingsRecord[]> {
  const rows = await getD1().prepare(
    `SELECT l.*, COUNT(tl.task_id) AS task_count
     FROM labels l
     LEFT JOIN task_labels tl ON tl.label_id = l.id
     WHERE l.owner_user_id = ?
     GROUP BY l.id
     ORDER BY l.archived_at IS NOT NULL, lower(l.name), l.id`,
  ).bind(currentUser.id).all<DbRow>();
  return rows.results.map((row) => ({
    ...mapLabel(row),
    taskCount: Number(row.task_count ?? 0),
  }));
}

export async function createLabel(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const name = labelName(input.name);
  const color = labelColor(input.color);
  const description = optionalText(input.description, 2_000);
  await assertUniqueActiveLabelName(currentUser.id, name);
  const now = new Date().toISOString();
  try {
    await getD1().prepare(
      `INSERT INTO labels
        (id, owner_user_id, name, color, description, archived_at,
         version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    ).bind(
      `label:${currentUser.id}:${crypto.randomUUID()}`,
      currentUser.id,
      name,
      color,
      description,
      now,
      now,
    ).run();
  } catch (error) {
    translateLabelNameCollision(error);
  }
  return listOwnedLabels(currentUser);
}

export async function updateLabel(
  currentUser: UserRecord,
  labelId: string,
  input: Record<string, unknown>,
) {
  const current = await loadOwnedLabel(currentUser.id, labelId);
  const version = expectedLabelVersion(input.version);
  if (current.version !== version) throw staleLabel();
  const action = input.action ?? "update";
  const now = new Date().toISOString();
  let result: D1Result<unknown>;
  if (action === "archive") {
    if (current.archivedAt) throw new ConflictError("Label is already archived");
    result = await getD1().prepare(
      `UPDATE labels SET archived_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NULL`,
    ).bind(now, now, labelId, currentUser.id, version).run();
  } else if (action === "restore") {
    if (!current.archivedAt) throw new ConflictError("Label is not archived");
    await assertUniqueActiveLabelName(currentUser.id, current.name, current.id);
    try {
      result = await getD1().prepare(
        `UPDATE labels SET archived_at = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NOT NULL`,
      ).bind(now, labelId, currentUser.id, version).run();
    } catch (error) {
      translateLabelNameCollision(error);
    }
  } else if (action === "update") {
    if (current.archivedAt) {
      throw new ValidationError("Restore an archived Label before editing it");
    }
    const name = Object.hasOwn(input, "name") ? labelName(input.name) : current.name;
    const color = Object.hasOwn(input, "color") ? labelColor(input.color) : current.color;
    const description = Object.hasOwn(input, "description")
      ? optionalText(input.description, 2_000)
      : current.description;
    if (name.toLocaleLowerCase() !== current.name.toLocaleLowerCase()) {
      await assertUniqueActiveLabelName(currentUser.id, name, current.id);
    }
    try {
      result = await getD1().prepare(
        `UPDATE labels SET name = ?, color = ?, description = ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NULL`,
      ).bind(name, color, description, now, labelId, currentUser.id, version).run();
    } catch (error) {
      translateLabelNameCollision(error);
    }
  } else {
    throw new ValidationError("Unsupported Label action");
  }
  if ((result!.meta.changes ?? 0) < 1) throw staleLabel();
  return listOwnedLabels(currentUser);
}

export async function getTaskLabelState(
  currentUser: UserRecord,
  taskId: string,
) {
  const task = await loadAccessibleTask(currentUser.id, taskId);
  const db = getD1();
  const [labels, assignments] = await db.batch<DbRow>([
    db.prepare(
      `SELECT l.* FROM labels l
       WHERE l.owner_user_id = ? AND (
         l.archived_at IS NULL OR EXISTS (
           SELECT 1 FROM task_labels tl
           WHERE tl.task_id = ? AND tl.label_id = l.id
         )
       )
       ORDER BY l.archived_at IS NOT NULL, lower(l.name), l.id`,
    ).bind(task.ownerUserId, task.id),
    db.prepare(
      `SELECT task_id, label_id FROM task_labels WHERE task_id = ? ORDER BY label_id`,
    ).bind(task.id),
  ]);
  return {
    labels: labels.results.map(mapLabel),
    taskLabels: assignments.results.map(mapTaskLabel),
    taskIds: [task.id],
    canWrite: canEditContent(task.accessRole),
  };
}

export async function getProjectLabelCatalog(
  currentUser: UserRecord,
  projectId: string,
  includeArchived = false,
) {
  const project = await loadAccessibleProject(currentUser.id, projectId);
  requireContentEdit(project.accessRole);
  const rows = await getD1().prepare(
    `SELECT * FROM labels
     WHERE owner_user_id = ? AND (? = 1 OR archived_at IS NULL)
     ORDER BY lower(name), id`,
  ).bind(project.ownerUserId, includeArchived ? 1 : 0).all<DbRow>();
  return { labels: rows.results.map(mapLabel) };
}

export async function setTaskLabel(
  currentUser: UserRecord,
  taskId: string,
  input: Record<string, unknown>,
) {
  const task = await loadAccessibleTask(currentUser.id, taskId);
  requireContentEdit(task.accessRole);
  const labelId = requiredLabelId(input.labelId);
  const active = input.active;
  if (typeof active !== "boolean") {
    throw new ValidationError("Label assignment active must be boolean");
  }
  const label = await loadTaskOwnerLabel(task.ownerUserId, labelId, !active);
  const db = getD1();
  const existing = await db.prepare(
    "SELECT 1 AS assigned FROM task_labels WHERE task_id = ? AND label_id = ?",
  ).bind(task.id, label.id).first<{ assigned: number }>();
  if (Boolean(existing) === active) {
    return getTaskLabelState(currentUser, task.id);
  }
  const now = new Date().toISOString();
  const activity = activityEventStatement(db, currentUser, {
    taskId: task.id,
    eventType: "labels_changed",
    payload: {
      label: { id: label.id, name: label.name },
      active,
    },
    createdAt: now,
  });
  const mutation = active
    ? db.prepare(
      `INSERT OR IGNORE INTO task_labels (task_id, label_id)
       SELECT tasks.id, labels.id FROM tasks, labels
       WHERE tasks.id = ? AND labels.id = ?
         AND labels.owner_user_id = tasks.owner_user_id
         AND labels.archived_at IS NULL
         AND ${editableTaskWhere}`,
    ).bind(
      task.id,
      label.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
    )
    : db.prepare(
      `DELETE FROM task_labels
       WHERE task_id = ? AND label_id = ? AND EXISTS (
         SELECT 1 FROM tasks
         WHERE tasks.id = task_labels.task_id AND ${editableTaskWhere}
       )`,
    ).bind(
      task.id,
      label.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
    );
  try {
    await db.batch([
      mutation,
      activityBatchAssertion(
        db,
        `activity_assert_${crypto.randomUUID()}`,
        now,
      ),
      activity.statement,
      db.prepare(
        `UPDATE tasks SET updated_at = CASE
           WHEN updated_at >= ?
             THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds')
           ELSE ? END
         WHERE id = ?`,
      ).bind(now, now, task.id),
    ]);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError("Task access or Label state changed before the assignment committed");
    }
    throw error;
  }
  const state = await getTaskLabelState(currentUser, task.id);
  const applied = state.taskLabels.some((item) => item.labelId === label.id);
  if (applied !== active) {
    throw new ConflictError("Task access or Label state changed before the assignment committed");
  }
  return state;
}

export async function bulkSetTaskLabel(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const taskIds = Array.isArray(input.ids)
    ? [...new Set(input.ids.map(String))]
    : [];
  if (taskIds.length === 0 || taskIds.length > 100) {
    throw new ValidationError("Select between 1 and 100 tasks");
  }
  const active = input.active;
  if (typeof active !== "boolean") {
    throw new ValidationError("Label assignment active must be boolean");
  }
  const tasks = await loadAccessibleTasks(currentUser.id, taskIds);
  tasks.forEach((task) => requireContentEdit(task.accessRole));
  const ownerIds = new Set(tasks.map((task) => task.ownerUserId));
  if (ownerIds.size !== 1) {
    throw new ValidationError("Bulk Label changes require Tasks from one owner catalog");
  }
  const label = await loadTaskOwnerLabel(
    tasks[0]!.ownerUserId,
    requiredLabelId(input.labelId),
    !active,
  );
  const db = getD1();
  const placeholders = sqlPlaceholders(taskIds);
  const currentRows = await db.prepare(
    `SELECT task_id FROM task_labels
     WHERE task_id IN (${placeholders}) AND label_id = ?`,
  ).bind(...taskIds, label.id).all<{ task_id: string }>();
  const assigned = new Set(currentRows.results.map((row) => row.task_id));
  const changedTasks = tasks.filter((task) => assigned.has(task.id) !== active);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const task of changedTasks) {
    const activity = activityEventStatement(db, currentUser, {
      taskId: task.id,
      eventType: "labels_changed",
      payload: { label: { id: label.id, name: label.name }, active, bulk: true },
      createdAt: now,
    });
    statements.push(
      active
        ? db.prepare(
          `INSERT OR IGNORE INTO task_labels (task_id, label_id)
           SELECT tasks.id, ? FROM tasks
           WHERE tasks.id = ? AND ${editableTaskWhere}`,
        ).bind(
          label.id,
          task.id,
          currentUser.id,
          currentUser.id,
          currentUser.id,
          currentUser.id,
        )
        : db.prepare(
          `DELETE FROM task_labels
           WHERE task_id = ? AND label_id = ? AND EXISTS (
             SELECT 1 FROM tasks
             WHERE tasks.id = task_labels.task_id AND ${editableTaskWhere}
           )`,
        ).bind(
          task.id,
          label.id,
          currentUser.id,
          currentUser.id,
          currentUser.id,
          currentUser.id,
        ),
      activityBatchAssertion(
        db,
        `activity_assert_${crypto.randomUUID()}`,
        now,
      ),
      activity.statement,
      db.prepare(
        `UPDATE tasks SET updated_at = CASE
           WHEN updated_at >= ?
             THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds')
           ELSE ? END
         WHERE id = ?`,
      ).bind(now, now, task.id),
    );
  }
  if (statements.length) {
    try {
      await db.batch(statements);
    } catch (error) {
      if (isConstraintError(error)) {
        throw new ConflictError("Task access or Label state changed during the bulk action");
      }
      throw error;
    }
  }
  const rows = await db.prepare(
    `SELECT task_id, label_id FROM task_labels
     WHERE task_id IN (${placeholders}) ORDER BY task_id, label_id`,
  ).bind(...taskIds).all<DbRow>();
  const assignments = rows.results.map(mapTaskLabel);
  for (const task of tasks) {
    const applied = assignments.some((item) =>
      item.taskId === task.id && item.labelId === label.id);
    if (applied !== active) {
      throw new ConflictError("Task access or Label state changed during the bulk action");
    }
  }
  return { labels: [label], taskLabels: assignments, taskIds };
}

async function validateActiveLabelIds(ownerUserId: string, value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError("Label IDs must be an array");
  const ids = [...new Set(value.map(requiredLabelId))];
  if (ids.length > 50) throw new ValidationError("A Task can have at most 50 Labels");
  if (!ids.length) return ids;
  const rows = await getD1().prepare(
    `SELECT id FROM labels
     WHERE owner_user_id = ? AND archived_at IS NULL
       AND id IN (${sqlPlaceholders(ids)})`,
  ).bind(ownerUserId, ...ids).all<{ id: string }>();
  if (rows.results.length !== ids.length) {
    throw new ValidationError("Every Label must be active in the Task owner catalog");
  }
  return ids;
}

async function loadOwnedLabel(ownerUserId: string, labelId: string) {
  const row = await getD1().prepare(
    "SELECT * FROM labels WHERE id = ? AND owner_user_id = ?",
  ).bind(labelId, ownerUserId).first<DbRow>();
  if (!row) throw new NotFoundError("Label not found");
  return mapLabel(row);
}

async function loadTaskOwnerLabel(
  ownerUserId: string,
  labelId: string,
  allowArchived: boolean,
) {
  const label = await loadOwnedLabel(ownerUserId, labelId);
  if (!allowArchived && label.archivedAt) {
    throw new ValidationError("Archived Labels cannot be assigned");
  }
  return label;
}

async function assertUniqueActiveLabelName(
  ownerUserId: string,
  name: string,
  exceptId?: string,
) {
  const row = await getD1().prepare(
    `SELECT id FROM labels
     WHERE owner_user_id = ? AND archived_at IS NULL AND lower(name) = lower(?)
       AND (? IS NULL OR id <> ?)
     LIMIT 1`,
  ).bind(ownerUserId, name, exceptId ?? null, exceptId ?? null).first();
  if (row) throw new ValidationError("An active Label with this name already exists");
}

function labelName(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError("Label name is required");
  }
  const name = value.trim();
  if (name.length > 80) throw new ValidationError("Label name is too long");
  return name;
}

function labelColor(value: unknown) {
  const color = value === undefined ? "#6b7280" : String(value).trim();
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new ValidationError("Label color must be a six-digit hex color");
  }
  return color.toLowerCase();
}

function requiredLabelId(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new ValidationError("Label ID is required");
  }
  return value.trim();
}

function expectedLabelVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError("Current Label version is required");
  }
  return version;
}

function staleLabel() {
  return new ConflictError("Label was changed in another session");
}

function translateLabelNameCollision(error: unknown): never {
  if (error instanceof ValidationError) throw error;
  if (error instanceof Error && /idx_labels_owner_name|unique/i.test(error.message)) {
    throw new ValidationError("An active Label with this name already exists");
  }
  throw error;
}

export async function createProject(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const now = new Date().toISOString();
  const code = projectTaskCode(input.taskCode);
  const status = projectStatus(input.status ?? "planned");
  const leadUserId = input.leadUserId == null || input.leadUserId === ""
    ? currentUser.id
    : String(input.leadUserId);
  if (leadUserId !== currentUser.id) {
    throw new ValidationError("A new Project lead must be its owner");
  }
  const duplicate = await getD1()
    .prepare(
      `SELECT id FROM projects
       WHERE owner_user_id = ? AND task_code = ? AND archived_at IS NULL
       LIMIT 1`,
    )
    .bind(currentUser.id, code)
    .first();
  if (duplicate) throw new ValidationError("Project code is already in use");
  try {
    await getD1()
    .prepare(
      `INSERT INTO projects
        (id, public_id, owner_user_id, creator_user_id, name, task_code,
         summary, description, status, lead_user_id, start_date, target_date,
         icon, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `project_${crypto.randomUUID()}`,
      crypto.randomUUID(),
      currentUser.id,
      currentUser.id,
      requireTitle(input.name),
      code,
      optionalText(input.summary, 500),
      optionalText(input.description),
      status,
      leadUserId,
      optionalDate(input.startDate),
      optionalDate(input.targetDate),
      projectIcon(input.icon ?? "cube"),
      projectColor(input.color ?? "#8b7cf6"),
      now,
      now,
    )
    .run();
  } catch (error) {
    if (error instanceof Error && /task_code|unique/i.test(error.message)) {
      throw new ValidationError("Project code is already in use");
    }
    throw error;
  }
}

export async function updateProject(
  currentUser: UserRecord,
  projectId: string,
  input: Record<string, unknown>,
): Promise<ProjectRecord> {
  const project = await loadAccessibleProject(currentUser.id, projectId);
  requireContentEdit(project.accessRole);
  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== project.version) {
    throw new ConflictError("Project was changed in another session");
  }

  const name = Object.hasOwn(input, "name")
    ? requireTitle(input.name)
    : project.name;
  const taskCode = Object.hasOwn(input, "taskCode")
    ? projectTaskCode(input.taskCode)
    : project.taskCode;
  if (taskCode !== project.taskCode && (project.codeLockedAt || project.taskSequence > 0)) {
    throw new ValidationError("Project code is locked after the first Task number is allocated");
  }
  const summary = Object.hasOwn(input, "summary")
    ? optionalText(input.summary, 500)
    : project.summary;
  const description = Object.hasOwn(input, "description")
    ? optionalText(input.description)
    : project.description;
  const status = Object.hasOwn(input, "status")
    ? projectStatus(input.status)
    : project.status;
  const startDate = Object.hasOwn(input, "startDate")
    ? optionalDate(input.startDate)
    : project.startDate;
  const targetDate = Object.hasOwn(input, "targetDate")
    ? optionalDate(input.targetDate)
    : project.targetDate;
  const icon = Object.hasOwn(input, "icon")
    ? projectIcon(input.icon)
    : project.icon;
  const color = Object.hasOwn(input, "color")
    ? projectColor(input.color)
    : project.color;
  const leadUserId = Object.hasOwn(input, "leadUserId")
    ? input.leadUserId == null || input.leadUserId === ""
      ? null
      : String(input.leadUserId)
    : project.leadUserId;
  if (leadUserId) {
    const accessibleLead = await getD1().prepare(
      `SELECT 1 FROM projects p
       WHERE p.id = ? AND (
         p.owner_user_id = ? OR EXISTS (
           SELECT 1 FROM access_grants ag
           WHERE ag.resource_type = 'project' AND ag.resource_id = p.id
             AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
         )
       )`,
    ).bind(project.id, leadUserId, leadUserId).first();
    if (!accessibleLead) {
      throw new ValidationError("Project lead must have access to the Project");
    }
  }
  if (
    (status === "completed" || status === "canceled")
    && status !== project.status
    && input.confirmOpenTasks !== true
  ) {
    const open = await getD1().prepare(
      `SELECT COUNT(*) AS count
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
       WHERE t.project_id = ? AND t.archived_at IS NULL
         AND s.category NOT IN ('completed', 'canceled')`,
    ).bind(project.id).first<{ count: number }>();
    if (Number(open?.count ?? 0) > 0) {
      throw new ValidationError("Confirm the terminal transition while the Project has open Tasks");
    }
  }
  const archivedAt = Object.hasOwn(input, "archived")
    ? input.archived === true
      ? project.archivedAt ?? new Date().toISOString()
      : input.archived === false
        ? null
        : (() => { throw new ValidationError("Archived must be true or false"); })()
    : project.archivedAt ?? null;
  const now = new Date().toISOString();

  try {
    const result = await getD1().prepare(
      `UPDATE projects SET
         name = ?, task_code = ?, summary = ?, description = ?, status = ?,
         lead_user_id = ?, start_date = ?, target_date = ?, icon = ?, color = ?,
         archived_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?
         AND (
           owner_user_id = ? OR EXISTS (
             SELECT 1 FROM access_grants actor_grant
             WHERE actor_grant.resource_type = 'project'
               AND actor_grant.resource_id = projects.id
               AND actor_grant.grantee_user_id = ?
               AND actor_grant.revoked_at IS NULL
               AND actor_grant.permission IN ('editor', 'manager', 'full_access')
           )
         )
         AND (
           ? IS NULL OR owner_user_id = ? OR EXISTS (
             SELECT 1 FROM access_grants lead_grant
             WHERE lead_grant.resource_type = 'project'
               AND lead_grant.resource_id = projects.id
               AND lead_grant.grantee_user_id = ?
               AND lead_grant.revoked_at IS NULL
           )
         )`,
    ).bind(
      name,
      taskCode,
      summary,
      description,
      status,
      leadUserId,
      startDate,
      targetDate,
      icon,
      color,
      archivedAt,
      now,
      project.id,
      expectedVersion,
      currentUser.id,
      currentUser.id,
      leadUserId,
      leadUserId,
      leadUserId,
    ).run();
    if ((result.meta.changes ?? 0) < 1) {
      throw new ConflictError("Project access, lead, or version changed before the update committed");
    }
  } catch (error) {
    if (error instanceof ConflictError || error instanceof ValidationError) throw error;
    if (error instanceof Error && /locked Project task code/i.test(error.message)) {
      throw new ConflictError("Project code was locked before the update committed");
    }
    if (error instanceof Error && /task_code|unique/i.test(error.message)) {
      throw new ValidationError("Project code is already in use");
    }
    throw error;
  }
  return loadAccessibleProject(currentUser.id, project.id);
}

export async function createRelease(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<ReleaseRecord> {
  if (!input.projectId) throw new ValidationError("Project is required");
  const project = await loadAccessibleProject(
    currentUser.id,
    String(input.projectId),
  );
  requireContentEdit(project.accessRole);
  if (project.archivedAt || project.status === "canceled") {
    throw new ValidationError("Releases require an active Project");
  }
  const now = new Date().toISOString();
  const id = `release_${crypto.randomUUID()}`;
  const status = releaseStatus(input.status ?? "planned");
  await getD1()
    .prepare(
      `INSERT INTO releases
        (id, public_id, project_id, owner_user_id, creator_user_id, name, description,
         status, target_date, released_at, release_notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      crypto.randomUUID(),
      project.id,
      project.ownerUserId,
      currentUser.id,
      requireTitle(input.name),
      optionalText(input.description),
      status,
      optionalDate(input.targetDate),
      status === "released" ? now : null,
      optionalText(input.releaseNotes),
      now,
      now,
    )
    .run();
  return loadAccessibleRelease(currentUser.id, id);
}

export async function updateRelease(
  currentUser: UserRecord,
  releaseId: string,
  input: Record<string, unknown>,
): Promise<ReleaseRecord> {
  const release = await loadAccessibleRelease(currentUser.id, releaseId);
  requireContentEdit(release.accessRole);
  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== release.version) {
    throw new ConflictError("Release was changed in another session");
  }

  const name = Object.hasOwn(input, "name")
    ? requireTitle(input.name)
    : release.name;
  const description = Object.hasOwn(input, "description")
    ? optionalText(input.description)
    : release.description;
  const status = Object.hasOwn(input, "status")
    ? releaseStatus(input.status)
    : release.status;
  const targetDate = Object.hasOwn(input, "targetDate")
    ? optionalDate(input.targetDate)
    : release.targetDate;
  const releaseNotes = Object.hasOwn(input, "releaseNotes")
    ? optionalText(input.releaseNotes)
    : release.releaseNotes;
  const enteringReleased = status === "released" && release.status !== "released";
  if (enteringReleased && input.confirmOpenTasks !== true) {
    const open = await getD1().prepare(
      `SELECT COUNT(*) AS count
       FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
       WHERE t.release_id = ? AND t.archived_at IS NULL
         AND s.category NOT IN ('completed', 'canceled')`,
    ).bind(release.id).first<{ count: number }>();
    if (Number(open?.count ?? 0) > 0) {
      throw new ValidationError("Confirm the terminal transition while the Release has open Tasks");
    }
  }

  const now = new Date().toISOString();
  const releasedAt = status === "released"
    ? release.releasedAt ?? now
    : null;
  const confirmedOpenTasks = input.confirmOpenTasks === true ? 1 : 0;
  const result = await getD1().prepare(
    `UPDATE releases SET
       name = ?, description = ?, status = ?, target_date = ?, released_at = ?,
       release_notes = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ?
       AND (
         ? = 0 OR ? = 1 OR status = 'released' OR NOT EXISTS (
           SELECT 1 FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
           WHERE t.release_id = releases.id AND t.archived_at IS NULL
             AND s.category NOT IN ('completed', 'canceled')
         )
       )
       AND EXISTS (
         SELECT 1 FROM projects p WHERE p.id = releases.project_id AND (
           p.owner_user_id = ? OR EXISTS (
             SELECT 1 FROM access_grants ag
             WHERE ag.resource_type = 'project' AND ag.resource_id = p.id
               AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
               AND ag.permission IN ('editor', 'manager', 'full_access')
           )
         )
       )`,
  ).bind(
    name,
    description,
    status,
    targetDate,
    releasedAt,
    releaseNotes,
    now,
    release.id,
    expectedVersion,
    enteringReleased ? 1 : 0,
    confirmedOpenTasks,
    currentUser.id,
    currentUser.id,
  ).run();
  if ((result.meta.changes ?? 0) < 1) {
    throw new ConflictError("Release access, open Tasks, or version changed before the update committed");
  }
  return loadAccessibleRelease(currentUser.id, release.id);
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
  await validateSavedViewReferences(currentUser, query, project);
  const id = `view_${crypto.randomUUID()}`;
  await getD1()
    .prepare(
      `INSERT INTO saved_views
        (id, public_id, owner_user_id, name, scope_project_id, query_json, display_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      crypto.randomUUID(),
      project?.ownerUserId ?? currentUser.id,
      requireTitle(input.name),
      project?.id ?? null,
      JSON.stringify(query),
      JSON.stringify(display),
    )
    .run();
  return loadAccessibleView(currentUser.id, id);
}

export async function updateSavedView(
  currentUser: UserRecord,
  viewId: string,
  input: Record<string, unknown>,
) {
  const view = await loadAccessibleView(currentUser.id, viewId);
  requireContentEdit(view.accessRole);
  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== view.version) {
    throw new ConflictError("Saved View version changed before the update");
  }

  const scopeChanged = Object.hasOwn(input, "scopeProjectId") &&
    (input.scopeProjectId ? String(input.scopeProjectId) : null) !== view.scopeProjectId;
  if (scopeChanged && view.accessRole !== "owner") {
    throw new PermissionError("Only the owner can move a Saved View between scopes");
  }
  const nextScopeProject = Object.hasOwn(input, "scopeProjectId")
    ? input.scopeProjectId
      ? await loadAccessibleProject(currentUser.id, String(input.scopeProjectId))
      : null
    : view.scopeProjectId
      ? await loadAccessibleProject(currentUser.id, view.scopeProjectId)
      : null;
  if (nextScopeProject) requireContentEdit(nextScopeProject.accessRole);

  const name = Object.hasOwn(input, "name") ? requireTitle(input.name) : view.name;
  const query = Object.hasOwn(input, "query")
    ? validateViewQuery(input.query)
    : view.query;
  const display = Object.hasOwn(input, "display")
    ? validateViewDisplay(input.display)
    : view.display;
  await validateSavedViewReferences(currentUser, query, nextScopeProject);
  const archivedAt = Object.hasOwn(input, "archived")
    ? input.archived === true
      ? view.archivedAt ?? new Date().toISOString()
      : input.archived === false
        ? null
        : (() => { throw new ValidationError("Saved View archived must be boolean"); })()
    : view.archivedAt;
  const ownerUserId = nextScopeProject?.ownerUserId ??
    (scopeChanged && !nextScopeProject ? currentUser.id : view.ownerUserId);
  const now = new Date().toISOString();
  const result = await getD1().prepare(
    `UPDATE saved_views SET
       owner_user_id = ?, name = ?, scope_project_id = ?, query_json = ?,
       display_json = ?, archived_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ? AND (
       (scope_project_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM projects p WHERE p.id = saved_views.scope_project_id AND (
           p.owner_user_id = ? OR EXISTS (
             SELECT 1 FROM access_grants ag
             WHERE ag.resource_type = 'project' AND ag.resource_id = p.id
               AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
               AND ag.permission IN ('editor', 'manager', 'full_access')
           )
         )
       )) OR (scope_project_id IS NULL AND (
         owner_user_id = ? OR EXISTS (
           SELECT 1 FROM access_grants ag
           WHERE ag.resource_type = 'saved_view' AND ag.resource_id = saved_views.id
             AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
             AND ag.permission IN ('editor', 'full_access')
         )
       ))
     )`,
  ).bind(
    ownerUserId,
    name,
    nextScopeProject?.id ?? null,
    JSON.stringify(query),
    JSON.stringify(display),
    archivedAt,
    now,
    view.id,
    expectedVersion,
    currentUser.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
  ).run();
  if ((result.meta.changes ?? 0) < 1) {
    throw new ConflictError("Saved View access, scope, or version changed before the update committed");
  }
  return loadAccessibleView(currentUser.id, view.id);
}

async function validateSavedViewReferences(
  currentUser: UserRecord,
  query: ViewQuery,
  scopeProject: ProjectRecord | null,
) {
  const canonical = canonicalViewQuery(query);
  const snapshot = await getSnapshot(currentUser);
  const projectIds = filterReferenceValues(canonical.conditions, "project");
  const releaseIds = filterReferenceValues(canonical.conditions, "release");
  const statusIds = filterReferenceValues(canonical.conditions, "status");
  const assigneeIds = filterReferenceValues(canonical.conditions, "assignee");
  const labelIds = filterReferenceValues(canonical.conditions, "label");
  const parentIds = filterReferenceValues(canonical.conditions, "parent");

  if (scopeProject && projectIds.some((projectId) => projectId !== scopeProject.id)) {
    throw new ValidationError("A project-scoped Saved View cannot filter outside its Project");
  }
  if (projectIds.some(
    (projectId) => !snapshot.projects.some((project) => project.id === projectId),
  )) {
    throw new ValidationError("Saved View project filter is inaccessible");
  }
  const releases = releaseIds.map((releaseId) =>
    snapshot.releases.find((item) => item.id === releaseId));
  if (releases.some((release) => !release)) {
    throw new ValidationError("Saved View release filter is inaccessible");
  }
  if (scopeProject && releases.some((release) => release?.projectId !== scopeProject.id)) {
    throw new ValidationError("Saved View release must belong to its scoped Project");
  }
  if (projectIds.length === 1 && releases.some(
    (release) => release?.projectId !== projectIds[0],
  )) {
    throw new ValidationError("Saved View release does not belong to its Project filter");
  }
  if (statusIds.some(
    (statusId) => !snapshot.statuses.some((status) => status.id === statusId),
  )) {
    throw new ValidationError("Saved View status filter is inaccessible");
  }
  if (assigneeIds.some(
    (userId) => !snapshot.users.some((user) => user.id === userId),
  )) {
    throw new ValidationError("Saved View assignee filter is inaccessible");
  }
  if (labelIds.some(
    (labelId) => !snapshot.labels.some((label) => label.id === labelId),
  )) {
    throw new ValidationError("Saved View label filter is inaccessible");
  }
  for (const taskId of parentIds) {
    try {
      await loadAccessibleTask(currentUser.id, taskId);
    } catch {
      throw new ValidationError("Saved View parent filter is inaccessible");
    }
  }
}

async function validateTaskFilterReferences(
  currentUser: UserRecord,
  query: ViewQuery,
  scopeProject: ProjectRecord | null,
) {
  const conditions = canonicalViewQuery(query).conditions;
  const projectIds = filterReferenceValues(conditions, "project");
  const releaseIds = filterReferenceValues(conditions, "release");
  const statusIds = filterReferenceValues(conditions, "status");
  const assigneeIds = filterReferenceValues(conditions, "assignee");
  const labelIds = filterReferenceValues(conditions, "label");
  const parentIds = filterReferenceValues(conditions, "parent");

  if (scopeProject && projectIds.some((projectId) => projectId !== scopeProject.id)) {
    throw new ValidationError("A project-scoped Saved View cannot filter outside its Project");
  }

  let projects: ProjectRecord[];
  let releases: ReleaseRecord[];
  try {
    [projects, releases] = await Promise.all([
      Promise.all(projectIds.map((id) => loadAccessibleProject(currentUser.id, id))),
      Promise.all(releaseIds.map((id) => loadAccessibleRelease(currentUser.id, id))),
    ]);
  } catch {
    throw new ValidationError("Task filter reference is inaccessible");
  }
  if (scopeProject && releases.some((release) => release.projectId !== scopeProject.id)) {
    throw new ValidationError("Saved View release must belong to its scoped Project");
  }
  if (projects.length === 1 && releases.some(
    (release) => release.projectId !== projects[0]!.id,
  )) {
    throw new ValidationError("Saved View release does not belong to its Project filter");
  }

  const db = getD1();
  const checks: Array<{
    ids: string[];
    statement: D1PreparedStatement;
    message: string;
  }> = [];
  if (statusIds.length) {
    checks.push({
      ids: statusIds,
      message: "Saved View status filter is inaccessible",
      statement: db.prepare(
        `SELECT s.id FROM workflow_statuses s
         WHERE s.id IN (${filterPlaceholders(statusIds.length)}) AND (
           s.owner_user_id = ? OR EXISTS (
             SELECT 1 FROM projects p
             WHERE p.owner_user_id = s.owner_user_id AND (
               p.owner_user_id = ? OR EXISTS (
                 SELECT 1 FROM access_grants ag
                 WHERE ag.resource_type = 'project' AND ag.resource_id = p.id
                   AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
               )
             )
           )
         )`,
      ).bind(...statusIds, currentUser.id, currentUser.id, currentUser.id),
    });
  }
  if (assigneeIds.length) {
    checks.push({
      ids: assigneeIds,
      message: "Saved View assignee filter is inaccessible",
      statement: db.prepare(
        `SELECT u.id FROM users u
         WHERE u.id IN (${filterPlaceholders(assigneeIds.length)}) AND (
           u.id = ? OR EXISTS (
             SELECT 1 FROM projects p
             WHERE (p.owner_user_id = ? OR EXISTS (
               SELECT 1 FROM access_grants actor_grant
               WHERE actor_grant.resource_type = 'project'
                 AND actor_grant.resource_id = p.id
                 AND actor_grant.grantee_user_id = ?
                 AND actor_grant.revoked_at IS NULL
             )) AND (p.owner_user_id = u.id OR EXISTS (
               SELECT 1 FROM access_grants member_grant
               WHERE member_grant.resource_type = 'project'
                 AND member_grant.resource_id = p.id
                 AND member_grant.grantee_user_id = u.id
                 AND member_grant.revoked_at IS NULL
             ))
           )
         )`,
      ).bind(...assigneeIds, currentUser.id, currentUser.id, currentUser.id),
    });
  }
  if (labelIds.length) {
    checks.push({
      ids: labelIds,
      message: "Saved View label filter is inaccessible",
      statement: db.prepare(
        `SELECT l.id FROM labels l
         WHERE l.id IN (${filterPlaceholders(labelIds.length)}) AND (
           l.owner_user_id = ? OR EXISTS (
             SELECT 1 FROM projects p
             WHERE p.owner_user_id = l.owner_user_id AND (
               p.owner_user_id = ? OR EXISTS (
                 SELECT 1 FROM access_grants ag
                 WHERE ag.resource_type = 'project' AND ag.resource_id = p.id
                   AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
               )
             )
           )
         )`,
      ).bind(...labelIds, currentUser.id, currentUser.id, currentUser.id),
    });
  }
  if (checks.length) {
    const results = await db.batch<DbRow>(checks.map((check) => check.statement));
    results.forEach((result, index) => {
      const check = checks[index]!;
      if (new Set(result.results.map((row) => String(row.id))).size !== check.ids.length) {
        throw new ValidationError(check.message);
      }
    });
  }
  for (const taskId of parentIds) {
    try {
      await loadAccessibleTask(currentUser.id, taskId);
    } catch {
      throw new ValidationError("Saved View parent filter is inaccessible");
    }
  }
}

function filterPlaceholders(length: number) {
  return Array.from({ length }, () => "?").join(", ");
}

function filterReferenceValues(
  conditions: ViewFilterCondition[],
  field: ViewFilterCondition["field"],
) {
  return [...new Set(conditions
    .filter((condition) => condition.field === field && condition.operator !== "is_empty")
    .flatMap((condition) => Array.isArray(condition.value)
      ? condition.value
      : typeof condition.value === "string"
        ? [condition.value]
        : []))];
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
    grant.resourceType === "project"
      ? db.prepare(
        `UPDATE projects SET lead_user_id = NULL,
           version = version + 1, updated_at = ?
         WHERE id = ? AND lead_user_id = ?`,
      ).bind(now, grant.resourceId, grant.granteeUserId)
      : db.prepare("SELECT 1"),
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
  const codeConflict = await getD1()
    .prepare(
      `SELECT id FROM projects
       WHERE owner_user_id = ? AND task_code = ? AND archived_at IS NULL
         AND id <> ? LIMIT 1`,
    )
    .bind(targetUserId, project.taskCode, project.id)
    .first();
  if (codeConflict) {
    throw new ValidationError("The new owner already has a Project with this code");
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

function assertReleasedCompositionChange(
  currentRelease: ReleaseRecord | null,
  nextRelease: ReleaseRecord | null,
  input: Record<string, unknown>,
) {
  if (currentRelease?.id === nextRelease?.id) return;
  if (
    (currentRelease?.status === "released" || nextRelease?.status === "released")
    && input.confirmReleasedComposition !== true
  ) {
    throw new ValidationError("Confirm changing the composition of a released Release");
  }
}

async function loadStatus(
  ownerUserId: string,
  statusId: string | null,
  options: { allowArchived?: boolean } = {},
) {
  const row = statusId
    ? await getD1()
        .prepare(
          `SELECT * FROM workflow_statuses
           WHERE id = ? AND owner_user_id = ?${options.allowArchived ? "" : " AND archived_at IS NULL"}`,
        )
        .bind(statusId, ownerUserId)
        .first<DbRow>()
    : await getD1()
        .prepare(
          `SELECT * FROM workflow_statuses
           WHERE owner_user_id = ? AND archived_at IS NULL
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
    attachmentCount: Number(row.attachment_count ?? 0),
    attachmentBytes: Number(row.attachment_bytes ?? 0),
    pendingAttachmentCount: Number(row.pending_attachment_count ?? 0),
    failedAttachmentCount: Number(row.failed_attachment_count ?? 0),
    deletedAttachmentCount: Number(row.deleted_attachment_count ?? 0),
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
    systemRole: row.system_role === "duplicate" ? "duplicate" : null,
    archivedAt: nullableString(row.archived_at),
    version: Number(row.version ?? 1),
  };
}

function mapProject(row: DbRow): ProjectRecord {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    ownerUserId: String(row.owner_user_id),
    creatorUserId: String(row.creator_user_id),
    name: String(row.name),
    taskCode: String(row.task_code),
    taskSequence: Number(row.task_sequence),
    codeLockedAt: nullableString(row.code_locked_at),
    summary: String(row.summary ?? ""),
    description: String(row.description ?? ""),
    status: String(row.status) as ProjectStatus,
    leadUserId: nullableString(row.lead_user_id),
    startDate: nullableString(row.start_date),
    targetDate: nullableString(row.target_date),
    icon: String(row.icon ?? "cube"),
    color: String(row.color),
    archivedAt: nullableString(row.archived_at),
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
    projectId: String(row.project_id),
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
    description: String(row.description ?? ""),
    archivedAt: nullableString(row.archived_at),
    version: Number(row.version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at ?? row.created_at),
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
    id: String(row.id),
    sourceTaskId: String(row.source_task_id),
    targetTaskId: String(row.target_task_id),
    type: String(row.type) as TaskRelationRecord["type"],
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
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
    commentMigration: {
      migrated: Number(row.comments_migrated ?? 0),
      exceptions: Number(row.comment_exceptions ?? 0),
    },
    activityMigration: {
      migrated: Number(row.activity_migrated ?? 0),
      exceptions: Number(row.activity_exceptions ?? 0),
    },
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
    archivedAt: nullableString(row.archived_at),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
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

function projectTaskCode(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError("Project code is required");
  }
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(code)) {
    throw new ValidationError("Project code must use 2 or 3 Latin letters");
  }
  return code;
}

function projectStatus(value: unknown): ProjectStatus {
  if (
    value !== "planned"
    && value !== "active"
    && value !== "paused"
    && value !== "completed"
    && value !== "canceled"
  ) {
    throw new ValidationError("Unknown Project status");
  }
  return value;
}

function releaseStatus(value: unknown): ReleaseStatus {
  if (
    value !== "planned"
    && value !== "active"
    && value !== "released"
    && value !== "canceled"
  ) {
    throw new ValidationError("Unknown Release status");
  }
  return value;
}

function projectIcon(value: unknown): string {
  if (value !== "cube" && value !== "folder" && value !== "target" && value !== "rocket") {
    throw new ValidationError("Unknown Project icon");
  }
  return value;
}

function projectColor(value: unknown): string {
  const color = String(value ?? "").trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) {
    throw new ValidationError("Project color must be a six-digit hex color");
  }
  return color;
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
