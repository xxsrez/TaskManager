import { isAdminEmail } from "./admin";
import { getAdminOverview } from "./repository-admin";
import {
  accessibleTaskWhere,
  projectAccessRoleSql,
  projectEffectiveRoleRankSql,
  savedViewAccessRoleSql,
  savedViewEffectiveRoleRankSql,
  taskAccessRoleSql,
  taskEffectiveRoleRankSql,
} from "./access-sql";
import { ValidationError } from "./domain";
import { getRuntimeEnvironment } from "./runtime-environment";
import {
  encodeWorkspaceSyncCursor,
  teamAccessFingerprintFromRows,
  teamAccessFingerprintSql,
  type TeamAccessFingerprintRow,
} from "./workspace-sync-cursor";
import {
  decodeKeysetCursor,
  digestReference,
  encodeKeysetCursor,
} from "./agent-api-contract";
import {
  ALL_ACCESSIBLE_WORKSPACE_SCOPE,
  opaqueWorkspaceOwnerToken,
  parseWorkspaceScopeToken,
  resolveWorkspaceScopeMembership,
  workspaceScopeContextLabel,
} from "./workspace-scope";
import {
  loadLabelGroupsForLabels,
  mapCollaborator,
  mapLabel,
  mapLabelGroup,
  mapProject,
  mapRelation,
  mapRelease,
  mapStatus,
  mapTask,
  mapTaskLabel,
  mapUser,
  mapUserIdentity,
  mapView,
  type DbRow,
} from "./repository-mappers";
import type {
  AppSnapshot,
  LabelGroupRecord,
  LabelRecord,
  ProjectRecord,
  ReleaseRecord,
  SavedViewRecord,
  TaskRecord,
  TaskLabelAssignment,
  UserProfile,
  UserRecord,
  WorkspaceCatalogKind,
  WorkspaceCatalogPage,
  WorkspaceScopeDescriptor,
  WorkspaceScopeState,
  WorkspaceMetrics,
} from "./types";
import { getD1 } from "@/db";

function sqlPlaceholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

export const MAX_UI_SNAPSHOT_TASKS = 2_000;
export const INITIAL_UI_SNAPSHOT_TASKS = 40;

export type ResolvedWorkspaceScope = {
  ownerUserId: string | null;
  selectedToken: string;
  currentToken: string;
  fallback: boolean;
};

export async function resolveWorkspaceScope(
  user: UserRecord,
  requested: string | null | undefined,
): Promise<ResolvedWorkspaceScope | null> {
  // Undefined is the compatibility boundary for repository and Agent callers:
  // their existing ACL union remains unchanged. UI routes pass null explicitly.
  if (requested === undefined) return null;
  const currentToken = await opaqueWorkspaceOwnerToken(user.id);
  if (requested === null || requested === "") {
    return {
      ownerUserId: user.id,
      selectedToken: currentToken,
      currentToken,
      fallback: false,
    };
  }
  const parsed = parseWorkspaceScopeToken(requested);
  if (parsed?.kind === "all") {
    return {
      ownerUserId: null,
      selectedToken: ALL_ACCESSIBLE_WORKSPACE_SCOPE,
      currentToken,
      fallback: false,
    };
  }
  if (parsed?.kind === "owner" && parsed.token === currentToken) {
    return {
      ownerUserId: user.id,
      selectedToken: currentToken,
      currentToken,
      fallback: false,
    };
  }
  return {
    ownerUserId: user.id,
    selectedToken: currentToken,
    currentToken,
    fallback: true,
  };
}

export async function resolveUiWorkspaceScope(
  user: UserRecord,
  requested: string | null,
) {
  const resolved = await resolveWorkspaceScope(user, requested);
  if (!resolved) throw new Error("UI workspace scope was not resolved");
  return {
    ownerUserId: resolved.ownerUserId,
    selectedToken: resolved.selectedToken,
    fallback: resolved.fallback,
  };
}

export async function getWorkspaceTaskMetrics(
  user: UserRecord,
  ownerUserId: string | null,
): Promise<WorkspaceMetrics> {
  const scope: ResolvedWorkspaceScope = {
    ownerUserId,
    selectedToken: "",
    currentToken: "",
    fallback: false,
  };
  const predicate = workspacePredicate("workspace_owner_user_id", scope);
  const row = await getD1().prepare(
    `WITH scoped AS (
       SELECT t.archived_at, t.assignee_user_id, s.category,
         CASE WHEN t.project_id IS NOT NULL THEN p.owner_user_id
           ELSE t.owner_user_id END AS workspace_owner_user_id,
         ${taskAccessRoleSql("t", "p")} AS access_role
       FROM tasks t
       JOIN workflow_statuses s ON s.id = t.status_id
       LEFT JOIN projects p ON p.id = t.project_id
     )
     SELECT
       SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS all_count,
       SUM(CASE WHEN archived_at IS NULL
         AND category IN ('unstarted', 'started') THEN 1 ELSE 0 END) AS active_count,
       SUM(CASE WHEN archived_at IS NULL AND category = 'backlog'
         THEN 1 ELSE 0 END) AS backlog_count,
       SUM(CASE WHEN archived_at IS NULL AND assignee_user_id = ?
         THEN 1 ELSE 0 END) AS mine_count,
       SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived_count
     FROM scoped WHERE access_role IS NOT NULL AND ${predicate.sql}`,
  ).bind(
    user.id,
    user.id,
    user.id,
    user.id,
    user.id,
    ...predicate.parameters,
  ).first<DbRow>();
  return {
    taskCounts: {
      all: Number(row?.all_count ?? 0),
      active: Number(row?.active_count ?? 0),
      backlog: Number(row?.backlog_count ?? 0),
      mine: Number(row?.mine_count ?? 0),
      archived: Number(row?.archived_count ?? 0),
    },
  };
}

async function workspaceScopeDescriptors(
  user: UserRecord,
): Promise<WorkspaceScopeDescriptor[]> {
  const current = {
    token: await opaqueWorkspaceOwnerToken(user.id),
    kind: "owner" as const,
    label: "My",
    current: true,
  };
  return [
    current,
    {
      token: ALL_ACCESSIBLE_WORKSPACE_SCOPE,
      kind: "all" as const,
      label: "All accessible",
      current: false,
    },
  ];
}

async function workspaceScopeState(
  user: UserRecord,
  scope: ResolvedWorkspaceScope,
): Promise<WorkspaceScopeState> {
  const options = await workspaceScopeDescriptors(user);
  const membership = resolveWorkspaceScopeMembership(
    scope.selectedToken,
    options,
    scope.currentToken,
  );
  return {
    selectedToken: membership.token,
    selectedLabel: workspaceScopeContextLabel(membership.token, options),
    fallback: scope.fallback || membership.fallback,
    options,
  };
}

export function workspacePredicate(
  expression: string,
  scope: ResolvedWorkspaceScope | null,
): { sql: string; parameters: string[] } {
  if (!scope?.ownerUserId) return { sql: "1 = 1", parameters: [] };
  return { sql: `${expression} = ?`, parameters: [scope.ownerUserId] };
}

function workspaceCatalogOwnerPredicate(
  expression: string,
  userId: string,
  scope: ResolvedWorkspaceScope | null,
) {
  if (!scope) return { sql: `${expression} = ?`, parameters: [userId] };
  if (scope.ownerUserId) {
    return { sql: `${expression} = ?`, parameters: [scope.ownerUserId] };
  }
  return {
    sql: `EXISTS (
      SELECT 1 FROM (SELECT ? AS user_id) catalog_actor
      WHERE ${expression} = catalog_actor.user_id OR EXISTS (
      SELECT 1 FROM projects catalog_project
      WHERE catalog_project.deleted_at IS NULL
        AND catalog_project.owner_user_id = ${expression}
        AND ${projectEffectiveRoleRankSql(
          "catalog_project",
          "catalog_actor.user_id",
        )} > 0
    ) OR EXISTS (
      SELECT 1 FROM tasks catalog_task
      LEFT JOIN projects catalog_task_project
        ON catalog_task_project.id = catalog_task.project_id
      WHERE catalog_task.deleted_at IS NULL
        AND (catalog_task.project_id IS NULL
          OR catalog_task_project.deleted_at IS NULL)
        AND CASE WHEN catalog_task.project_id IS NOT NULL
          THEN catalog_task_project.owner_user_id
          ELSE catalog_task.owner_user_id END = ${expression}
        AND ${taskEffectiveRoleRankSql(
          "catalog_task",
          "catalog_task_project",
          "catalog_actor.user_id",
        )} > 0
    ))`,
    parameters: [userId],
  };
}

function snapshotTaskIdScopeCte(scope: ResolvedWorkspaceScope | null) {
  const predicate = workspacePredicate("workspace_owner_user_id", scope);
  return `WITH scoped_task_ids AS (
  SELECT t.id, t.updated_at,
    CASE WHEN t.project_id IS NOT NULL THEN p.owner_user_id
      ELSE t.owner_user_id END AS workspace_owner_user_id,
    CASE WHEN ${taskAccessRoleSql("t", "p")} IS NOT NULL
      THEN 1 ELSE 0 END AS is_visible
  FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
  WHERE t.deleted_at IS NULL
    AND (t.project_id IS NULL OR p.deleted_at IS NULL)
), visible_task_ids AS (
  SELECT id FROM scoped_task_ids WHERE is_visible = 1 AND ${predicate.sql}
  ORDER BY updated_at DESC, id DESC LIMIT ?
)`;
}

export const snapshotTaskProjection = `
  t.id, t.public_id, t.owner_user_id, t.creator_user_id,
  t.identifier, t.sequence_number, t.title, NULL AS description,
  t.status_id, t.priority, t.assignee_user_id, t.project_id,
  CASE WHEN t.release_id IS NULL OR EXISTS (
    SELECT 1 FROM releases active_release
    WHERE active_release.id = t.release_id AND active_release.deleted_at IS NULL
  ) THEN t.release_id ELSE NULL END AS release_id,
  t.estimate, t.due_date,
  CASE WHEN t.parent_task_id IS NULL OR EXISTS (
    SELECT 1 FROM tasks active_parent
    JOIN projects active_parent_project ON active_parent_project.id = active_parent.project_id
    WHERE active_parent.id = t.parent_task_id
      AND active_parent.deleted_at IS NULL
      AND active_parent_project.deleted_at IS NULL
  ) THEN t.parent_task_id ELSE NULL END AS parent_task_id,
  t.rank,
  t.started_at, t.completed_at, t.canceled_at, t.archived_at,
  t.comment_count, t.deleted_at, t.deleted_by_user_id, t.purge_after,
  t.version, t.created_at, t.updated_at`;

export async function getSnapshot(
  user: UserRecord,
  options: {
    includeAdminOverview?: boolean;
    taskLimit?: number;
    navigationLimit?: number;
    workspaceScope?: string | null;
  } = {},
): Promise<AppSnapshot> {
  const db = getD1();
  const workspaceScope = await resolveWorkspaceScope(user, options.workspaceScope);
  const taskWorkspace = workspacePredicate(
    "workspace_owner_user_id",
    workspaceScope,
  );
  const projectWorkspace = workspacePredicate("owner_user_id", workspaceScope);
  const requestedTaskLimit = Number(options.taskLimit ?? MAX_UI_SNAPSHOT_TASKS);
  const taskLimit = Number.isSafeInteger(requestedTaskLimit)
    ? Math.min(MAX_UI_SNAPSHOT_TASKS, Math.max(1, requestedTaskLimit))
    : MAX_UI_SNAPSHOT_TASKS;
  const navigationLimit = options.navigationLimit === undefined
    ? null
    : Math.max(1, Math.trunc(options.navigationLimit));
  const navigationOnly = navigationLimit !== null;
  const navigationQueryLimit = navigationLimit === null ? -1 : navigationLimit + 1;
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
      db.prepare(teamAccessFingerprintSql()).bind(user.id),
      db
        .prepare(
          `WITH scoped AS (
             SELECT ${snapshotTaskProjection},
               CASE WHEN t.project_id IS NOT NULL THEN p.owner_user_id
                 ELSE t.owner_user_id END AS workspace_owner_user_id,
               ${taskAccessRoleSql("t", "p")} AS access_role,
               ${projectAccessRoleSql("p")} AS project_access_role
             FROM tasks t
             LEFT JOIN projects p ON p.id = t.project_id
           )
           SELECT * FROM scoped WHERE access_role IS NOT NULL
             AND ${taskWorkspace.sql}
           ORDER BY updated_at DESC, id DESC
           LIMIT ?`,
        )
        .bind(
          user.id,
          user.id,
          user.id,
          user.id,
          user.id,
          user.id,
          ...taskWorkspace.parameters,
          taskLimit + 1,
        ),
      db
        .prepare(
          `WITH visible_task_project_ids AS (
             SELECT DISTINCT project_id AS id FROM (
               SELECT t.project_id, t.updated_at, t.id
               FROM tasks t
               WHERE t.project_id IS NOT NULL AND ${accessibleTaskWhere("t")}
                 AND ${workspacePredicate(
                   "(SELECT owner_user_id FROM projects WHERE id = t.project_id)",
                   workspaceScope,
                 ).sql}
               ORDER BY t.updated_at DESC, t.id DESC
               LIMIT ?
             )
           ), scoped AS (
             SELECT p.*,
               ${projectAccessRoleSql("p")} AS access_role
             FROM projects p
           ), recent_ids AS (
             SELECT id FROM scoped
             WHERE access_role IS NOT NULL AND archived_at IS NULL
               AND ${projectWorkspace.sql}
             ORDER BY updated_at DESC, id DESC
             LIMIT ?
           )
           SELECT scoped.*,
             (SELECT COUNT(*) FROM scoped counted
              WHERE counted.access_role IS NOT NULL
                AND ${projectWorkspace.sql}
                AND (? = 0 OR counted.archived_at IS NULL)) AS total_count
           FROM scoped
           WHERE access_role IS NOT NULL AND ${projectWorkspace.sql} AND (
             ? = 0 OR id IN (SELECT id FROM recent_ids)
               OR id IN (SELECT id FROM visible_task_project_ids)
           )
           ORDER BY updated_at DESC, id DESC
          `,
        )
        .bind(
          user.id,
          user.id,
          user.id,
          user.id,
          ...workspacePredicate(
            "(SELECT owner_user_id FROM projects WHERE id = t.project_id)",
            workspaceScope,
          ).parameters,
          taskLimit,
          user.id,
          user.id,
          ...projectWorkspace.parameters,
          navigationLimit ?? -1,
          ...projectWorkspace.parameters,
          navigationOnly ? 1 : 0,
          ...projectWorkspace.parameters,
          navigationOnly ? 1 : 0,
        ),
      db
        .prepare(
          `WITH visible_task_release_ids AS (
             SELECT DISTINCT release_id AS id FROM (
               SELECT t.release_id, t.updated_at, t.id
               FROM tasks t
               WHERE t.release_id IS NOT NULL AND ${accessibleTaskWhere("t")}
                 AND ${workspacePredicate(
                   "(SELECT owner_user_id FROM projects WHERE id = t.project_id)",
                   workspaceScope,
                 ).sql}
               ORDER BY t.updated_at DESC, t.id DESC
               LIMIT ?
             )
           ), scoped AS (
             SELECT r.*,
               ${projectAccessRoleSql("p")} AS access_role
             FROM releases r JOIN projects p ON p.id = r.project_id
             WHERE r.deleted_at IS NULL AND p.deleted_at IS NULL
           ), recent_ids AS (
             SELECT id FROM scoped WHERE access_role IS NOT NULL
               AND ${projectWorkspace.sql}
             ORDER BY updated_at DESC, id DESC
             LIMIT ?
           )
           SELECT scoped.*,
             (SELECT COUNT(*) FROM scoped counted
              WHERE counted.access_role IS NOT NULL
                AND ${projectWorkspace.sql}) AS total_count
           FROM scoped WHERE access_role IS NOT NULL AND ${projectWorkspace.sql} AND (
             ? = 0 OR id IN (SELECT id FROM recent_ids)
               OR id IN (SELECT id FROM visible_task_release_ids)
           )
           ORDER BY updated_at DESC, id DESC
          `,
        )
        .bind(
          user.id,
          user.id,
          user.id,
          user.id,
          ...workspacePredicate(
            "(SELECT owner_user_id FROM projects WHERE id = t.project_id)",
            workspaceScope,
          ).parameters,
          taskLimit,
          user.id,
          user.id,
          ...projectWorkspace.parameters,
          navigationLimit ?? -1,
          ...projectWorkspace.parameters,
          ...projectWorkspace.parameters,
          navigationOnly ? 1 : 0,
        ),
      db
        .prepare(
          `WITH scoped AS (
             SELECT v.*,
               CASE WHEN v.scope_project_id IS NOT NULL THEN p.owner_user_id
                 ELSE v.owner_user_id END AS workspace_owner_user_id,
               ${savedViewAccessRoleSql("v", "p")} AS access_role
             FROM saved_views v
             LEFT JOIN projects p ON p.id = v.scope_project_id
           )
           SELECT *, COUNT(*) OVER() AS total_count
           FROM scoped
           WHERE access_role IS NOT NULL AND ${taskWorkspace.sql}
             AND (? = 0 OR archived_at IS NULL)
           ORDER BY updated_at DESC, id DESC
           LIMIT ?`,
        )
        .bind(
          user.id,
          user.id,
          user.id,
          user.id,
          ...taskWorkspace.parameters,
          navigationOnly ? 1 : 0,
          navigationQueryLimit,
        ),
      db
        .prepare(
          `SELECT s.* FROM workflow_statuses s
           CROSS JOIN (SELECT ? AS id) snapshot_actor
           WHERE ((s.owner_user_id = snapshot_actor.id
              OR EXISTS (
                SELECT 1 FROM projects p
                WHERE p.deleted_at IS NULL
                  AND p.owner_user_id = s.owner_user_id
                  AND ${projectEffectiveRoleRankSql(
                    "p",
                    "snapshot_actor.id",
                  )} > 0
              )) AND ${workspacePredicate("s.owner_user_id", workspaceScope).sql})
             OR EXISTS (
                SELECT 1 FROM tasks t
                LEFT JOIN projects p ON p.id = t.project_id
                WHERE t.status_id = s.id
                AND ${taskEffectiveRoleRankSql("t", "p", "snapshot_actor.id")} > 0
                AND t.deleted_at IS NULL
                AND (t.project_id IS NULL OR p.deleted_at IS NULL)
                AND ${workspacePredicate(
                  "CASE WHEN t.project_id IS NOT NULL THEN p.owner_user_id ELSE t.owner_user_id END",
                  workspaceScope,
                ).sql}
              )
           ORDER BY s.owner_user_id, s.position`,
        )
        .bind(
          user.id,
          ...workspacePredicate("s.owner_user_id", workspaceScope).parameters,
          ...workspacePredicate(
            "CASE WHEN t.project_id IS NOT NULL THEN p.owner_user_id ELSE t.owner_user_id END",
            workspaceScope,
          ).parameters,
        ),
      db
        .prepare(
          `SELECT DISTINCT u.id, u.display_name, u.email, u.timezone,
                  u.theme, u.sidebar_preference, u.version
           FROM users u CROSS JOIN (SELECT ? AS id) snapshot_actor
           WHERE u.id = snapshot_actor.id OR EXISTS (
             SELECT 1 FROM projects p
             WHERE p.deleted_at IS NULL
               AND ${projectEffectiveRoleRankSql("p", "snapshot_actor.id")} > 0
               AND ${workspacePredicate("p.owner_user_id", workspaceScope).sql}
               AND ${projectEffectiveRoleRankSql("p", "u.id")} > 0
           ) OR EXISTS (
             SELECT 1 FROM tasks t
             LEFT JOIN projects p ON p.id = t.project_id
             WHERE t.deleted_at IS NULL
               AND (t.project_id IS NULL OR p.deleted_at IS NULL)
               AND ${taskEffectiveRoleRankSql("t", "p", "snapshot_actor.id")} > 0
               AND ${workspacePredicate(
                 "CASE WHEN t.project_id IS NOT NULL THEN p.owner_user_id ELSE t.owner_user_id END",
                 workspaceScope,
               ).sql}
               AND ${taskEffectiveRoleRankSql("t", "p", "u.id")} > 0
           ) ORDER BY u.display_name, u.id`,
        )
        .bind(
          user.id,
          ...workspacePredicate("p.owner_user_id", workspaceScope).parameters,
          ...workspacePredicate(
            "CASE WHEN t.project_id IS NOT NULL THEN p.owner_user_id ELSE t.owner_user_id END",
            workspaceScope,
          ).parameters,
        ),
      db
        .prepare(
          `SELECT ag.id, ag.resource_type, ag.resource_id, ag.permission,
                  u.id AS user_id, u.display_name, u.email
           FROM access_grants ag
           JOIN users u ON u.id = ag.grantee_user_id
           CROSS JOIN (SELECT ? AS id) snapshot_actor
           WHERE ag.revoked_at IS NULL AND (
             (ag.resource_type = 'project' AND EXISTS (
               SELECT 1 FROM projects p
               WHERE p.id = ag.resource_id AND p.deleted_at IS NULL
                 AND ${projectEffectiveRoleRankSql("p", "snapshot_actor.id")} > 0
                 AND ${workspacePredicate("p.owner_user_id", workspaceScope).sql}
             )) OR
             (ag.resource_type = 'task' AND EXISTS (
               SELECT 1 FROM tasks t
               LEFT JOIN projects p ON p.id = t.project_id
               WHERE t.id = ag.resource_id
                 AND t.deleted_at IS NULL
                 AND (t.project_id IS NULL OR p.deleted_at IS NULL)
                 AND ${taskEffectiveRoleRankSql("t", "p", "snapshot_actor.id")} > 0
                 AND ${workspacePredicate(
                   "CASE WHEN t.project_id IS NOT NULL THEN p.owner_user_id ELSE t.owner_user_id END",
                   workspaceScope,
                 ).sql}
             )) OR
             (ag.resource_type = 'saved_view' AND EXISTS (
               SELECT 1 FROM saved_views v
               LEFT JOIN projects p ON p.id = v.scope_project_id
               WHERE v.id = ag.resource_id AND v.scope_project_id IS NULL
                 AND v.deleted_at IS NULL
                 AND ${savedViewEffectiveRoleRankSql(
                   "v",
                   "p",
                   "snapshot_actor.id",
                 )} > 0
                 AND ${workspacePredicate("v.owner_user_id", workspaceScope).sql}
             ))
           )
           ORDER BY ag.created_at DESC`,
        )
        .bind(
          user.id,
          ...workspacePredicate("p.owner_user_id", workspaceScope).parameters,
          ...workspacePredicate(
            "CASE WHEN t.project_id IS NOT NULL THEN p.owner_user_id ELSE t.owner_user_id END",
            workspaceScope,
          ).parameters,
          ...workspacePredicate("v.owner_user_id", workspaceScope).parameters,
        ),
      db
        .prepare(
          `${snapshotTaskIdScopeCte(workspaceScope)}
           SELECT l.* FROM labels l
           WHERE ${workspaceCatalogOwnerPredicate(
             "l.owner_user_id",
             user.id,
             workspaceScope,
           ).sql}
              OR EXISTS (
                SELECT 1 FROM task_labels tl
                JOIN visible_task_ids visible ON visible.id = tl.task_id
                WHERE tl.label_id = l.id
              )
           ORDER BY l.name`,
        )
        .bind(
          ...snapshotTaskScopeParameters(user.id, taskLimit, workspaceScope),
          ...workspaceCatalogOwnerPredicate(
            "l.owner_user_id",
            user.id,
            workspaceScope,
          ).parameters,
        ),
      db
        .prepare(
          `${snapshotTaskIdScopeCte(workspaceScope)}
           SELECT g.* FROM label_groups g
           WHERE ${workspaceCatalogOwnerPredicate(
             "g.owner_user_id",
             user.id,
             workspaceScope,
           ).sql} OR EXISTS (
             SELECT 1 FROM labels l
             JOIN task_labels tl ON tl.label_id = l.id
             JOIN visible_task_ids visible ON visible.id = tl.task_id
             WHERE l.group_id = g.id
           )
           ORDER BY g.position, lower(g.name), g.id`,
        )
        .bind(
          ...snapshotTaskScopeParameters(user.id, taskLimit, workspaceScope),
          ...workspaceCatalogOwnerPredicate(
            "g.owner_user_id",
            user.id,
            workspaceScope,
          ).parameters,
        ),
      db
        .prepare(
          `${snapshotTaskIdScopeCte(workspaceScope)}
           SELECT tl.* FROM task_labels tl
           JOIN visible_task_ids visible ON visible.id = tl.task_id`,
        )
        .bind(...snapshotTaskScopeParameters(user.id, taskLimit, workspaceScope)),
      db
        .prepare(
          `${snapshotTaskIdScopeCte(workspaceScope)}
           SELECT tr.id, tr.source_task_id, tr.target_task_id, tr.type,
             tr.version, tr.created_at, tr.updated_at
           FROM task_relations tr
           JOIN visible_task_ids source_visible
             ON source_visible.id = tr.source_task_id
           JOIN visible_task_ids target_visible
             ON target_visible.id = tr.target_task_id`,
        )
        .bind(...snapshotTaskScopeParameters(user.id, taskLimit, workspaceScope)),
      db
        .prepare(
          `SELECT provider, verified_email
           FROM user_identities WHERE user_id = ?
           ORDER BY provider, provider_account_key`,
        )
        .bind(user.id),
      db
        .prepare(
          `WITH scoped AS (
             SELECT t.archived_at, t.assignee_user_id, s.category,
               CASE WHEN t.project_id IS NOT NULL THEN p.owner_user_id
                 ELSE t.owner_user_id END AS workspace_owner_user_id,
               ${taskAccessRoleSql("t", "p")} AS access_role
             FROM tasks t
             JOIN workflow_statuses s ON s.id = t.status_id
             LEFT JOIN projects p ON p.id = t.project_id
           )
           SELECT
             SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS all_count,
             SUM(CASE WHEN archived_at IS NULL
               AND category IN ('unstarted', 'started') THEN 1 ELSE 0 END) AS active_count,
             SUM(CASE WHEN archived_at IS NULL AND category = 'backlog'
               THEN 1 ELSE 0 END) AS backlog_count,
             SUM(CASE WHEN archived_at IS NULL AND assignee_user_id = ?
               THEN 1 ELSE 0 END) AS mine_count,
             SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived_count
           FROM scoped WHERE access_role IS NOT NULL AND ${taskWorkspace.sql}`,
        )
        .bind(
          user.id,
          user.id,
          user.id,
          user.id,
          user.id,
          ...taskWorkspace.parameters,
        ),
    ]),
    isAdmin && options.includeAdminOverview
      ? getAdminOverview(user, configuredAdminEmails)
      : Promise.resolve(null),
  ]);

  const [
    syncState,
    teamAccessRoutes,
    tasks,
    projects,
    releases,
    views,
    statuses,
    users,
    collaborators,
    labels,
    labelGroups,
    taskLabels,
    relations,
    identities,
    workspaceMetrics,
  ] = snapshotResults;
  const teamAccessFingerprint = await teamAccessFingerprintFromRows(
    teamAccessRoutes.results as unknown as TeamAccessFingerprintRow[],
  );

  const boundedTaskRows = tasks.results.slice(0, taskLimit);
  const boundedTaskIds = new Set(boundedTaskRows.map((row) => String(row.id)));
  const boundedTaskLabels = taskLabels.results.filter((row) =>
    boundedTaskIds.has(String(row.task_id)),
  );
  const boundedLabelIds = new Set(boundedTaskLabels.map((row) => String(row.label_id)));
  const projectRecords = projects.results.map(mapProject);
  const releaseRecords = releases.results.map(mapRelease);
  const viewRecords = collectionRows(views.results, navigationLimit).map(mapView);
  const navigationProjectRecords = recentNavigationRecords(projectRecords, navigationLimit);
  const navigationReleaseRecords = recentNavigationRecords(releaseRecords, navigationLimit);
  const navigationViewRecords = recentNavigationRecords(viewRecords, navigationLimit);
  const resolvedWorkspaceScope = workspaceScope
    ? await workspaceScopeState(user, workspaceScope)
    : undefined;
  const metrics = workspaceMetrics.results[0] ?? {};

  return {
    user,
    userProfile: {
      user: user as UserProfile["user"],
      identities: identities.results.map(mapUserIdentity),
    },
    isAdmin,
    admin,
    users: users.results.map(mapUser),
    statuses: statuses.results.map(mapStatus),
    projects: projectRecords,
    releases: releaseRecords,
    tasks: boundedTaskRows.map(mapTask),
    taskWindow: { limit: taskLimit, truncated: tasks.results.length > taskLimit },
    labels: labels.results
      .filter((row) => workspaceScope || String(row.owner_user_id) === user.id || boundedLabelIds.has(String(row.id)))
      .map(mapLabel),
    labelGroups: labelGroups.results.map(mapLabelGroup),
    taskLabels: boundedTaskLabels.map(mapTaskLabel),
    relations: relations.results
      .filter((row) => boundedTaskIds.has(String(row.source_task_id)) && boundedTaskIds.has(String(row.target_task_id)))
      .map(mapRelation),
    views: viewRecords,
    ...(resolvedWorkspaceScope ? { workspaceScope: resolvedWorkspaceScope } : {}),
    ...(workspaceScope ? {
      workspaceMetrics: {
        taskCounts: {
          all: Number(metrics.all_count ?? 0),
          active: Number(metrics.active_count ?? 0),
          backlog: Number(metrics.backlog_count ?? 0),
          mine: Number(metrics.mine_count ?? 0),
          archived: Number(metrics.archived_count ?? 0),
        },
      },
    } : {}),
    navigationCollections: {
      projects: {
        items: navigationProjectRecords,
        ...navigationCollectionState(projects.results, navigationLimit),
      },
      releases: {
        items: navigationReleaseRecords,
        ...navigationCollectionState(releases.results, navigationLimit),
      },
      views: {
        items: navigationViewRecords,
        ...navigationCollectionState(views.results, navigationLimit),
      },
    },
    catalogCoverage: {
      projects: navigationOnly ? "bounded" : "complete",
      releases: navigationOnly ? "bounded" : "complete",
      views: navigationOnly ? "bounded" : "complete",
    },
    collaborators: collaborators.results.map(mapCollaborator),
    syncCursor: encodeWorkspaceSyncCursor(
      Number((syncState.results[0] as DbRow | undefined)?.last_sequence ?? 0),
      teamAccessFingerprint,
    ),
  };
}

export async function getWorkspaceCatalogPage(
  currentUser: UserRecord,
  input: {
    kind: WorkspaceCatalogKind;
    search?: string | null;
    cursor?: string | null;
    limit?: number;
    activeOnly?: boolean;
    order?: "updated" | "name";
    direction?: "asc" | "desc";
    workspaceScope?: string | null;
  },
): Promise<WorkspaceCatalogPage> {
  const workspaceScope = await resolveWorkspaceScope(currentUser, input.workspaceScope);
  const kind = input.kind;
  const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 30)));
  const search = String(input.search ?? "").trim().toLocaleLowerCase();
  const order = input.order ?? "updated";
  const direction = input.direction ?? (order === "name" ? "asc" : "desc");
  if (search.length > 200) throw new ValidationError("Catalog search is too long");
  const fingerprint = await digestReference(
    "catalog",
    JSON.stringify({
      kind,
      search,
      limit,
      activeOnly: input.activeOnly === true,
      order,
      direction,
      workspaceScope: workspaceScope?.selectedToken ?? null,
    }),
  );
  const after = decodeKeysetCursor(input.cursor ?? null, fingerprint);
  if (after && (
    after.values.length !== 1 || typeof after.values[0] !== "string"
  )) {
    throw new ValidationError("Catalog cursor is invalid");
  }
  const afterValue = after ? String(after.values[0]) : null;
  const orderExpression = order === "name" ? "lower(name)" : "updated_at";
  const workspace = workspacePredicate("workspace_owner_user_id", workspaceScope);
  const predicates = ["access_role IS NOT NULL", workspace.sql];
  const workspaceParameters = workspace.parameters;
  if (input.activeOnly && kind !== "releases") {
    predicates.push("archived_at IS NULL");
  }
  const trailing: unknown[] = [];
  if (search) {
    predicates.push(kind === "projects"
      ? "(instr(lower(name), ?) > 0 OR instr(lower(summary), ?) > 0)"
      : "instr(lower(name), ?) > 0");
    trailing.push(search, ...(kind === "projects" ? [search] : []));
  }
  if (afterValue) {
    const comparison = direction === "asc" ? ">" : "<";
    predicates.push(
      `(${orderExpression} ${comparison} ? OR ` +
      `(${orderExpression} = ? AND id ${comparison} ?))`,
    );
    trailing.push(afterValue, afterValue, after!.id);
  }
  trailing.push(limit + 1);

  const scope = kind === "projects"
    ? `WITH scoped AS (
         SELECT p.*,
           p.owner_user_id AS workspace_owner_user_id,
           ${projectAccessRoleSql("p")} AS access_role
         FROM projects p
       )`
    : kind === "releases"
      ? `WITH scoped AS (
           SELECT r.*,
             p.owner_user_id AS workspace_owner_user_id,
             ${projectAccessRoleSql("p")} AS access_role
           FROM releases r JOIN projects p ON p.id = r.project_id
           WHERE r.deleted_at IS NULL AND p.deleted_at IS NULL
         )`
      : `WITH scoped AS (
           SELECT v.*,
             CASE WHEN v.scope_project_id IS NOT NULL THEN p.owner_user_id
               ELSE v.owner_user_id END AS workspace_owner_user_id,
             ${savedViewAccessRoleSql("v", "p")} AS access_role
           FROM saved_views v LEFT JOIN projects p ON p.id = v.scope_project_id
         )`;
  const principalParameters = kind === "views"
    ? [currentUser.id, currentUser.id, currentUser.id, currentUser.id]
    : [currentUser.id, currentUser.id];
  const rows = await getD1().prepare(
    `${scope}
     SELECT *, COUNT(*) OVER() AS total_count,
       ${orderExpression} AS cursor_value
     FROM scoped
     WHERE ${predicates.join(" AND ")}
     ORDER BY ${orderExpression} ${direction.toUpperCase()}, id ${direction.toUpperCase()}
     LIMIT ?`,
  ).bind(...principalParameters, ...workspaceParameters, ...trailing).all<DbRow>();
  const visible = rows.results.slice(0, limit);
  const last = visible.at(-1);
  const hasMore = rows.results.length > limit;
  let releaseProjects: ProjectRecord[] = [];
  if (kind === "releases" && visible.length) {
    const projectIds = [...new Set(visible.map((row) => String(row.project_id)))];
    const projectRows = await getD1().prepare(
      `WITH scoped AS (
         SELECT p.*,
           ${projectAccessRoleSql("p")} AS access_role
         FROM projects p
         WHERE p.id IN (${sqlPlaceholders(projectIds)})
       )
       SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    ).bind(currentUser.id, currentUser.id, ...projectIds).all<DbRow>();
    releaseProjects = projectRows.results.map(mapProject);
  }
  return {
    kind,
    projects: kind === "projects" ? visible.map(mapProject) : releaseProjects,
    releases: kind === "releases" ? visible.map(mapRelease) : [],
    views: kind === "views" ? visible.map(mapView) : [],
    page: {
      hasMore,
      nextCursor: hasMore && last
        ? encodeKeysetCursor(
            { values: [String(last.cursor_value)], id: String(last.id) },
            fingerprint,
          )
        : null,
    },
    total: Number(rows.results[0]?.total_count ?? 0),
  };
}

export type WorkspaceSyncProjectionInput = {
  taskIds: readonly string[];
  projectIds: readonly string[];
  releaseIds: readonly string[];
  viewIds: readonly string[];
  labelGroupIds: readonly string[];
  invalidatedTaskIds: readonly string[];
  workspaceOwnerUserId?: string | null;
  includeLabelGroupCatalog?: boolean;
};

export type WorkspaceSyncProjection = {
  tasks: TaskRecord[];
  projects: ProjectRecord[];
  releases: ReleaseRecord[];
  views: SavedViewRecord[];
  labels: LabelRecord[];
  labelGroups: LabelGroupRecord[];
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
  const syncScope: ResolvedWorkspaceScope | null = input.workspaceOwnerUserId === undefined
    ? null
    : {
        ownerUserId: input.workspaceOwnerUserId,
        selectedToken: "",
        currentToken: "",
        fallback: false,
      };
  const taskWorkspace = workspacePredicate("workspace_owner_user_id", syncScope);
  const projectWorkspace = workspacePredicate("workspace_owner_user_id", syncScope);
  const labelGroupWorkspace = workspaceCatalogOwnerPredicate(
    "g.owner_user_id",
    user.id,
    syncScope,
  );
  const allTaskIds = [...new Set([...input.taskIds, ...input.invalidatedTaskIds])];
  const taskPlaceholders = sqlPlaceholders(allTaskIds);
  const projectPlaceholders = sqlPlaceholders(input.projectIds);
  const releasePlaceholders = sqlPlaceholders(input.releaseIds);
  const viewPlaceholders = sqlPlaceholders(input.viewIds);
  const labelGroupPlaceholders = sqlPlaceholders(input.labelGroupIds);
  const labelGroupSelection = input.includeLabelGroupCatalog
    ? { sql: "1 = 1", parameters: [] as string[] }
    : {
        sql: `g.id IN (${labelGroupPlaceholders})`,
        parameters: [...input.labelGroupIds],
      };
  const [tasks, projects, releases, views, catalogLabelGroups] = await db.batch<DbRow>([
    db
      .prepare(
        `WITH scoped AS (
           SELECT ${snapshotTaskProjection},
             CASE WHEN t.project_id IS NOT NULL THEN p.owner_user_id
               ELSE t.owner_user_id END AS workspace_owner_user_id,
             ${taskAccessRoleSql("t", "p")} AS access_role,
             ${projectAccessRoleSql("p")} AS project_access_role
           FROM tasks t
           LEFT JOIN projects p ON p.id = t.project_id
           WHERE t.id IN (${taskPlaceholders})
         )
         SELECT * FROM scoped WHERE access_role IS NOT NULL AND ${taskWorkspace.sql}`,
      )
      .bind(user.id, user.id, user.id, user.id, user.id, user.id, ...allTaskIds,
        ...taskWorkspace.parameters),
    db
      .prepare(
        `WITH scoped AS (
           SELECT p.*,
             p.owner_user_id AS workspace_owner_user_id,
             ${projectAccessRoleSql("p")} AS access_role
           FROM projects p
           WHERE p.id IN (${projectPlaceholders})
         )
         SELECT * FROM scoped WHERE access_role IS NOT NULL AND ${projectWorkspace.sql}`,
      )
      .bind(user.id, user.id, ...input.projectIds, ...projectWorkspace.parameters),
    db
      .prepare(
        `WITH scoped AS (
           SELECT r.*,
             p.owner_user_id AS workspace_owner_user_id,
             ${projectAccessRoleSql("p")} AS access_role
           FROM releases r JOIN projects p ON p.id = r.project_id
           WHERE r.deleted_at IS NULL AND p.deleted_at IS NULL
             AND r.id IN (${releasePlaceholders})
         )
         SELECT * FROM scoped WHERE access_role IS NOT NULL AND ${projectWorkspace.sql}`,
      )
      .bind(user.id, user.id, ...input.releaseIds, ...projectWorkspace.parameters),
    db
      .prepare(
        `WITH scoped AS (
           SELECT v.*,
             CASE WHEN v.scope_project_id IS NOT NULL THEN p.owner_user_id
               ELSE v.owner_user_id END AS workspace_owner_user_id,
             ${savedViewAccessRoleSql("v", "p")} AS access_role
           FROM saved_views v
           LEFT JOIN projects p ON p.id = v.scope_project_id
           WHERE v.id IN (${viewPlaceholders})
         )
         SELECT * FROM scoped WHERE access_role IS NOT NULL AND ${projectWorkspace.sql}`,
      )
      .bind(user.id, user.id, user.id, user.id, ...input.viewIds,
        ...projectWorkspace.parameters),
    db
      .prepare(
        `SELECT g.* FROM label_groups g
         WHERE ${labelGroupWorkspace.sql}
           AND ${labelGroupSelection.sql}
         ORDER BY g.position, lower(g.name), g.id`,
      )
      .bind(...labelGroupWorkspace.parameters, ...labelGroupSelection.parameters),
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
         l.owner_user_id, l.group_id, l.name, l.color, l.description, l.archived_at,
         l.version, l.created_at, l.updated_at
       FROM task_labels tl JOIN labels l ON l.id = tl.label_id
       WHERE tl.task_id IN (${sqlPlaceholders(accessibleInvalidatedTaskIds)})
       ORDER BY tl.task_id, lower(l.name), l.id`,
    ).bind(...accessibleInvalidatedTaskIds).all<DbRow>()
    : { results: [] as DbRow[] };
  const taskLabelGroups = await loadLabelGroupsForLabels(labelContext.results);
  return {
    tasks: taskRecords.filter((task) => requestedTasks.has(task.id)),
    projects: projects.results.map(mapProject),
    releases: releases.results.map(mapRelease),
    views: views.results.map(mapView),
    labels: [...new Map(labelContext.results.map((row) => [
      String(row.label_id),
      mapLabel({ ...row, id: row.label_id }),
    ])).values()],
    labelGroups: [...new Map([
      ...catalogLabelGroups.results.map(mapLabelGroup),
      ...taskLabelGroups,
    ].map((group) => [group.id, group])).values()],
    taskLabels: labelContext.results.map(mapTaskLabel),
    labelContextTaskIds: accessibleInvalidatedTaskIds,
    accessibleTaskIds: taskRecords.map((task) => task.id),
  };
}


function adminEmailsFromEnvironment(): string {
  return getRuntimeEnvironment().TASK_MANAGER_ADMIN_EMAILS ?? "";
}

function snapshotTaskScopeParameters(
  userId: string,
  taskLimit: number,
  scope: ResolvedWorkspaceScope | null,
) {
  return [
    userId,
    userId,
    userId,
    userId,
    ...workspacePredicate("workspace_owner_user_id", scope).parameters,
    taskLimit + 1,
  ];
}

function collectionRows(rows: DbRow[], limit: number | null) {
  return limit === null ? rows : rows.slice(0, limit);
}

function navigationCollectionState(rows: DbRow[], limit: number | null) {
  const total = Number(rows[0]?.total_count ?? 0);
  return {
    total,
    hasMore: limit !== null && total > limit,
  };
}

function recentNavigationRecords<T extends { id: string; updatedAt?: string; archivedAt?: string | null }>(
  records: T[],
  limit: number | null,
) {
  const boundedLimit = limit ?? 3;
  return records
    .filter((record) => !record.archivedAt)
    .sort((left, right) =>
      (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
        right.id.localeCompare(left.id),
    )
    .slice(0, boundedLimit);
}
