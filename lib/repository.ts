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
  LabelGroupRecord,
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
  ThemePreference,
  SidebarPreference,
  UserIdentityRecord,
  UserProfile,
  UserRecord,
  ViewDisplay,
  ViewFilterCondition,
  ViewQuery,
  WorkflowStatusRecord,
  WorkspaceCatalogKind,
  WorkspaceCatalogPage,
  WorkspaceScopeDescriptor,
  WorkspaceScopeState,
  WorkspaceMetrics,
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
import {
  accessibleTaskWhere,
  editableTaskWhere,
  projectAccessRoleSql,
  projectEffectiveRoleRankSql,
  savedViewAccessRoleSql,
  savedViewEffectiveRoleRankSql,
  taskAccessRoleSql,
  taskEffectiveRoleRankSql,
} from "./access-sql";
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
  taskDescriptionAttachmentPredicate,
  validateTaskDescriptionAttachments,
} from "./task-description-attachments";
import { normalizeProjectTaskCode } from "./project-task-code";
import {
  activityBatchAssertion,
  activityEventStatement,
  changedFields,
  newActivityId,
} from "./activity-write";
import { rankBetweenNeighbors, taskGroupValue } from "./task-groups";
import {
  decodeGlobalSearchCursor,
  encodeGlobalSearchCursor,
  globalSearchLimit,
  GLOBAL_SEARCH_MAX_OFFSET,
  normalizeGlobalSearchQuery,
  type GlobalSearchEntityType,
  type GlobalSearchInput,
  type GlobalSearchResponse,
} from "./global-search";
import {
  ALL_ACCESSIBLE_WORKSPACE_SCOPE,
  opaqueWorkspaceOwnerToken,
  parseWorkspaceScopeToken,
  resolveWorkspaceScopeMembership,
  workspaceScopeContextLabel,
} from "./workspace-scope";

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

const editableTaskPredicate = editableTaskWhere("tasks");

type WorkspaceOwnerCandidate = { id: string; displayName: string };

type ResolvedWorkspaceScope = {
  ownerUserId: string | null;
  selectedToken: string;
  currentToken: string;
  fallback: boolean;
  candidates?: WorkspaceOwnerCandidate[];
};

async function resolveWorkspaceScope(
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
  const candidates = await loadAccessibleWorkspaceOwners(user.id);
  const descriptors = await workspaceScopeDescriptors(user, candidates);
  const membership = resolveWorkspaceScopeMembership(requested, descriptors, currentToken);
  const selectedCandidate = await candidateForWorkspaceToken(candidates, membership.token);
  return {
    ownerUserId: selectedCandidate?.id ?? user.id,
    selectedToken: selectedCandidate ? membership.token : currentToken,
    currentToken,
    fallback: membership.fallback || !selectedCandidate,
    candidates,
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

async function candidateForWorkspaceToken(
  candidates: readonly WorkspaceOwnerCandidate[],
  token: string,
) {
  const matches = await Promise.all(candidates.map(async (candidate) => ({
    candidate,
    token: await opaqueWorkspaceOwnerToken(candidate.id),
  })));
  return matches.find((match) => match.token === token)?.candidate ?? null;
}

async function workspaceScopeDescriptors(
  user: UserRecord,
  candidates: readonly WorkspaceOwnerCandidate[],
): Promise<WorkspaceScopeDescriptor[]> {
  const distinct = [...new Map([
    { id: user.id, displayName: user.displayName },
    ...candidates,
  ].map((candidate) => [candidate.id, candidate])).values()];
  const owners = await Promise.all(distinct.map(async (candidate) => ({
    token: await opaqueWorkspaceOwnerToken(candidate.id),
    kind: "owner" as const,
    label: candidate.id === user.id ? "Your work" : candidate.displayName,
    current: candidate.id === user.id,
  })));
  owners.sort((left, right) =>
    Number(right.current) - Number(left.current) || left.label.localeCompare(right.label),
  );
  return [
    ...owners,
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
  candidates: readonly WorkspaceOwnerCandidate[],
): Promise<WorkspaceScopeState> {
  const options = await workspaceScopeDescriptors(user, candidates);
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

async function loadAccessibleWorkspaceOwners(userId: string) {
  const rows = await accessibleWorkspaceOwnersStatement(getD1(), userId).all<DbRow>();
  return rows.results.map((row) => ({
    id: String(row.id),
    displayName: String(row.display_name),
  }));
}

function accessibleWorkspaceOwnersStatement(db: D1Database, userId: string) {
  return db.prepare(
    `WITH principal AS (SELECT ? AS id), owner_ids AS (
       SELECT id FROM principal
       UNION
       SELECT p.owner_user_id FROM projects p
       JOIN principal
       WHERE p.deleted_at IS NULL
         AND ${projectEffectiveRoleRankSql("p", "principal.id")} > 0
       UNION
       SELECT CASE WHEN t.project_id IS NOT NULL THEN p.owner_user_id
         ELSE t.owner_user_id END FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       JOIN principal
       WHERE t.deleted_at IS NULL
         AND (t.project_id IS NULL OR p.deleted_at IS NULL)
         AND ${taskEffectiveRoleRankSql("t", "p", "principal.id")} > 0
       UNION
       SELECT v.owner_user_id FROM saved_views v
       LEFT JOIN projects p ON p.id = v.scope_project_id
       JOIN principal
       WHERE v.deleted_at IS NULL
         AND (v.scope_project_id IS NULL OR p.deleted_at IS NULL)
         AND ${savedViewEffectiveRoleRankSql("v", "p", "principal.id")} > 0
     )
     SELECT u.id, u.display_name FROM users u JOIN owner_ids ON owner_ids.id = u.id
     CROSS JOIN principal
     ORDER BY CASE WHEN u.id = principal.id THEN 0 ELSE 1 END,
       lower(u.display_name), u.id`,
  ).bind(userId);
}

function workspacePredicate(
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

const snapshotTaskProjection = `
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

export async function getOrCreateUser(actor: Actor): Promise<UserRecord> {
  const db = getD1();
  const existing = await db
    .prepare(
      `UPDATE users
       SET email = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = (
         SELECT user_id FROM user_identities
         WHERE provider = ? AND provider_account_key = ?
       )
       RETURNING id, display_name, email, timezone, theme,
                 sidebar_preference, version`,
    )
    .bind(
      actor.email,
      actor.provider,
      actor.providerAccountKey,
    )
    .first<DbRow>();

  if (existing) {
    await db
      .prepare(
        `UPDATE user_identities SET verified_email = ?
         WHERE provider = ? AND provider_account_key = ?`,
      )
      .bind(actor.email, actor.provider, actor.providerAccountKey)
      .run();
    return mapUser(existing);
  }

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
    theme: "system",
    sidebarPreference: "expanded",
    version: 1,
  };
}

export async function getUserProfile(currentUser: UserRecord): Promise<UserProfile> {
  const db = getD1();
  const [user, identities] = await Promise.all([
    db.prepare(
      `SELECT id, display_name, email, timezone, theme,
              sidebar_preference, version
       FROM users WHERE id = ?`,
    ).bind(currentUser.id).first<DbRow>(),
    db.prepare(
      `SELECT provider, verified_email
       FROM user_identities WHERE user_id = ?
       ORDER BY provider, provider_account_key`,
    ).bind(currentUser.id).all<DbRow>(),
  ]);
  if (!user) throw new NotFoundError("User profile was not found");
  return {
    user: mapUser(user),
    identities: identities.results.map(mapUserIdentity),
  };
}

export async function updateUserProfile(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<UserProfile> {
  const allowed = new Set([
    "version",
    "displayName",
    "timezone",
    "theme",
    "sidebarPreference",
  ]);
  const unsupported = Object.keys(input).find((key) => !allowed.has(key));
  if (unsupported) throw new ValidationError(`Profile field ${unsupported} cannot be changed`);
  if (!Number.isInteger(input.version) || Number(input.version) < 1) {
    throw new ValidationError("Profile version is required");
  }

  const current = await getUserProfile(currentUser);
  const displayName = input.displayName === undefined
    ? current.user.displayName
    : validateDisplayName(input.displayName);
  const timezone = input.timezone === undefined
    ? current.user.timezone
    : validateTimeZone(input.timezone);
  const theme = input.theme === undefined
    ? current.user.theme
    : validateTheme(input.theme);
  const sidebarPreference = input.sidebarPreference === undefined
    ? current.user.sidebarPreference
    : validateSidebarPreference(input.sidebarPreference);

  const updated = await getD1().prepare(
    `UPDATE users
     SET display_name = ?, timezone = ?, theme = ?, sidebar_preference = ?,
         version = version + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND version = ?
     RETURNING id, display_name, email, timezone, theme,
               sidebar_preference, version`,
  ).bind(
    displayName,
    timezone,
    theme,
    sidebarPreference,
    currentUser.id,
    input.version,
  ).first<DbRow>();
  if (!updated) throw new ConflictError("Profile changed in another session; reload and try again");
  return {
    user: mapUser(updated),
    identities: current.identities,
  };
}

function validateDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("Display name is required");
  const normalized = value.trim();
  if (!normalized) throw new ValidationError("Display name is required");
  if (normalized.length > 120) throw new ValidationError("Display name must be 120 characters or fewer");
  return normalized;
}

function validateTimeZone(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 100) {
    throw new ValidationError("Timezone must be a valid IANA identifier");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
  } catch {
    throw new ValidationError("Timezone must be a valid IANA identifier");
  }
  if (value !== "UTC" && !value.includes("/")) {
    throw new ValidationError("Timezone must be a valid IANA identifier");
  }
  return value;
}

function validateTheme(value: unknown): ThemePreference {
  if (value !== "system" && value !== "light" && value !== "dark") {
    throw new ValidationError("Theme must be system, light, or dark");
  }
  return value;
}

function validateSidebarPreference(value: unknown): SidebarPreference {
  if (value !== "expanded" && value !== "collapsed") {
    throw new ValidationError("Sidebar preference must be expanded or collapsed");
  }
  return value;
}

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
               ${taskAccessRoleSql("t", "p")} AS access_role
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
      accessibleWorkspaceOwnersStatement(db, user.id),
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
    workspaceOwners,
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
  const ownerCandidates = workspaceOwners.results.map((row) => ({
    id: String(row.id),
    displayName: String(row.display_name),
  }));
  const resolvedWorkspaceScope = workspaceScope
    ? await workspaceScopeState(user, workspaceScope, ownerCandidates)
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
             ${taskAccessRoleSql("t", "p")} AS access_role
           FROM tasks t
           LEFT JOIN projects p ON p.id = t.project_id
           WHERE t.id IN (${taskPlaceholders})
         )
         SELECT * FROM scoped WHERE access_role IS NOT NULL AND ${taskWorkspace.sql}`,
      )
      .bind(user.id, user.id, user.id, user.id, ...allTaskIds,
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

function sqlPlaceholders(values: readonly string[]): string {
  return values.length ? values.map(() => "?").join(", ") : "NULL";
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
  options: { workspaceScope?: string | null } = {},
): Promise<TaskDetailRecord> {
  const task = await loadAccessibleTask(currentUser.id, taskId);
  void options;
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
        labelGroupIds: [],
        invalidatedTaskIds: [],
      })).tasks
    : [];
  const visibleIds = new Set([task.id, ...relatedTasks.map((item) => item.id)]);
  const labels = (labelRows.results as DbRow[]).map(mapLabel);
  const labelGroups = await loadLabelGroupsForLabels(labelRows.results as DbRow[]);

  return {
    task,
    relatedTasks,
    labelGroups,
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
  options: { workspaceScope?: string | null } = {},
): Promise<TaskRecord[]> {
  const query = input.trim().toLowerCase();
  if (!query) return [];
  if (query.length > 200) {
    throw new ValidationError("Task search is limited to 200 characters");
  }
  const workspaceScope = await resolveWorkspaceScope(
    currentUser,
    options.workspaceScope,
  );
  const workspace = workspacePredicate("workspace_owner_user_id", workspaceScope);
  const rows = await getD1()
    .prepare(
      `WITH scoped AS (
         SELECT ${snapshotTaskProjection},
           CASE WHEN t.project_id IS NOT NULL THEN p.owner_user_id
             ELSE t.owner_user_id END AS workspace_owner_user_id,
           ${taskAccessRoleSql("t", "p")} AS access_role
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
       SELECT * FROM scoped
       WHERE access_role IS NOT NULL AND ${workspace.sql}
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
      ...workspace.parameters,
      MAX_UI_SNAPSHOT_TASKS,
    )
    .all<DbRow>();
  return rows.results.map(mapTask);
}

export async function searchWorkspace(
  currentUser: UserRecord,
  input: GlobalSearchInput,
): Promise<GlobalSearchResponse> {
  const query = normalizeGlobalSearchQuery(input.query);
  const limit = globalSearchLimit(input.limit);
  const { offset } = decodeGlobalSearchCursor(input.cursor, { query, limit });
  const empty: GlobalSearchResponse = {
    query,
    groups: { tasks: [], projects: [], releases: [], views: [] },
    nextCursor: null,
    partialErrors: [],
  };
  if (!query) return empty;

  const db = getD1();
  const pageLimit = limit + 1;
  const taskQuery = db.prepare(
    `WITH scoped AS MATERIALIZED (
       SELECT t.id, t.public_id, t.identifier, t.title, t.description, t.updated_at,
         p.name AS project_name, p.public_id AS project_public_id,
         r.name AS release_name,
         ${taskAccessRoleSql("t", "p")} AS access_role
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN releases r ON r.id = t.release_id AND r.deleted_at IS NULL
       WHERE t.archived_at IS NULL
         AND (t.project_id IS NULL OR p.archived_at IS NULL)
         AND t.deleted_at IS NULL
         AND (t.project_id IS NULL OR p.deleted_at IS NULL)
     ), visible AS MATERIALIZED (
       SELECT * FROM scoped WHERE access_role IS NOT NULL
     )
     SELECT id, public_id, identifier, title, project_name, project_public_id,
       release_name, updated_at
     FROM visible
     WHERE (
       instr(lower(identifier), ?) > 0 OR EXISTS (
         SELECT 1 FROM task_identifier_aliases alias
         WHERE alias.task_id = visible.id AND instr(lower(alias.identifier), ?) > 0
       ) OR instr(lower(title), ?) > 0
         OR instr(lower(COALESCE(description, '')), ?) > 0
     )
     ORDER BY (
       lower(identifier) = ? OR EXISTS (
         SELECT 1 FROM task_identifier_aliases exact_alias
         WHERE exact_alias.task_id = visible.id AND lower(exact_alias.identifier) = ?
       )
     ) DESC, updated_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  ).bind(
    currentUser.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
    query,
    query,
    query,
    query,
    query,
    query,
    pageLimit,
    offset,
  ).all<DbRow>();
  const projectQuery = db.prepare(
    `WITH scoped AS MATERIALIZED (
       SELECT p.id, p.public_id, p.name, p.task_code, p.summary, p.status, p.updated_at,
         ${projectAccessRoleSql("p")} AS access_role
       FROM projects p WHERE p.archived_at IS NULL
     ), visible AS MATERIALIZED (
       SELECT * FROM scoped WHERE access_role IS NOT NULL
     )
     SELECT id, public_id, name, task_code, summary, status, updated_at
     FROM visible
     WHERE instr(lower(name), ?) > 0 OR instr(lower(summary), ?) > 0
     ORDER BY (lower(name) = ?) DESC, updated_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  ).bind(
    currentUser.id,
    currentUser.id,
    query,
    query,
    query,
    pageLimit,
    offset,
  ).all<DbRow>();
  const releaseQuery = db.prepare(
    `WITH scoped AS MATERIALIZED (
       SELECT r.id, r.public_id, r.name, r.status, r.updated_at,
         p.name AS project_name, p.public_id AS project_public_id,
         ${projectAccessRoleSql("p")} AS access_role
       FROM releases r JOIN projects p ON p.id = r.project_id
       WHERE r.deleted_at IS NULL AND p.deleted_at IS NULL
         AND p.archived_at IS NULL
     ), visible AS MATERIALIZED (
       SELECT * FROM scoped WHERE access_role IS NOT NULL
     )
     SELECT id, public_id, name, status, project_name, project_public_id, updated_at
     FROM visible
     WHERE instr(lower(name), ?) > 0 OR instr(lower(project_name), ?) > 0
     ORDER BY (lower(name) = ?) DESC, updated_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  ).bind(
    currentUser.id,
    currentUser.id,
    query,
    query,
    query,
    pageLimit,
    offset,
  ).all<DbRow>();
  const viewQuery = db.prepare(
    `WITH scoped AS MATERIALIZED (
       SELECT v.id, v.public_id, v.name, v.updated_at,
         p.name AS project_name,
         ${savedViewAccessRoleSql("v", "p")} AS access_role
       FROM saved_views v LEFT JOIN projects p ON p.id = v.scope_project_id
       WHERE v.archived_at IS NULL
         AND (v.scope_project_id IS NULL OR p.archived_at IS NULL)
     ), visible AS MATERIALIZED (
       SELECT * FROM scoped WHERE access_role IS NOT NULL
     )
     SELECT id, public_id, name, project_name, updated_at
     FROM visible
     WHERE instr(lower(name), ?) > 0
     ORDER BY (lower(name) = ?) DESC, updated_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  ).bind(
    currentUser.id,
    currentUser.id,
    currentUser.id,
    currentUser.id,
    query,
    query,
    pageLimit,
    offset,
  ).all<DbRow>();

  const settled = await Promise.allSettled([
    taskQuery,
    projectQuery,
    releaseQuery,
    viewQuery,
  ]);
  const partialErrors: GlobalSearchEntityType[] = [];
  const page = (index: number, type: GlobalSearchEntityType) => {
    const result = settled[index];
    if (!result || result.status === "rejected") {
      partialErrors.push(type);
      return { rows: [] as DbRow[], hasMore: false };
    }
    return {
      rows: result.value.results.slice(0, limit),
      hasMore: result.value.results.length > limit,
    };
  };
  const tasks = page(0, "task");
  const projects = page(1, "project");
  const releases = page(2, "release");
  const views = page(3, "view");
  const hasMore = tasks.hasMore || projects.hasMore || releases.hasMore || views.hasMore;
  const nextOffset = offset + limit;

  return {
    query,
    groups: {
      tasks: tasks.rows.map((row) => ({
        type: "task" as const,
        id: String(row.id),
        publicId: String(row.public_id),
        identifier: String(row.identifier),
        title: String(row.title),
        context: [nullableString(row.project_name), nullableString(row.release_name)]
          .filter(Boolean).join(" · "),
        href: `/issues/${encodeURIComponent(String(row.public_id))}`,
      })),
      projects: projects.rows.map((row) => ({
        type: "project" as const,
        id: String(row.id),
        publicId: String(row.public_id),
        title: String(row.name),
        context: `${String(row.task_code)} · ${String(row.summary || row.status || "Project")}`,
        href: `/projects/${encodeURIComponent(String(row.public_id))}`,
      })),
      releases: releases.rows.map((row) => ({
        type: "release" as const,
        id: String(row.id),
        publicId: String(row.public_id),
        title: String(row.name),
        context: String(row.project_name),
        href: `/projects/${encodeURIComponent(String(row.project_public_id))}/releases/${encodeURIComponent(String(row.public_id))}`,
      })),
      views: views.rows.map((row) => ({
        type: "view" as const,
        id: String(row.id),
        publicId: String(row.public_id),
        title: String(row.name),
        context: row.project_name ? String(row.project_name) : "Global view",
        href: `/views/${encodeURIComponent(String(row.public_id))}`,
      })),
    },
    nextCursor: hasMore && nextOffset <= GLOBAL_SEARCH_MAX_OFFSET
      ? encodeGlobalSearchCursor(nextOffset, query, limit)
      : null,
    partialErrors,
  } satisfies GlobalSearchResponse;
}

export type TaskQueryInput = {
  query?: ViewQuery;
  surface?: string;
  scopeProjectId?: string | null;
  display?: ViewDisplay;
  limit?: number;
  after?: TaskQueryCursor | null;
  workspaceScope?: string | null;
};

export type TaskQueryCursor = {
  sortValue: string | number;
  rank: number;
  publicId: string;
};

export async function queryTaskSummaries(
  currentUser: UserRecord,
  input: TaskQueryInput,
) {
  const workspaceScope = await resolveWorkspaceScope(
    currentUser,
    input.workspaceScope,
  );
  const query = validateViewQuery(input.query);
  const surface = typeof input.surface === "string" && input.surface.length <= 240
    ? input.surface
    : "all";
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1)) {
    throw new ValidationError("Task query limit must be a positive integer");
  }
  const limit = Math.min(Number(input.limit ?? 500), MAX_UI_SNAPSHOT_TASKS);
  const display = validateViewDisplay(input.display);
  if (input.after !== undefined && input.after !== null && (
    typeof input.after !== "object" ||
    !["string", "number"].includes(typeof input.after.sortValue) ||
    (typeof input.after.sortValue === "number" && !Number.isFinite(input.after.sortValue)) ||
    typeof input.after.rank !== "number" ||
    !Number.isFinite(input.after.rank) ||
    typeof input.after.publicId !== "string" ||
    !input.after.publicId
  )) {
    throw new ValidationError("Task query cursor is invalid");
  }
  const after = input.after ?? null;
  const orderDirection = display.orderBy === "manual" ? "asc" : display.direction;
  const scopeProject = input.scopeProjectId
    ? await loadAccessibleProject(currentUser.id, String(input.scopeProjectId))
    : null;
  await validateTaskFilterReferences(
    currentUser,
    query,
    scopeProject,
    surface.startsWith("view:"),
  );

  const builtInSurfaces = new Set(["mine", "all", "active", "backlog", "archived", "shared"]);
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
  const workspace = workspacePredicate("v.workspace_owner_user_id", workspaceScope);
  predicates.push(workspace.sql);
  parameters.push(...workspace.parameters);

  if (scopeProject) {
    predicates.push("v.project_id = ?");
    parameters.push(scopeProject.id);
  }
  if (surface === "mine") {
    predicates.push("v.assignee_user_id = ?");
    parameters.push(currentUser.id);
  } else if (surface === "shared") {
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
  } else if (surface === "mine") {
    predicates.push("v.archived_at IS NULL");
  } else if (!queryExplicitlyFiltersArchived(query)) {
    predicates.push("v.archived_at IS NULL");
  }
  const order = taskQueryOrder(display.orderBy);
  if (after) appendTaskQueryCursor(predicates, parameters, order, orderDirection, after);
  parameters.push(limit + 1);

  const rows = await getD1().prepare(
    `WITH scoped AS (
       SELECT t.*, s.category AS status_category,
         CASE WHEN t.project_id IS NOT NULL THEN p.owner_user_id
           ELSE t.owner_user_id END AS workspace_owner_user_id,
         ${taskAccessRoleSql("t", "p")} AS access_role
       FROM tasks t
       JOIN workflow_statuses s ON s.id = t.status_id
       LEFT JOIN projects p ON p.id = t.project_id
     ), visible_tasks AS (
       SELECT
         scoped.id, scoped.public_id, scoped.owner_user_id,
         scoped.creator_user_id, scoped.identifier, scoped.sequence_number,
         scoped.title, scoped.description, scoped.status_id, scoped.priority,
         scoped.assignee_user_id, scoped.project_id,
         CASE WHEN scoped.release_id IS NULL OR EXISTS (
           SELECT 1 FROM releases active_release
           WHERE active_release.id = scoped.release_id
             AND active_release.deleted_at IS NULL
         ) THEN scoped.release_id ELSE NULL END AS release_id,
         scoped.estimate, scoped.due_date,
         CASE WHEN scoped.parent_task_id IS NULL OR EXISTS (
           SELECT 1 FROM tasks active_parent
           LEFT JOIN projects active_parent_project
             ON active_parent_project.id = active_parent.project_id
           WHERE active_parent.id = scoped.parent_task_id
             AND active_parent.deleted_at IS NULL
             AND (active_parent.project_id IS NULL
               OR active_parent_project.deleted_at IS NULL)
         ) THEN scoped.parent_task_id ELSE NULL END AS parent_task_id,
         scoped.rank, scoped.started_at, scoped.completed_at,
         scoped.canceled_at, scoped.archived_at, scoped.comment_count,
         scoped.deleted_at, scoped.deleted_by_user_id, scoped.purge_after,
         scoped.version, scoped.created_at, scoped.updated_at,
         scoped.status_category, scoped.workspace_owner_user_id,
         scoped.access_role
       FROM scoped WHERE access_role IS NOT NULL
     )
     SELECT
       v.id, v.public_id, v.owner_user_id, v.creator_user_id,
       v.identifier, v.sequence_number, v.title, NULL AS description,
       v.status_id, v.priority, v.assignee_user_id, v.project_id, v.release_id,
       v.estimate, v.due_date, v.parent_task_id, v.rank,
       v.started_at, v.completed_at, v.canceled_at, v.archived_at,
       v.comment_count, v.version, v.created_at, v.updated_at,
       v.access_role, ${order} AS cursor_sort_value
     FROM visible_tasks v
     WHERE ${predicates.join(" AND ")}
     ORDER BY ${order} ${orderDirection === "asc" ? "ASC" : "DESC"},
       v.rank ASC, v.public_id ASC
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
        ? {
            sortValue: taskQueryCursorValue(last.cursor_sort_value),
            rank: Number(last.rank),
            publicId: String(last.public_id),
          }
        : null,
    },
    referenceTime: new Date().toISOString(),
  };
}

function taskQueryOrder(orderBy: ViewDisplay["orderBy"]) {
  if (orderBy === "manual") return "v.rank";
  if (orderBy === "priority") {
    return `CASE v.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
      WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
  }
  if (orderBy === "created") return "v.created_at";
  if (orderBy === "updated") return "v.updated_at";
  if (orderBy === "due") return "COALESCE(v.due_date, '9999-12-31')";
  return "lower(v.title)";
}

function appendTaskQueryCursor(
  predicates: string[],
  parameters: unknown[],
  order: string,
  direction: ViewDisplay["direction"],
  after: TaskQueryCursor,
) {
  const comparison = direction === "asc" ? ">" : "<";
  predicates.push(`(
    ${order} ${comparison} ?
    OR (${order} = ? AND v.rank > ?)
    OR (${order} = ? AND v.rank = ? AND v.public_id > ?)
  )`);
  parameters.push(
    after.sortValue,
    after.sortValue,
    after.rank,
    after.sortValue,
    after.rank,
    after.publicId,
  );
}

function taskQueryCursorValue(value: unknown): string | number {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("Task query cursor value is invalid");
  }
  return value;
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
         SELECT t.owner_user_id,
                COUNT(*) AS task_count,
                SUM(CASE
                  WHEN datetime(t.updated_at) >= datetime('now', '-7 days')
                  THEN 1 ELSE 0
                END) AS recent_task_count,
                MAX(t.updated_at) AS last_task_activity_at
         FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.deleted_at IS NULL
           AND (t.project_id IS NULL OR p.deleted_at IS NULL)
         GROUP BY t.owner_user_id
       ) task_stats ON task_stats.owner_user_id = u.id
       LEFT JOIN (
         SELECT owner_user_id,
                COUNT(*) AS project_count,
                MAX(updated_at) AS last_project_activity_at
         FROM projects WHERE deleted_at IS NULL
         GROUP BY owner_user_id
       ) project_stats ON project_stats.owner_user_id = u.id
       LEFT JOIN (
         SELECT r.owner_user_id,
                COUNT(*) AS release_count,
                MAX(r.updated_at) AS last_release_activity_at
         FROM releases r JOIN projects p ON p.id = r.project_id
         WHERE r.deleted_at IS NULL AND p.deleted_at IS NULL
         GROUP BY r.owner_user_id
       ) release_stats ON release_stats.owner_user_id = u.id
       LEFT JOIN (
         SELECT v.owner_user_id,
                COUNT(*) AS view_count,
                MAX(v.updated_at) AS last_view_activity_at
         FROM saved_views v LEFT JOIN projects p ON p.id = v.scope_project_id
         WHERE v.deleted_at IS NULL
           AND (v.scope_project_id IS NULL OR p.deleted_at IS NULL)
         GROUP BY v.owner_user_id
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
         WHERE t.deleted_at IS NULL
           AND (t.project_id IS NULL OR p.deleted_at IS NULL)
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
       WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM (SELECT ? AS id) mutation_actor
           WHERE ${projectEffectiveRoleRankSql(
             "projects",
             "mutation_actor.id",
           )} >= 2
         )
       RETURNING task_sequence AS last_value, task_code`,
    )
    .bind(new Date().toISOString(), project.id, currentUser.id)
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
         WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL
           AND status <> 'canceled'
           AND EXISTS (
             SELECT 1 FROM tasks parent
             WHERE parent.id = ? AND parent.project_id = projects.id
               AND parent.version = ? AND parent.archived_at IS NULL
               AND parent.deleted_at IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM (SELECT ? AS id) mutation_actor
             WHERE ${projectEffectiveRoleRankSql(
               "projects",
               "mutation_actor.id",
             )} >= 2
           )`,
      ).bind(
        now,
        now,
        project.id,
        parent.id,
        expectedVersion,
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
           AND parent.deleted_at IS NULL AND p.deleted_at IS NULL
           AND p.status <> 'canceled'
           AND EXISTS (
             SELECT 1 FROM (SELECT ? AS id) mutation_actor
             WHERE ${projectEffectiveRoleRankSql("p", "mutation_actor.id")} >= 2
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
      ),
      moveBatchAssertion(db, `${assertionId}_task`, "task"),
      db.prepare(
        `UPDATE tasks SET version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND project_id = ?
           AND ${editableTaskPredicate}`,
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
  const storedParentTaskId = internalTaskParentId(task);
  if (parentTaskId === storedParentTaskId) return task;

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
  const oldParentTaskId = storedParentTaskId;
  const db = getD1();
  const activity = activityEventStatement(db, currentUser, {
    taskId: task.id,
    eventType: "hierarchy_changed",
    payload: {
      changes: {
        // Keep a deleted parent opaque in ordinary child Activity while the
        // guarded mutation still compares the stored internal edge below.
        parentTaskId: { before: task.parentTaskId, after: parentTaskId },
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
         AND ${parentGuard} AND ${editableTaskPredicate}`,
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

  const storedReleaseId = internalTaskReleaseId(task);
  let releaseId = storedReleaseId;
  let selectedRelease: ReleaseRecord | null = null;
  if (Object.hasOwn(input, "releaseId")) {
    selectedRelease = input.releaseId
      ? await loadAccessibleRelease(currentUser.id, String(input.releaseId))
      : null;
    if (selectedRelease) requireContentEdit(selectedRelease.accessRole);
    assertReleaseProject(projectId, selectedRelease?.projectId ?? null);
    const currentRelease = storedReleaseId
      ? await loadAccessibleStoredRelease(currentUser.id, storedReleaseId)
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
    ["releaseId", storedReleaseId, releaseId],
    ["estimate", task.estimate, estimate],
    ["dueDate", task.dueDate, dueDate],
    ["rank", task.rank, rank],
    ["archivedAt", task.archivedAt, archivedAt],
  ]);
  if (
    storedReleaseId !== task.releaseId &&
    Object.hasOwn(changes, "releaseId")
  ) {
    // The recoverably deleted Release stays opaque in ordinary Task Activity.
    changes.releaseId = { before: task.releaseId, after: releaseId };
  }
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
       WHERE id = ? AND version = ?${descriptionPredicate.sql}
         AND ${editableTaskPredicate}
       AND (
         ? = 1 OR release_id IS ? OR NOT EXISTS (
           SELECT 1 FROM releases locked_release
           WHERE locked_release.id IN (tasks.release_id, ?)
             AND locked_release.deleted_at IS NULL
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

export async function reorderTask(
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
  const groupBy = reorderGroupBy(input.groupBy);
  if (!Object.hasOwn(input, "expectedGroupValue") || !Object.hasOwn(input, "targetGroupValue")) {
    throw new ValidationError("Expected and target Task groups are required");
  }
  const expectedGroupValue = reorderGroupValue(groupBy, input.expectedGroupValue);
  const targetGroupValue = reorderGroupValue(groupBy, input.targetGroupValue);
  if (taskGroupValue(task, groupBy) !== expectedGroupValue) {
    throw new ConflictError("Task no longer belongs to the expected group");
  }
  if (groupBy === "project" && targetGroupValue !== task.projectId) {
    throw new ValidationError("Use the explicit Task move command to change Project");
  }

  let statusId = task.statusId;
  let nextPriority = task.priority;
  let assigneeUserId = task.assigneeUserId;
  const storedReleaseId = internalTaskReleaseId(task);
  let releaseId = storedReleaseId;
  let selectedRelease: ReleaseRecord | null = null;
  if (groupBy === "status") {
    statusId = targetGroupValue!;
    await loadStatus(task.ownerUserId, statusId);
  } else if (groupBy === "priority") {
    nextPriority = priority(targetGroupValue);
  } else if (groupBy === "assignee") {
    assigneeUserId = targetGroupValue;
    await assertTaskAssigneeAccess(assigneeUserId, task.ownerUserId, task.projectId, task.id);
  } else if (groupBy === "release") {
    if (targetGroupValue !== task.releaseId) {
      const currentRelease = storedReleaseId
        ? await loadAccessibleStoredRelease(currentUser.id, storedReleaseId)
        : null;
      selectedRelease = targetGroupValue
        ? await loadAccessibleRelease(currentUser.id, targetGroupValue)
        : null;
      if (selectedRelease) requireContentEdit(selectedRelease.accessRole);
      assertReleaseProject(task.projectId, selectedRelease?.projectId ?? null);
      assertReleasedCompositionChange(currentRelease, selectedRelease, input);
      releaseId = selectedRelease?.id ?? null;
    }
  }

  const previousTaskId = optionalTaskNeighbor(input.previousTaskId);
  const nextTaskId = optionalTaskNeighbor(input.nextTaskId);
  if (previousTaskId === task.id || nextTaskId === task.id || previousTaskId === nextTaskId && previousTaskId !== null) {
    throw new ValidationError("Task reorder neighbors are invalid");
  }
  const previousTask = previousTaskId
    ? await loadAccessibleTask(currentUser.id, previousTaskId)
    : null;
  const nextTask = nextTaskId
    ? await loadAccessibleTask(currentUser.id, nextTaskId)
    : null;
  for (const neighbor of [previousTask, nextTask]) {
    if (neighbor && taskGroupValue(neighbor, groupBy) !== targetGroupValue) {
      throw new ConflictError("Task reorder neighbor changed groups");
    }
  }

  const db = getD1();
  let previousRank = previousTask?.rank ?? null;
  let nextRank = nextTask?.rank ?? null;
  if (!previousTask && !nextTask) {
    const targetGroup = taskGroupSql("candidate", groupBy, targetGroupValue);
    const row = await db.prepare(
      `SELECT MAX(candidate.rank) AS last_rank FROM tasks candidate
       WHERE candidate.id <> ? AND ${targetGroup.sql}
         AND ${accessibleTaskWhere("candidate")}`,
    ).bind(
      task.id,
      ...targetGroup.bindings,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
    ).first<{ last_rank: number | null }>();
    previousRank = row?.last_rank === null || row?.last_rank === undefined
      ? null
      : Number(row.last_rank);
    nextRank = null;
  }
  let rank: number;
  try {
    rank = rankBetweenNeighbors(previousRank, nextRank);
  } catch (error) {
    throw new ConflictError(error instanceof Error ? error.message : "Task rank could not be allocated");
  }

  const expectedGroup = taskGroupSql("tasks", groupBy, expectedGroupValue);
  const targetRankGroup = taskGroupSql("ranked", groupBy, targetGroupValue);
  const neighborGuards: string[] = [];
  const neighborBindings: unknown[] = [];
  for (const [alias, neighbor] of [["previous_neighbor", previousTask], ["next_neighbor", nextTask]] as const) {
    if (!neighbor) continue;
    const neighborGroup = taskGroupSql(alias, groupBy, targetGroupValue);
    neighborGuards.push(
      `EXISTS (SELECT 1 FROM tasks ${alias}
       WHERE ${alias}.id = ? AND ${alias}.rank = ? AND ${neighborGroup.sql}
         AND ${accessibleTaskWhere(alias)})`,
    );
    neighborBindings.push(
      neighbor.id,
      neighbor.rank,
      ...neighborGroup.bindings,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
    );
  }
  const now = new Date().toISOString();
  const targetStatus = await loadStatus(task.ownerUserId, statusId, { allowArchived: true });
  const timestamps = statusTimestamps(targetStatus.category, task, now);
  const changes = changedFields([
    ["status", task.statusId, statusId],
    ["priority", task.priority, nextPriority],
    ["assigneeUserId", task.assigneeUserId, assigneeUserId],
    ["releaseId", storedReleaseId, releaseId],
    ["rank", task.rank, rank],
  ]);
  if (
    storedReleaseId !== task.releaseId &&
    Object.hasOwn(changes, "releaseId")
  ) {
    // A hidden Release may protect composition without becoming visible again.
    changes.releaseId = { before: task.releaseId, after: releaseId };
  }
  if (!Object.keys(changes).length) return task;
  const activity = activityEventStatement(db, currentUser, {
    taskId: task.id,
    eventType: statusId !== task.statusId ? "status_changed" : "task_updated",
    payload: { changes, reorder: true },
    createdAt: now,
  });
  const guardSql = neighborGuards.length ? ` AND ${neighborGuards.join(" AND ")}` : "";
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
        `UPDATE tasks SET status_id = ?, priority = ?, assignee_user_id = ?,
           release_id = ?, rank = ?, started_at = ?, completed_at = ?, canceled_at = ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND ${expectedGroup.sql}
           AND ${editableTaskPredicate}${guardSql}
           AND NOT EXISTS (
             SELECT 1 FROM tasks ranked
             WHERE ranked.id <> tasks.id AND ranked.rank = ?
               AND ${targetRankGroup.sql}
               AND ${accessibleTaskWhere("ranked")}
           )
           AND (? IS NULL OR EXISTS (
             SELECT 1 FROM users assignee
             LEFT JOIN projects assignment_project
               ON assignment_project.id = tasks.project_id
             WHERE assignee.id = ?
               AND ${taskEffectiveRoleRankSql(
                 "tasks",
                 "assignment_project",
                 "assignee.id",
               )} > 0
           ))
           AND (? IS NULL OR EXISTS (
             SELECT 1 FROM releases selected_release
             WHERE selected_release.id = ?
               AND selected_release.project_id = tasks.project_id
               AND selected_release.deleted_at IS NULL
           ))
           AND (? = 1 OR release_id IS ? OR NOT EXISTS (
             SELECT 1 FROM releases locked_release
             WHERE locked_release.id IN (tasks.release_id, ?)
               AND locked_release.deleted_at IS NULL
               AND locked_release.status = 'released'
           ))`,
      ).bind(
        statusId,
        nextPriority,
        assigneeUserId,
        releaseId,
        rank,
        timestamps.startedAt,
        timestamps.completedAt,
        timestamps.canceledAt,
        now,
        task.id,
        expectedVersion,
        ...expectedGroup.bindings,
        currentUser.id,
        currentUser.id,
        currentUser.id,
        currentUser.id,
        ...neighborBindings,
        rank,
        ...targetRankGroup.bindings,
        currentUser.id,
        currentUser.id,
        currentUser.id,
        currentUser.id,
        assigneeUserId,
        assigneeUserId,
        selectedRelease?.id ?? null,
        selectedRelease?.id ?? null,
        input.confirmReleasedComposition === true ? 1 : 0,
        releaseId,
        releaseId,
      ),
      activityBatchAssertion(db, `reorder_assert_${crypto.randomUUID()}`, now),
      activity.statement,
    ]);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError("Task order changed concurrently; reload and retry");
    }
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) < 1) {
    throw new ConflictError("Task order changed concurrently; reload and retry");
  }
  return loadAccessibleTask(currentUser.id, task.id);
}

function reorderGroupBy(value: unknown): "none" | "status" | "priority" | "assignee" | "project" | "release" {
  if (value === "none" || value === "status" || value === "priority" || value === "assignee" || value === "project" || value === "release") return value;
  throw new ValidationError("Task reorder group is invalid");
}

function reorderGroupValue(
  groupBy: "none" | "status" | "priority" | "assignee" | "project" | "release",
  value: unknown,
): string | null {
  if (groupBy === "none") {
    if (value !== null) throw new ValidationError("Ungrouped Task reorder value must be null");
    return null;
  }
  if ((groupBy === "assignee" || groupBy === "release") && value === null) return null;
  if (typeof value !== "string" || !value || value.length > 240) {
    throw new ValidationError("Task reorder group value is invalid");
  }
  return value;
}

function optionalTaskNeighbor(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value || value.length > 240) {
    throw new ValidationError("Task reorder neighbor is invalid");
  }
  return value;
}

function taskGroupSql(
  alias: string,
  groupBy: "none" | "status" | "priority" | "assignee" | "project" | "release",
  value: string | null,
): { sql: string; bindings: unknown[] } {
  if (groupBy === "none") return { sql: "1 = 1", bindings: [] };
  if (groupBy === "release") {
    const activeRelease = `${alias}_active_release`;
    return value === null
      ? {
          sql: `(${alias}.release_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM releases ${activeRelease}
            WHERE ${activeRelease}.id = ${alias}.release_id
              AND ${activeRelease}.deleted_at IS NULL
          ))`,
          bindings: [],
        }
      : {
          sql: `(${alias}.release_id = ? AND EXISTS (
            SELECT 1 FROM releases ${activeRelease}
            WHERE ${activeRelease}.id = ${alias}.release_id
              AND ${activeRelease}.deleted_at IS NULL
          ))`,
          bindings: [value],
        };
  }
  const column = {
    status: "status_id",
    priority: "priority",
    assignee: "assignee_user_id",
    project: "project_id",
  }[groupBy];
  return value === null
    ? { sql: `${alias}.${column} IS NULL`, bindings: [] }
    : { sql: `${alias}.${column} = ?`, bindings: [value] };
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

  const storedReleaseId = internalTaskReleaseId(task);
  const currentRelease = storedReleaseId
    ? await loadAccessibleStoredRelease(currentUser.id, storedReleaseId)
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
  } else if (storedReleaseId) {
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
  if (internalTaskParentId(task) || Number(hierarchy?.has_children ?? 0) === 1) {
    throw new ValidationError(
      "Detach or reparent this Task hierarchy before moving it to another Project",
    );
  }
  const relation = await getD1()
    .prepare(
      `SELECT 1 AS related FROM task_relations
       WHERE type = 'duplicate_of'
         AND (source_task_id = ? OR target_task_id = ?) LIMIT 1`,
    )
    .bind(task.id, task.id)
    .first<{ related: number }>();
  if (relation) {
    throw new ValidationError(
      "Unlink the duplicate relation before moving this Task to another Project",
    );
  }

  const now = new Date().toISOString();
  const db = getD1();
  const guardSql = `
    SELECT 1
    FROM tasks moving
    JOIN projects source ON source.id = moving.project_id
    JOIN projects target ON target.id = ?
    CROSS JOIN (SELECT ? AS id) mutation_actor
    WHERE moving.id = ? AND moving.version = ? AND moving.project_id = ?
      AND moving.deleted_at IS NULL
      AND source.deleted_at IS NULL AND target.deleted_at IS NULL
      AND target.archived_at IS NULL AND target.status <> 'canceled'
      AND ${taskEffectiveRoleRankSql(
        "moving",
        "source",
        "mutation_actor.id",
      )} >= 2
      AND ${projectEffectiveRoleRankSql("target", "mutation_actor.id")} >= 2
      AND moving.parent_task_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM tasks child WHERE child.parent_task_id = moving.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_relations relation
        WHERE relation.type = 'duplicate_of'
          AND (relation.source_task_id = moving.id
            OR relation.target_task_id = moving.id)
      )
      AND (
        ? IS NULL OR EXISTS (
          SELECT 1 FROM releases selected_release
          WHERE selected_release.id = ?
            AND selected_release.project_id = target.id
            AND selected_release.deleted_at IS NULL
        )
      )
      AND (
        ? IS NULL OR EXISTS (
          SELECT 1 FROM users assignee
          WHERE assignee.id = ? AND (
            ${projectEffectiveRoleRankSql("target", "assignee.id")} > 0
            OR EXISTS (
              SELECT 1 FROM team_grants explicit_task_grant
              JOIN teams explicit_task_team
                ON explicit_task_team.id = explicit_task_grant.team_id
                AND explicit_task_team.archived_at IS NULL
              JOIN team_memberships explicit_task_member
                ON explicit_task_member.team_id = explicit_task_team.id
                AND explicit_task_member.user_id = assignee.id
                AND explicit_task_member.status = 'active'
                AND explicit_task_member.deactivated_at IS NULL
              WHERE explicit_task_grant.resource_type = 'task'
                AND explicit_task_grant.resource_id = moving.id
                AND explicit_task_grant.revoked_at IS NULL
            )
          )
        )
      )
      AND (
        ? = 1 OR NOT EXISTS (
          SELECT 1 FROM releases locked_release
          WHERE locked_release.id IN (moving.release_id, ?)
            AND locked_release.deleted_at IS NULL
            AND locked_release.status = 'released'
        )
      )`;
  const guardBindings = [
    targetProject.id,
    currentUser.id,
    task.id,
    expectedVersion,
    sourceProject.id,
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
      touchProjectSyncMarker(db, sourceProject.id, now),
      moveBatchAssertion(db, `${assertionId}_source`, "source-project"),
      db
        .prepare(
          `INSERT OR IGNORE INTO task_identifier_aliases
             (id, task_id, identifier, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(aliasId, task.id, task.identifier, now),
      activityInsert,
      invalidateTaskRelationDetails(db, task.id),
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

function invalidateTaskRelationDetails(db: D1Database, taskId: string) {
  return db.prepare(
    `INSERT INTO workspace_sync_invalidations (task_id, invalidation_type)
     SELECT affected.task_id, 'task_detail'
     FROM (
       SELECT ? AS task_id
       UNION
       SELECT CASE
         WHEN relation.source_task_id = ? THEN relation.target_task_id
         ELSE relation.source_task_id
       END AS task_id
       FROM task_relations relation
       WHERE relation.source_task_id = ? OR relation.target_task_id = ?
     ) affected`,
  ).bind(taskId, taskId, taskId, taskId);
}

function touchProjectSyncMarker(
  db: D1Database,
  projectId: string,
  touchedAt: string,
) {
  // Scope-changing child triggers carry only the child id, so the owner's
  // journal cannot reconstruct an old Project after the row changes scope. An
  // ordinary Project UPDATE publishes the existing Project event and gives
  // that exact route a marker. Deliberately do not bump version: a
  // composition-only marker must not invalidate compatible Project edit CAS.
  return db.prepare(
    `UPDATE projects SET updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).bind(touchedAt, projectId);
}

function isConstraintError(error: unknown) {
  return error instanceof Error && /constraint|unique|not null/i.test(error.message);
}

export async function bulkMoveTasks(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const ids = Array.isArray(input.ids) ? [...new Set(input.ids.map(String))] : [];
  if (ids.length === 0 || ids.length > 100) {
    throw new ValidationError("Select between 1 and 100 tasks");
  }
  if (!input.targetProjectId) {
    throw new ValidationError("Target Project is required");
  }
  const tasks = await loadAccessibleTasks(currentUser.id, ids);
  tasks.forEach((task) => requireContentEdit(task.accessRole));
  const versionInput = input.versions;
  if (!versionInput || typeof versionInput !== "object" || Array.isArray(versionInput)) {
    throw new ValidationError("Expected task versions are required");
  }
  const versions = versionInput as Record<string, unknown>;
  const expectedVersions = new Map<string, number>();
  tasks.forEach((task, index) => {
    const address = ids[index]!;
    const expected = Number(versions[address] ?? versions[task.id] ?? versions[task.publicId]);
    if (!Number.isInteger(expected) || expected !== task.version) {
      throw new ConflictError("One or more tasks changed in another session");
    }
    expectedVersions.set(task.id, expected);
  });

  const targetProject = await loadAccessibleProject(
    currentUser.id,
    String(input.targetProjectId),
  );
  requireContentEdit(targetProject.accessRole);
  if (targetProject.archivedAt || targetProject.status === "canceled") {
    throw new ValidationError("Tasks cannot be moved to this Project");
  }
  const movingTasks = tasks.filter((task) => task.projectId !== targetProject.id);
  if (!movingTasks.length) return tasks;
  if (movingTasks.some((task) => task.archivedAt)) {
    throw new ValidationError("Restore archived Tasks before moving them");
  }
  for (const sourceProjectId of new Set(movingTasks.map((task) => task.projectId))) {
    if (!sourceProjectId) throw new ValidationError("Every moved Task must have a Project");
    const sourceProject = await loadAccessibleProject(currentUser.id, sourceProjectId);
    requireContentEdit(sourceProject.accessRole);
  }

  const db = getD1();
  const placeholders = movingTasks.map(() => "?").join(", ");
  const hierarchy = await db.prepare(
    `SELECT id FROM tasks
     WHERE id IN (${placeholders}) AND (
       parent_task_id IS NOT NULL OR EXISTS (
         SELECT 1 FROM tasks child WHERE child.parent_task_id = tasks.id
       )
     ) LIMIT 1`,
  ).bind(...movingTasks.map((task) => task.id)).first<DbRow>();
  if (hierarchy) {
    throw new ValidationError("Detach or reparent selected Task hierarchies before moving them");
  }
  const relation = await db.prepare(
    `SELECT 1 AS related FROM task_relations
     WHERE type = 'duplicate_of'
       AND (source_task_id IN (${placeholders})
         OR target_task_id IN (${placeholders}))
       AND NOT (
         source_task_id IN (${placeholders})
         AND target_task_id IN (${placeholders})
       )
     LIMIT 1`,
  ).bind(
    ...movingTasks.map((task) => task.id),
    ...movingTasks.map((task) => task.id),
    ...movingTasks.map((task) => task.id),
    ...movingTasks.map((task) => task.id),
  ).first<{ related: number }>();
  if (relation) {
    throw new ValidationError(
      "Move both duplicate relation endpoints together or unlink the relation first",
    );
  }

  const clearRelease = input.clearRelease === true;
  if (movingTasks.some((task) => internalTaskReleaseId(task)) && !clearRelease) {
    throw new ValidationError("Confirm clearing incompatible Releases before moving Tasks");
  }
  const currentReleases = await Promise.all(
    [...new Set(movingTasks.map(internalTaskReleaseId).filter((id): id is string => Boolean(id)))]
      .map((releaseId) => loadAccessibleStoredRelease(currentUser.id, releaseId)),
  );
  if (
    currentReleases.some((release) => release.status === "released") &&
    input.confirmReleasedComposition !== true
  ) {
    throw new ValidationError("Confirm changing the composition of a released Release");
  }

  const clearAssignee = input.clearAssignee === true;
  const nextAssignees = new Map<string, string | null>();
  for (const task of movingTasks) {
    let nextAssignee = task.assigneeUserId;
    try {
      await assertTaskAssigneeAccess(
        nextAssignee,
        task.ownerUserId,
        targetProject.id,
        task.id,
      );
    } catch (error) {
      if (!(error instanceof ValidationError) || !clearAssignee) throw new ValidationError(
        "Confirm clearing assignees without access to the target Project",
      );
      nextAssignee = null;
    }
    nextAssignees.set(task.id, nextAssignee);
  }

  const allocation = await db.prepare(
    `SELECT MAX(
       p.task_sequence,
       COALESCE((SELECT MAX(t.sequence_number) FROM tasks t WHERE t.project_id = p.id), 0)
     ) AS base_sequence
     FROM projects p WHERE p.id = ?`,
  ).bind(targetProject.id).first<{ base_sequence: number }>();
  const allocationBase = Number(allocation?.base_sequence ?? targetProject.taskSequence);
  const nextSequence = allocationBase + movingTasks.length;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  const mutationIndexes: number[] = [];
  statements.push(
    db.prepare(
      `UPDATE projects SET task_sequence = ?, code_locked_at = COALESCE(code_locked_at, ?),
         version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND task_sequence = ?
         AND archived_at IS NULL AND deleted_at IS NULL
         AND status <> 'canceled' AND EXISTS (
           SELECT 1 FROM (SELECT ? AS id) mutation_actor
           WHERE ${projectEffectiveRoleRankSql(
             "projects",
             "mutation_actor.id",
           )} >= 2
         )`,
    ).bind(
      nextSequence,
      now,
      now,
      targetProject.id,
      targetProject.version,
      targetProject.taskSequence,
      currentUser.id,
    ),
    moveBatchAssertion(db, `bulk_move_allocator_${crypto.randomUUID()}`, "allocator"),
  );

  movingTasks.forEach((task, index) => {
    const sequenceNumber = allocationBase + index + 1;
    const identifier = `${targetProject.taskCode}-${sequenceNumber}`;
    const assigneeUserId = nextAssignees.get(task.id) ?? null;
    const expectedVersion = expectedVersions.get(task.id)!;
    mutationIndexes.push(statements.length);
    const activity = activityEventStatement(db, currentUser, {
      taskId: task.id,
      eventType: "task_moved",
      payload: {
        changes: {
          project: { before: { id: task.projectId }, after: { id: targetProject.id, name: targetProject.name } },
          identifier: { before: task.identifier, after: identifier },
          releaseId: { before: task.releaseId, after: null },
          assigneeUserId: { before: task.assigneeUserId, after: assigneeUserId },
        },
        bulk: true,
      },
      createdAt: now,
    });
    statements.push(
      db.prepare(
        `UPDATE tasks SET project_id = ?, sequence_number = ?, identifier = ?,
           release_id = NULL, assignee_user_id = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND project_id = ? AND archived_at IS NULL
           AND parent_task_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM tasks child WHERE child.parent_task_id = tasks.id)
           AND NOT EXISTS (
             SELECT 1 FROM task_relations relation
             WHERE relation.type = 'duplicate_of'
               AND (relation.source_task_id = tasks.id
                 OR relation.target_task_id = tasks.id)
               AND NOT (
                 relation.source_task_id IN (${placeholders})
                 AND relation.target_task_id IN (${placeholders})
               )
           )
           AND ${editableTaskPredicate}
           AND EXISTS (
             SELECT 1 FROM projects target
             CROSS JOIN (SELECT ? AS id) mutation_actor
             WHERE target.id = ? AND target.archived_at IS NULL
               AND target.deleted_at IS NULL AND target.status <> 'canceled'
               AND ${projectEffectiveRoleRankSql(
                 "target",
                 "mutation_actor.id",
               )} >= 2
           )
           AND (? IS NULL OR EXISTS (
             SELECT 1 FROM users assignee WHERE assignee.id = ? AND EXISTS (
               SELECT 1 FROM projects target
               WHERE target.id = ? AND (
                 ${projectEffectiveRoleRankSql("target", "assignee.id")} > 0
                 OR EXISTS (
                   SELECT 1 FROM team_grants explicit_task_grant
                   JOIN teams explicit_task_team
                     ON explicit_task_team.id = explicit_task_grant.team_id
                     AND explicit_task_team.archived_at IS NULL
                   JOIN team_memberships explicit_task_member
                     ON explicit_task_member.team_id = explicit_task_team.id
                     AND explicit_task_member.user_id = assignee.id
                     AND explicit_task_member.status = 'active'
                     AND explicit_task_member.deactivated_at IS NULL
                   WHERE explicit_task_grant.resource_type = 'task'
                     AND explicit_task_grant.resource_id = tasks.id
                     AND explicit_task_grant.revoked_at IS NULL
                 )
               )
             )
           ))
           AND (? = 1 OR NOT EXISTS (
             SELECT 1 FROM releases current_release
             WHERE current_release.id = tasks.release_id
               AND current_release.deleted_at IS NULL
               AND current_release.status = 'released'
           ))`,
      ).bind(
        targetProject.id,
        sequenceNumber,
        identifier,
        assigneeUserId,
        now,
        task.id,
        expectedVersion,
        task.projectId,
        ...movingTasks.map((movingTask) => movingTask.id),
        ...movingTasks.map((movingTask) => movingTask.id),
        currentUser.id,
        currentUser.id,
        currentUser.id,
        currentUser.id,
        currentUser.id,
        targetProject.id,
        assigneeUserId,
        assigneeUserId,
        targetProject.id,
        input.confirmReleasedComposition === true ? 1 : 0,
      ),
      moveBatchAssertion(db, `bulk_move_task_${crypto.randomUUID()}`, "task"),
      db.prepare(
        `INSERT OR IGNORE INTO task_identifier_aliases
           (id, task_id, identifier, created_at) VALUES (?, ?, ?, ?)`,
      ).bind(`alias_${crypto.randomUUID()}`, task.id, task.identifier, now),
      activity.statement,
      invalidateTaskRelationDetails(db, task.id),
    );
  });
  for (const sourceProjectId of new Set(
    movingTasks.map((task) => task.projectId),
  )) {
    statements.push(
      touchProjectSyncMarker(db, sourceProjectId, now),
      moveBatchAssertion(
        db,
        `bulk_move_source_${crypto.randomUUID()}`,
        "source-project",
      ),
    );
  }

  let results: D1Result<unknown>[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError("Bulk Project move changed concurrently and was rolled back");
    }
    throw error;
  }
  if (
    (results[0]?.meta.changes ?? 0) < 1 ||
    mutationIndexes.some((index) => (results[index]?.meta.changes ?? 0) < 1)
  ) {
    throw new ConflictError("Bulk Project move changed concurrently and was rolled back");
  }
  return loadAccessibleTasks(currentUser.id, ids);
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
  if (
    field !== "statusId" &&
    field !== "priority" &&
    field !== "archived" &&
    field !== "assigneeUserId" &&
    field !== "releaseId"
  ) {
    throw new ValidationError("Unsupported bulk action");
  }
  const tasks = await loadAccessibleTasks(currentUser.id, ids);
  tasks.forEach((task) => requireContentEdit(task.accessRole));
  const versionInput = input.versions;
  if (!versionInput || typeof versionInput !== "object" || Array.isArray(versionInput)) {
    throw new ValidationError("Expected task versions are required");
  }
  const versions = versionInput as Record<string, unknown>;
  const expectedVersions = new Map<string, number>();
  tasks.forEach((task, index) => {
    const address = ids[index]!;
    const expected = Number(
      versions[address] ?? versions[task.id] ?? versions[task.publicId],
    );
    if (!Number.isInteger(expected) || expected !== task.version) {
      throw new ConflictError("One or more tasks changed in another session");
    }
    expectedVersions.set(task.id, expected);
  });
  const now = new Date().toISOString();
  const db = getD1();
  const nextPriority = field === "priority" ? priority(input.value) : null;
  const nextAssigneeUserId = field === "assigneeUserId"
    ? requestedAssigneeUserId(input.value)
    : null;
  const nextRelease = field === "releaseId" && input.value !== null
    ? await loadAccessibleRelease(currentUser.id, String(input.value))
    : null;
  if (nextRelease) requireContentEdit(nextRelease.accessRole);
  if (
    field === "releaseId" &&
    nextRelease &&
    tasks.some((task) => task.projectId !== nextRelease.projectId)
  ) {
    throw new ValidationError("Selected Release is not compatible with every Task Project");
  }
  if (field === "releaseId") {
    const currentReleases = new Map(
      (await Promise.all(
        [...new Set(tasks.map(internalTaskReleaseId).filter((id): id is string => Boolean(id)))]
          .map((releaseId) => loadAccessibleStoredRelease(currentUser.id, releaseId)),
      )).map((release) => [release.id, release] as const),
    );
    for (const task of tasks) {
      const storedReleaseId = internalTaskReleaseId(task);
      const currentRelease = storedReleaseId
        ? currentReleases.get(storedReleaseId) ?? null
        : null;
      assertReleasedCompositionChange(currentRelease, nextRelease, input);
    }
  }
  if (field === "assigneeUserId") {
    for (const task of tasks) {
      await assertTaskAssigneeAccess(
        nextAssigneeUserId,
        task.ownerUserId,
        task.projectId,
        task.id,
      );
    }
  }
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
             WHERE id = ? AND version = ? AND ${editableTaskPredicate}`,
        )
        .bind(
          nextPriority,
          now,
          task.id,
          expectedVersions.get(task.id),
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
           WHERE id = ? AND version = ? AND ${editableTaskPredicate}`,
        )
        .bind(
          nextArchivedAt,
          now,
          task.id,
          expectedVersions.get(task.id),
          currentUser.id,
          currentUser.id,
          currentUser.id,
          currentUser.id,
        );
      eventType = desiredArchived ? "task_archived" : "task_restored";
      changes = { archivedAt: { before: task.archivedAt, after: nextArchivedAt } };
    } else if (field === "statusId") {
      if (task.statusId === targetStatus!.id) continue;
      const timestamps = statusTimestamps(targetStatus!.category, task, now);
      update = db
        .prepare(
          `UPDATE tasks SET status_id = ?, started_at = ?, completed_at = ?,
            canceled_at = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND ${editableTaskPredicate}`,
        )
        .bind(
          targetStatus!.id,
          timestamps.startedAt,
          timestamps.completedAt,
          timestamps.canceledAt,
          now,
          task.id,
          expectedVersions.get(task.id),
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
    } else if (field === "assigneeUserId") {
      if (task.assigneeUserId === nextAssigneeUserId) continue;
      update = db
        .prepare(
          `UPDATE tasks SET assignee_user_id = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND ${editableTaskPredicate}
             AND (
               ? IS NULL OR EXISTS (
                 SELECT 1 FROM users assignee
                 LEFT JOIN projects assignment_project
                   ON assignment_project.id = tasks.project_id
                 WHERE assignee.id = ?
                   AND ${taskEffectiveRoleRankSql(
                     "tasks",
                     "assignment_project",
                     "assignee.id",
                   )} > 0
               )
             )`,
        )
        .bind(
          nextAssigneeUserId,
          now,
          task.id,
          expectedVersions.get(task.id),
          currentUser.id,
          currentUser.id,
          currentUser.id,
          currentUser.id,
          nextAssigneeUserId,
          nextAssigneeUserId,
        );
      eventType = "task_updated";
      changes = {
        assigneeUserId: {
          before: task.assigneeUserId,
          after: nextAssigneeUserId,
        },
      };
    } else {
      if (internalTaskReleaseId(task) === nextRelease?.id) continue;
      update = db
        .prepare(
          `UPDATE tasks SET release_id = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND ${editableTaskPredicate}
             AND (? IS NULL OR EXISTS (
               SELECT 1 FROM releases selected_release
               WHERE selected_release.id = ?
                 AND selected_release.project_id = tasks.project_id
                 AND selected_release.deleted_at IS NULL
             ))
             AND (? = 1 OR NOT EXISTS (
               SELECT 1 FROM releases locked_release
               WHERE locked_release.id IN (tasks.release_id, ?)
                 AND locked_release.deleted_at IS NULL
                 AND locked_release.status = 'released'
             ))`,
        )
        .bind(
          nextRelease?.id ?? null,
          now,
          task.id,
          expectedVersions.get(task.id),
          currentUser.id,
          currentUser.id,
          currentUser.id,
          currentUser.id,
          nextRelease?.id ?? null,
          nextRelease?.id ?? null,
          input.confirmReleasedComposition === true ? 1 : 0,
          nextRelease?.id ?? null,
        );
      eventType = "task_updated";
      changes = {
        releaseId: {
          before: task.releaseId,
          after: nextRelease?.id ?? null,
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
export type LabelGroupSettingsRecord = LabelGroupRecord & { taskCount: number; labelCount: number };

export async function listOwnedLabelGroups(
  currentUser: UserRecord,
): Promise<LabelGroupSettingsRecord[]> {
  const rows = await getD1().prepare(
    `SELECT g.*, COUNT(DISTINCT l.id) AS label_count,
       COUNT(DISTINCT tl.task_id) AS task_count
     FROM label_groups g
     LEFT JOIN labels l ON l.group_id = g.id
     LEFT JOIN task_labels tl ON tl.label_id = l.id
     WHERE g.owner_user_id = ?
     GROUP BY g.id
     ORDER BY g.archived_at IS NOT NULL, g.position, lower(g.name), g.id`,
  ).bind(currentUser.id).all<DbRow>();
  return rows.results.map((row) => ({
    ...mapLabelGroup(row),
    taskCount: Number(row.task_count ?? 0),
    labelCount: Number(row.label_count ?? 0),
  }));
}

export async function createLabelGroup(currentUser: UserRecord, input: Record<string, unknown>) {
  const name = labelGroupName(input.name);
  const description = optionalText(input.description, 2_000);
  await assertUniqueActiveLabelGroupName(currentUser.id, name);
  const position = Object.hasOwn(input, "position")
    ? labelGroupPosition(input.position)
    : Number((await getD1().prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM label_groups WHERE owner_user_id = ?",
    ).bind(currentUser.id).first<{ position: number }>())?.position ?? 0);
  const now = new Date().toISOString();
  try {
    await getD1().prepare(
      `INSERT INTO label_groups
       (id, owner_user_id, name, description, position, archived_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    ).bind(`label-group:${currentUser.id}:${crypto.randomUUID()}`, currentUser.id, name, description, position, now, now).run();
  } catch (error) {
    translateLabelGroupNameCollision(error);
  }
  return listOwnedLabelGroups(currentUser);
}

export async function updateLabelGroup(
  currentUser: UserRecord,
  groupId: string,
  input: Record<string, unknown>,
) {
  const current = await loadOwnedLabelGroup(currentUser.id, groupId);
  const version = expectedLabelVersion(input.version);
  if (current.version !== version) throw new ConflictError("Label Group was changed in another session");
  const action = input.action ?? "update";
  const now = new Date().toISOString();
  let result: D1Result<unknown>;
  if (action === "archive") {
    if (current.archivedAt) throw new ConflictError("Label Group is already archived");
    result = await getD1().prepare(
      `UPDATE label_groups SET archived_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NULL`,
    ).bind(now, now, groupId, currentUser.id, version).run();
  } else if (action === "restore") {
    if (!current.archivedAt) throw new ConflictError("Label Group is not archived");
    await assertUniqueActiveLabelGroupName(currentUser.id, current.name, current.id);
    try {
      result = await getD1().prepare(
        `UPDATE label_groups SET archived_at = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NOT NULL`,
      ).bind(now, groupId, currentUser.id, version).run();
    } catch (error) {
      translateLabelGroupNameCollision(error);
    }
  } else if (action === "update") {
    if (current.archivedAt) throw new ValidationError("Restore an archived Label Group before editing it");
    const name = Object.hasOwn(input, "name") ? labelGroupName(input.name) : current.name;
    const description = Object.hasOwn(input, "description") ? optionalText(input.description, 2_000) : current.description;
    const position = Object.hasOwn(input, "position") ? labelGroupPosition(input.position) : current.position;
    if (name.toLocaleLowerCase() !== current.name.toLocaleLowerCase()) {
      await assertUniqueActiveLabelGroupName(currentUser.id, name, current.id);
    }
    try {
      result = await getD1().prepare(
        `UPDATE label_groups SET name = ?, description = ?, position = ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NULL`,
      ).bind(name, description, position, now, groupId, currentUser.id, version).run();
    } catch (error) {
      translateLabelGroupNameCollision(error);
    }
  } else {
    throw new ValidationError("Unsupported Label Group action");
  }
  if ((result!.meta.changes ?? 0) < 1) throw new ConflictError("Label Group was changed in another session");
  return listOwnedLabelGroups(currentUser);
}

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
  const group = input.groupId == null || input.groupId === ""
    ? null
    : await loadOwnedLabelGroup(currentUser.id, requiredLabelGroupId(input.groupId));
  if (group?.archivedAt) throw new ValidationError("Archived Label Groups cannot receive Labels");
  await assertUniqueActiveLabelName(currentUser.id, name);
  const now = new Date().toISOString();
  try {
    await getD1().prepare(
      `INSERT INTO labels
        (id, owner_user_id, group_id, name, color, description, archived_at,
         version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    ).bind(
      `label:${currentUser.id}:${crypto.randomUUID()}`,
      currentUser.id,
      group?.id ?? null,
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
    const nextGroup = !Object.hasOwn(input, "groupId")
      ? (current.groupId ? await loadOwnedLabelGroup(currentUser.id, current.groupId) : null)
      : input.groupId == null || input.groupId === ""
        ? null
        : await loadOwnedLabelGroup(currentUser.id, requiredLabelGroupId(input.groupId));
    if (nextGroup?.archivedAt) throw new ValidationError("Archived Label Groups cannot receive Labels");
    if (name.toLocaleLowerCase() !== current.name.toLocaleLowerCase()) {
      await assertUniqueActiveLabelName(currentUser.id, name, current.id);
    }
    try {
      if (nextGroup?.id !== current.groupId) {
        if (nextGroup) {
          const conflict = await getD1().prepare(
            `SELECT COUNT(DISTINCT moving.task_id) AS count
             FROM task_labels moving
             JOIN task_labels existing ON existing.task_id = moving.task_id
             JOIN labels existing_label ON existing_label.id = existing.label_id
             WHERE moving.label_id = ? AND existing_label.group_id = ? AND existing.label_id <> ?`,
          ).bind(labelId, nextGroup.id, labelId).first<{ count: number }>();
          const count = Number(conflict?.count ?? 0);
          if (count > 0) throw new ConflictError(`Moving this Label would create group conflicts on ${count} Task${count === 1 ? "" : "s"}`);
        }
        // label_group_label_move_sync is the single authority for rebuilding
        // the derived exclusivity guard. Keeping this as one UPDATE also makes
        // the version check, conflict trigger, and guard rewrite atomic.
        result = await getD1().prepare(
          `UPDATE labels SET group_id = ?, name = ?, color = ?, description = ?,
             version = version + 1, updated_at = ?
           WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NULL`,
        ).bind(nextGroup?.id ?? null, name, color, description, now, labelId, currentUser.id, version).run();
      } else {
        result = await getD1().prepare(
          `UPDATE labels SET name = ?, color = ?, description = ?,
             version = version + 1, updated_at = ?
           WHERE id = ? AND owner_user_id = ? AND version = ? AND archived_at IS NULL`,
        ).bind(name, color, description, now, labelId, currentUser.id, version).run();
      }
    } catch (error) {
      translateLabelUpdateCollision(error);
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
  const [groups, labels, assignments] = await db.batch<DbRow>([
    db.prepare(
      `SELECT * FROM label_groups
       WHERE owner_user_id = ? AND (
         archived_at IS NULL OR EXISTS (
           SELECT 1 FROM task_label_group_values value
           WHERE value.task_id = ? AND value.group_id = label_groups.id
         )
       ) ORDER BY archived_at IS NOT NULL, position, lower(name), id`,
    ).bind(task.ownerUserId, task.id),
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
    labelGroups: groups.results.map(mapLabelGroup),
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
  const [groups, rows] = await getD1().batch<DbRow>([
    getD1().prepare(
      `SELECT * FROM label_groups
       WHERE owner_user_id = ? AND (? = 1 OR archived_at IS NULL)
       ORDER BY archived_at IS NOT NULL, position, lower(name), id`,
    ).bind(project.ownerUserId, includeArchived ? 1 : 0),
    getD1().prepare(
      `SELECT * FROM labels
       WHERE owner_user_id = ? AND (? = 1 OR archived_at IS NULL)
       ORDER BY group_id IS NULL, lower(name), id`,
    ).bind(project.ownerUserId, includeArchived ? 1 : 0),
  ]);
  return { labelGroups: groups.results.map(mapLabelGroup), labels: rows.results.map(mapLabel) };
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
  if (active && label.groupId) {
    return setTaskLabelGroupValue(currentUser, task.id, {
      groupId: label.groupId,
      labelId: label.id,
    });
  }
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
         AND ${editableTaskPredicate}`,
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
         WHERE tasks.id = task_labels.task_id AND ${editableTaskPredicate}
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
      throw new ConflictError(label.groupId
        ? "Task Label Group value changed concurrently; use the explicit set-group-value command"
        : "Task access or Label state changed before the assignment committed");
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

export async function replaceTaskLabels(
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
  const currentRows = await getD1().prepare(
    `SELECT tl.label_id, l.name
     FROM task_labels tl JOIN labels l ON l.id = tl.label_id
     WHERE tl.task_id = ? ORDER BY tl.label_id`,
  ).bind(task.id).all<{ label_id: string; name: string }>();
  const currentIds = currentRows.results.map((row) => row.label_id).sort();
  const labelIds = await validateReplacementLabelIds(
    task.ownerUserId,
    input.labelIds,
    new Set(currentIds),
  );
  const nextIds = [...labelIds].sort();
  if (JSON.stringify(currentIds) === JSON.stringify(nextIds)) {
    return getTaskLabelState(currentUser, task.id);
  }

  const labels = labelIds.length
      ? await getD1().prepare(
        `SELECT id, name FROM labels
         WHERE owner_user_id = ?
           AND id IN (${sqlPlaceholders(labelIds)})
         ORDER BY id`,
      ).bind(task.ownerUserId, ...labelIds).all<{ id: string; name: string }>()
    : { results: [] as Array<{ id: string; name: string }> };
  const now = new Date().toISOString();
  const db = getD1();
  const activity = activityEventStatement(db, currentUser, {
    taskId: task.id,
    eventType: "labels_changed",
    payload: {
      replace: true,
      before: currentRows.results.map((row) => ({ id: row.label_id, name: row.name })),
      after: labels.results.map((label) => ({ id: label.id, name: label.name })),
    },
    createdAt: now,
  });
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE tasks SET version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND ${editableTaskPredicate}`,
    ).bind(
      now,
      task.id,
      expectedVersion,
      currentUser.id,
      currentUser.id,
      currentUser.id,
      currentUser.id,
    ),
    activityBatchAssertion(db, `activity_assert_${crypto.randomUUID()}`, now),
    db.prepare("DELETE FROM task_labels WHERE task_id = ?").bind(task.id),
  ];
  for (const labelId of labelIds) {
    statements.push(
      db.prepare(
        `INSERT INTO task_labels (task_id, label_id)
         SELECT task.id, label.id
         FROM tasks task JOIN labels label ON label.id = ?
         WHERE task.id = ? AND task.version = ?
           AND label.owner_user_id = task.owner_user_id
           AND (label.archived_at IS NULL OR ? = 1)`,
      ).bind(
        labelId,
        task.id,
        expectedVersion + 1,
        currentIds.includes(labelId) ? 1 : 0,
      ),
      activityBatchAssertion(db, `activity_assert_${crypto.randomUUID()}`, now),
    );
  }
  statements.push(activity.statement);
  try {
    await db.batch(statements);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError(
        "Task access, version, or Label catalog changed before replacement",
      );
    }
    throw error;
  }
  const state = await getTaskLabelState(currentUser, task.id);
  const applied = state.taskLabels.map((item) => item.labelId).sort();
  if (JSON.stringify(applied) !== JSON.stringify(nextIds)) {
    throw new ConflictError(
      "Task access, version, or Label catalog changed before replacement",
    );
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
  if (active && label.groupId) {
    return bulkSetTaskLabelGroupValue(currentUser, {
      ids: taskIds,
      groupId: label.groupId,
      labelId: label.id,
    });
  }
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
           WHERE tasks.id = ? AND ${editableTaskPredicate}`,
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
             WHERE tasks.id = task_labels.task_id AND ${editableTaskPredicate}
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

export async function setTaskLabelGroupValue(
  currentUser: UserRecord,
  taskId: string,
  input: Record<string, unknown>,
) {
  const task = await loadAccessibleTask(currentUser.id, taskId);
  requireContentEdit(task.accessRole);
  const group = await loadOwnedLabelGroup(task.ownerUserId, requiredLabelGroupId(input.groupId));
  const requestedLabelId = input.labelId == null || input.labelId === ""
    ? null
    : requiredLabelId(input.labelId);
  if (requestedLabelId && group.archivedAt) {
    throw new ValidationError("Archived Label Groups cannot receive new values");
  }
  const label = requestedLabelId
    ? await loadTaskOwnerLabel(task.ownerUserId, requestedLabelId, false)
    : null;
  if (label && label.groupId !== group.id) {
    throw new ValidationError("Label does not belong to the selected Label Group");
  }
  const db = getD1();
  const current = await db.prepare(
    `SELECT value.label_id, l.name FROM task_label_group_values value
     JOIN labels l ON l.id = value.label_id
     WHERE value.task_id = ? AND value.group_id = ?`,
  ).bind(task.id, group.id).first<{ label_id: string; name: string }>();
  if ((current?.label_id ?? null) === requestedLabelId) {
    return getTaskLabelState(currentUser, task.id);
  }
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (current) {
    statements.push(
      db.prepare(
        `DELETE FROM task_labels WHERE task_id = ? AND label_id = ? AND EXISTS (
           SELECT 1 FROM tasks WHERE tasks.id = task_labels.task_id AND ${editableTaskPredicate}
         )`,
      ).bind(task.id, current.label_id, currentUser.id, currentUser.id, currentUser.id, currentUser.id),
      activityBatchAssertion(db, `label_group_clear_assert_${crypto.randomUUID()}`, now),
    );
  }
  if (label) {
    statements.push(
      db.prepare(
        `INSERT INTO task_labels (task_id, label_id)
         SELECT tasks.id, labels.id FROM tasks, labels
         JOIN label_groups g ON g.id = labels.group_id
         WHERE tasks.id = ? AND labels.id = ? AND labels.group_id = ?
           AND labels.owner_user_id = tasks.owner_user_id
           AND labels.archived_at IS NULL AND g.archived_at IS NULL
           AND ${editableTaskPredicate}`,
      ).bind(task.id, label.id, group.id, currentUser.id, currentUser.id, currentUser.id, currentUser.id),
      activityBatchAssertion(db, `label_group_set_assert_${crypto.randomUUID()}`, now),
    );
  }
  const activity = activityEventStatement(db, currentUser, {
    taskId: task.id,
    eventType: "label_group_value_changed",
    payload: {
      group: { id: group.id, name: group.name },
      before: current ? { id: current.label_id, name: current.name } : null,
      after: label ? { id: label.id, name: label.name } : null,
    },
    createdAt: now,
  });
  statements.push(
    activity.statement,
    db.prepare(
      `UPDATE tasks SET updated_at = CASE WHEN updated_at >= ?
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds') ELSE ? END
       WHERE id = ?`,
    ).bind(now, now, task.id),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    if (isConstraintError(error)) {
      throw new ConflictError("Task Label Group value changed concurrently; reload and retry");
    }
    throw error;
  }
  const state = await getTaskLabelState(currentUser, task.id);
  const applied = state.taskLabels.find((assignment) =>
    state.labels.find((candidate) => candidate.id === assignment.labelId)?.groupId === group.id)?.labelId ?? null;
  if (applied !== requestedLabelId) throw new ConflictError("Task Label Group value changed concurrently; reload and retry");
  return state;
}

export async function bulkSetTaskLabelGroupValue(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const taskIds = Array.isArray(input.ids) ? [...new Set(input.ids.map(String))] : [];
  if (!taskIds.length || taskIds.length > 100) throw new ValidationError("Select between 1 and 100 tasks");
  const tasks = await loadAccessibleTasks(currentUser.id, taskIds);
  tasks.forEach((task) => requireContentEdit(task.accessRole));
  const ownerIds = new Set(tasks.map((task) => task.ownerUserId));
  if (ownerIds.size !== 1) throw new ValidationError("Bulk Label Group changes require Tasks from one owner catalog");
  const group = await loadOwnedLabelGroup(tasks[0]!.ownerUserId, requiredLabelGroupId(input.groupId));
  const requestedLabelId = input.labelId == null || input.labelId === "" ? null : requiredLabelId(input.labelId);
  if (requestedLabelId && group.archivedAt) throw new ValidationError("Archived Label Groups cannot receive new values");
  const label = requestedLabelId ? await loadTaskOwnerLabel(tasks[0]!.ownerUserId, requestedLabelId, false) : null;
  if (label && label.groupId !== group.id) throw new ValidationError("Label does not belong to the selected Label Group");
  const db = getD1();
  const placeholders = sqlPlaceholders(taskIds);
  const currentRows = await db.prepare(
    `SELECT value.task_id, value.label_id, l.name FROM task_label_group_values value
     JOIN labels l ON l.id = value.label_id
     WHERE value.task_id IN (${placeholders}) AND value.group_id = ?`,
  ).bind(...taskIds, group.id).all<{ task_id: string; label_id: string; name: string }>();
  const currentByTask = new Map(currentRows.results.map((row) => [row.task_id, row]));
  const changed = tasks.filter((task) => (currentByTask.get(task.id)?.label_id ?? null) !== requestedLabelId);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const task of changed) {
    const current = currentByTask.get(task.id);
    if (current) statements.push(
      db.prepare(
        `DELETE FROM task_labels WHERE task_id = ? AND label_id = ? AND EXISTS (
           SELECT 1 FROM tasks WHERE tasks.id = task_labels.task_id AND ${editableTaskPredicate}
         )`,
      ).bind(task.id, current.label_id, currentUser.id, currentUser.id, currentUser.id, currentUser.id),
      activityBatchAssertion(db, `bulk_group_clear_assert_${crypto.randomUUID()}`, now),
    );
    if (label) statements.push(
      db.prepare(
        `INSERT INTO task_labels (task_id, label_id)
         SELECT tasks.id, ? FROM tasks WHERE tasks.id = ? AND ${editableTaskPredicate}`,
      ).bind(label.id, task.id, currentUser.id, currentUser.id, currentUser.id, currentUser.id),
      activityBatchAssertion(db, `bulk_group_set_assert_${crypto.randomUUID()}`, now),
    );
    statements.push(activityEventStatement(db, currentUser, {
      taskId: task.id,
      eventType: "label_group_value_changed",
      payload: {
        group: { id: group.id, name: group.name },
        before: current ? { id: current.label_id, name: current.name } : null,
        after: label ? { id: label.id, name: label.name } : null,
        bulk: true,
      },
      createdAt: now,
    }).statement,
    db.prepare(
      `UPDATE tasks SET updated_at = CASE WHEN updated_at >= ?
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds') ELSE ? END
       WHERE id = ?`,
    ).bind(now, now, task.id));
  }
  try {
    if (statements.length) await db.batch(statements);
  } catch (error) {
    if (isConstraintError(error)) throw new ConflictError("Bulk Label Group change conflicted; no Task was changed");
    throw error;
  }
  const rows = await db.prepare(
    `SELECT task_id, label_id FROM task_labels WHERE task_id IN (${placeholders}) ORDER BY task_id, label_id`,
  ).bind(...taskIds).all<DbRow>();
  const labelRows = await db.prepare(
    `SELECT * FROM labels WHERE id IN (SELECT label_id FROM task_labels WHERE task_id IN (${placeholders}))`,
  ).bind(...taskIds).all<DbRow>();
  return { labelGroups: [group], labels: labelRows.results.map(mapLabel), taskLabels: rows.results.map(mapTaskLabel), taskIds };
}

async function validateActiveLabelIds(ownerUserId: string, value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError("Label IDs must be an array");
  const ids = [...new Set(value.map(requiredLabelId))];
  if (ids.length > 50) throw new ValidationError("A Task can have at most 50 Labels");
  if (!ids.length) return ids;
  const rows = await getD1().prepare(
    `SELECT l.id, l.group_id FROM labels l
     LEFT JOIN label_groups g ON g.id = l.group_id
     WHERE l.owner_user_id = ? AND l.archived_at IS NULL
       AND (l.group_id IS NULL OR g.archived_at IS NULL)
       AND l.id IN (${sqlPlaceholders(ids)})`,
  ).bind(ownerUserId, ...ids).all<{ id: string; group_id: string | null }>();
  if (rows.results.length !== ids.length) {
    throw new ValidationError("Every Label must be active in the Task owner catalog");
  }
  const grouped = rows.results.map((row) => row.group_id).filter((id): id is string => Boolean(id));
  if (new Set(grouped).size !== grouped.length) {
    throw new ValidationError("A Task can have at most one Label from each Label Group");
  }
  return ids;
}

async function validateReplacementLabelIds(
  ownerUserId: string,
  value: unknown,
  currentlyAssigned: ReadonlySet<string>,
) {
  if (!Array.isArray(value)) throw new ValidationError("Label IDs must be an array");
  const ids = [...new Set(value.map(requiredLabelId))];
  if (ids.length > 50) throw new ValidationError("A Task can have at most 50 Labels");
  if (!ids.length) return ids;
  const rows = await getD1().prepare(
    `SELECT id, archived_at FROM labels
     WHERE owner_user_id = ? AND id IN (${sqlPlaceholders(ids)})`,
  ).bind(ownerUserId, ...ids).all<{ id: string; archived_at: string | null }>();
  if (rows.results.length !== ids.length) {
    throw new ValidationError("Every Label must belong to the Task owner catalog");
  }
  if (rows.results.some((row) => row.archived_at && !currentlyAssigned.has(row.id))) {
    throw new ValidationError("Archived Labels cannot be newly assigned");
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

async function loadOwnedLabelGroup(ownerUserId: string, groupId: string) {
  const row = await getD1().prepare(
    "SELECT * FROM label_groups WHERE id = ? AND owner_user_id = ?",
  ).bind(groupId, ownerUserId).first<DbRow>();
  if (!row) throw new NotFoundError("Label Group not found");
  return mapLabelGroup(row);
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
  if (!allowArchived && label.groupId) {
    const group = await loadOwnedLabelGroup(ownerUserId, label.groupId);
    if (group.archivedAt) throw new ValidationError("Labels in archived Label Groups cannot be assigned");
  }
  return label;
}

async function assertUniqueActiveLabelGroupName(ownerUserId: string, name: string, exceptId?: string) {
  const row = await getD1().prepare(
    `SELECT id FROM label_groups
     WHERE owner_user_id = ? AND archived_at IS NULL AND lower(name) = lower(?)
       AND (? IS NULL OR id <> ?) LIMIT 1`,
  ).bind(ownerUserId, name, exceptId ?? null, exceptId ?? null).first();
  if (row) throw new ValidationError("An active Label Group with this name already exists");
}

function labelGroupName(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError("Label Group name is required");
  const name = value.trim();
  if (name.length > 80) throw new ValidationError("Label Group name is too long");
  return name;
}

function labelGroupPosition(value: unknown) {
  const position = Number(value);
  if (!Number.isInteger(position) || position < 0 || position > 100_000) {
    throw new ValidationError("Label Group position is invalid");
  }
  return position;
}

function requiredLabelGroupId(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 240) {
    throw new ValidationError("Label Group ID is required");
  }
  return value.trim();
}

function translateLabelGroupNameCollision(error: unknown): never {
  if (error instanceof ValidationError) throw error;
  if (error instanceof Error && /idx_label_groups_owner_name_active/i.test(error.message)) {
    throw new ValidationError("An active Label Group with this name already exists");
  }
  throw error;
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
  if (error instanceof Error && /idx_labels_owner_name_active/i.test(error.message)) {
    throw new ValidationError("An active Label with this name already exists");
  }
  throw error;
}

function translateLabelUpdateCollision(error: unknown): never {
  if (error instanceof ConflictError) throw error;
  if (error instanceof Error && (
    /at most one Label from each Label Group/i.test(error.message) ||
    /task_label_group_values\.task_id.*task_label_group_values\.group_id/i.test(error.message)
  )) {
    throw new ConflictError("Moving this Label would create a Label Group conflict");
  }
  translateLabelNameCollision(error);
}

export async function createProject(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const now = new Date().toISOString();
  const code = normalizeProjectTaskCode(input.taskCode);
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
    ? normalizeProjectTaskCode(input.taskCode)
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
       JOIN users lead ON lead.id = ?
       WHERE p.id = ?
         AND ${projectEffectiveRoleRankSql("p", "lead.id")} > 0`,
    ).bind(leadUserId, project.id).first();
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
         AND t.deleted_at IS NULL
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
       WHERE id = ? AND version = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM (SELECT ? AS id) mutation_actor
           WHERE ${projectEffectiveRoleRankSql(
             "projects",
             "mutation_actor.id",
           )} >= 2
         )
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM users lead
           WHERE lead.id = ?
             AND ${projectEffectiveRoleRankSql("projects", "lead.id")} > 0
         ))`,
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
         AND t.deleted_at IS NULL
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
     WHERE id = ? AND version = ? AND deleted_at IS NULL
       AND (
         ? = 0 OR ? = 1 OR status = 'released' OR NOT EXISTS (
           SELECT 1 FROM tasks t JOIN workflow_statuses s ON s.id = t.status_id
           WHERE t.release_id = releases.id AND t.archived_at IS NULL
             AND t.deleted_at IS NULL
             AND s.category NOT IN ('completed', 'canceled')
         )
       )
       AND EXISTS (
         SELECT 1 FROM projects p
         CROSS JOIN (SELECT ? AS id) mutation_actor
         WHERE p.id = releases.project_id
           AND p.deleted_at IS NULL
           AND ${projectEffectiveRoleRankSql("p", "mutation_actor.id")} >= 2
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
  await validateSavedViewReferences(currentUser, query, display, project);
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
  await validateSavedViewReferences(currentUser, query, display, nextScopeProject, {
    allowedMissingReleaseIds: scopeChanged
      ? new Set<string>()
      : new Set(filterReferenceValues(
          canonicalViewQuery(view.query).conditions,
          "release",
        )),
  });
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
  const db = getD1();
  const update = db.prepare(
    `UPDATE saved_views SET
       owner_user_id = ?, name = ?, scope_project_id = ?, query_json = ?,
       display_json = ?, archived_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ? AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM (SELECT ? AS id) mutation_actor
         LEFT JOIN projects p ON p.id = saved_views.scope_project_id
         WHERE (saved_views.scope_project_id IS NULL OR p.deleted_at IS NULL)
           AND ${savedViewEffectiveRoleRankSql(
             "saved_views",
             "p",
             "mutation_actor.id",
           )} >= 2
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
  );
  let result: D1Result<unknown>;
  if (scopeChanged && view.scopeProjectId) {
    const assertionId = `view_move_assert_${crypto.randomUUID()}`;
    try {
      [result] = await db.batch([
        update,
        moveBatchAssertion(db, assertionId, "saved-view"),
        touchProjectSyncMarker(db, view.scopeProjectId, now),
        moveBatchAssertion(db, `${assertionId}_source`, "source-project"),
      ]);
    } catch (error) {
      if (isConstraintError(error)) {
        throw new ConflictError(
          "Saved View access, scope, or version changed before the update committed",
        );
      }
      throw error;
    }
  } else {
    result = await update.run();
  }
  if ((result.meta.changes ?? 0) < 1) {
    throw new ConflictError("Saved View access, scope, or version changed before the update committed");
  }
  return loadAccessibleView(currentUser.id, view.id);
}

async function validateSavedViewReferences(
  currentUser: UserRecord,
  query: ViewQuery,
  display: import("./types").ViewDisplay,
  scopeProject: ProjectRecord | null,
  options: { allowedMissingReleaseIds?: ReadonlySet<string> } = {},
) {
  const canonical = canonicalViewQuery(query);
  const snapshot = await getSnapshot(currentUser);
  const projectIds = filterReferenceValues(canonical.conditions, "project");
  const releaseIds = filterReferenceValues(canonical.conditions, "release");
  const statusIds = filterReferenceValues(canonical.conditions, "status");
  const assigneeIds = filterReferenceValues(canonical.conditions, "assignee");
  const labelIds = filterReferenceValues(canonical.conditions, "label");
  const parentIds = filterReferenceValues(canonical.conditions, "parent");
  const groupRefs = labelGroupReferences(canonical.conditions, display.labelGroupId ?? null);

  if (scopeProject && projectIds.some((projectId) => projectId !== scopeProject.id)) {
    throw new ValidationError("A project-scoped Saved View cannot filter outside its Project");
  }
  let projects: ProjectRecord[];
  let releaseCandidates: Array<ReleaseRecord | null>;
  try {
    [projects, releaseCandidates] = await Promise.all([
      Promise.all(projectIds.map((id) => loadAccessibleProject(currentUser.id, id))),
      Promise.all(releaseIds.map(async (id) => {
        try {
          return await loadAccessibleRelease(currentUser.id, id);
        } catch (error) {
          if (error instanceof NotFoundError && options.allowedMissingReleaseIds?.has(id)) {
            return null;
          }
          throw error;
        }
      })),
    ]);
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw new ValidationError("Saved View project or release filter is inaccessible");
    }
    throw error;
  }
  const releases = releaseCandidates.filter(
    (release): release is ReleaseRecord => release !== null,
  );
  if (scopeProject && releases.some((release) => release?.projectId !== scopeProject.id)) {
    throw new ValidationError("Saved View release must belong to its scoped Project");
  }
  if (projects.length === 1 && releases.some(
    (release) => release.projectId !== projects[0]!.id,
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
  await validateAccessibleLabelGroupReferences(currentUser, groupRefs);
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
  allowInertMissingReferences = false,
) {
  const conditions = canonicalViewQuery(query).conditions;
  const projectIds = filterReferenceValues(conditions, "project");
  const releaseIds = filterReferenceValues(conditions, "release");
  const statusIds = filterReferenceValues(conditions, "status");
  const assigneeIds = filterReferenceValues(conditions, "assignee");
  const labelIds = filterReferenceValues(conditions, "label");
  const parentIds = filterReferenceValues(conditions, "parent");
  const groupRefs = labelGroupReferences(conditions, null);

  if (scopeProject && projectIds.some((projectId) => projectId !== scopeProject.id)) {
    throw new ValidationError("A project-scoped Saved View cannot filter outside its Project");
  }

  // Runtime filters are logical references. A reference that was later
  // deleted or purged remains a valid, inert predicate instead of disclosing
  // whether that resource still exists. Creation/update validation stays
  // strict in validateSavedViewReferences.
  const [projectCandidates, releaseCandidates] = await Promise.all([
    Promise.all(projectIds.map((id) =>
      loadAccessibleProject(currentUser.id, id).catch(() => null)
    )),
    Promise.all(releaseIds.map((id) =>
      loadAccessibleRelease(currentUser.id, id).catch(() => null)
    )),
  ]);
  const projects = projectCandidates.filter(
    (project): project is ProjectRecord => project !== null,
  );
  const releases = releaseCandidates.filter(
    (release): release is ReleaseRecord => release !== null,
  );
  if (
    !allowInertMissingReferences &&
    (projects.length !== projectIds.length || releases.length !== releaseIds.length)
  ) {
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
         CROSS JOIN (SELECT ? AS id) filter_actor
         WHERE s.id IN (${filterPlaceholders(statusIds.length)})
           AND ${catalogOwnerAccessibleSql("s.owner_user_id", "filter_actor")}`,
      ).bind(currentUser.id, ...statusIds),
    });
  }
  if (assigneeIds.length) {
    checks.push({
      ids: assigneeIds,
      message: "Saved View assignee filter is inaccessible",
      statement: db.prepare(
        `SELECT u.id FROM users u
         CROSS JOIN (SELECT ? AS id) filter_actor
         WHERE u.id IN (${filterPlaceholders(assigneeIds.length)}) AND (
           u.id = filter_actor.id OR EXISTS (
             SELECT 1 FROM projects p
             WHERE p.deleted_at IS NULL
               AND ${projectEffectiveRoleRankSql("p", "filter_actor.id")} > 0
               AND ${projectEffectiveRoleRankSql("p", "u.id")} > 0
           ) OR EXISTS (
             SELECT 1 FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
             WHERE t.deleted_at IS NULL
               AND (t.project_id IS NULL OR p.deleted_at IS NULL)
               AND ${taskEffectiveRoleRankSql("t", "p", "filter_actor.id")} > 0
               AND ${taskEffectiveRoleRankSql("t", "p", "u.id")} > 0
           )
         )`,
      ).bind(currentUser.id, ...assigneeIds),
    });
  }
  if (labelIds.length) {
    checks.push({
      ids: labelIds,
      message: "Saved View label filter is inaccessible",
      statement: db.prepare(
        `SELECT l.id FROM labels l
         CROSS JOIN (SELECT ? AS id) filter_actor
         WHERE l.id IN (${filterPlaceholders(labelIds.length)})
           AND ${catalogOwnerAccessibleSql("l.owner_user_id", "filter_actor")}`,
      ).bind(currentUser.id, ...labelIds),
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
  await validateAccessibleLabelGroupReferences(currentUser, groupRefs);
  for (const taskId of parentIds) {
    try {
      await loadAccessibleTask(currentUser.id, taskId);
    } catch {
      if (!allowInertMissingReferences) {
        throw new ValidationError("Saved View parent filter is inaccessible");
      }
    }
  }
}

function filterPlaceholders(length: number) {
  return Array.from({ length }, () => "?").join(", ");
}

function catalogOwnerAccessibleSql(
  ownerExpression: string,
  actorAlias: string,
): string {
  return `(${ownerExpression} = ${actorAlias}.id OR EXISTS (
    SELECT 1 FROM projects catalog_project
    WHERE catalog_project.owner_user_id = ${ownerExpression}
      AND catalog_project.deleted_at IS NULL
      AND ${projectEffectiveRoleRankSql(
        "catalog_project",
        `${actorAlias}.id`,
      )} > 0
  ) OR EXISTS (
    SELECT 1 FROM tasks catalog_task
    LEFT JOIN projects catalog_task_project
      ON catalog_task_project.id = catalog_task.project_id
    WHERE CASE WHEN catalog_task.project_id IS NOT NULL
        THEN catalog_task_project.owner_user_id
        ELSE catalog_task.owner_user_id END = ${ownerExpression}
      AND catalog_task.deleted_at IS NULL
      AND (catalog_task.project_id IS NULL
        OR catalog_task_project.deleted_at IS NULL)
      AND ${taskEffectiveRoleRankSql(
        "catalog_task",
        "catalog_task_project",
        `${actorAlias}.id`,
      )} > 0
  ))`;
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

function labelGroupReferences(
  conditions: ViewFilterCondition[],
  displayGroupId: string | null,
) {
  const refs = conditions
    .filter((condition) => condition.field === "label_group")
    .map((condition) => condition.value as import("./types").ViewFilterLabelGroupValue);
  const groupIds = [...new Set([
    ...refs.map((value) => value.groupId),
    ...(displayGroupId ? [displayGroupId] : []),
  ])];
  const labelIds = [...new Set(refs.flatMap((value) => value.labelIds ?? []))];
  return { groupIds, labelIds };
}

async function validateAccessibleLabelGroupReferences(
  currentUser: UserRecord,
  refs: { groupIds: string[]; labelIds: string[] },
) {
  if (!refs.groupIds.length && !refs.labelIds.length) return;
  const db = getD1();
  if (refs.groupIds.length) {
    const rows = await db.prepare(
      `SELECT g.id FROM label_groups g
       CROSS JOIN (SELECT ? AS id) filter_actor
       WHERE g.id IN (${sqlPlaceholders(refs.groupIds)})
         AND ${catalogOwnerAccessibleSql("g.owner_user_id", "filter_actor")}`,
    ).bind(currentUser.id, ...refs.groupIds).all<DbRow>();
    if (new Set(rows.results.map((row) => String(row.id))).size !== refs.groupIds.length) {
      throw new ValidationError("Saved View Label Group is inaccessible");
    }
  }
  if (refs.labelIds.length) {
    const rows = await db.prepare(
      `SELECT l.id FROM labels l
       CROSS JOIN (SELECT ? AS id) filter_actor
       WHERE l.id IN (${sqlPlaceholders(refs.labelIds)})
         AND l.group_id IN (${sqlPlaceholders(refs.groupIds)})
         AND ${catalogOwnerAccessibleSql("l.owner_user_id", "filter_actor")}`,
    ).bind(currentUser.id, ...refs.labelIds, ...refs.groupIds).all<DbRow>();
    if (new Set(rows.results.map((row) => String(row.id))).size !== refs.labelIds.length) {
      throw new ValidationError("Saved View Label Group value is inaccessible");
    }
  }
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
  let results: D1Result<unknown>[];
  try {
    results = await db.batch([
      db.prepare(
        `UPDATE projects
         SET owner_user_id = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`,
      )
      .bind(targetUserId, now, project.id, currentUser.id),
      db.prepare(
        `UPDATE access_grants SET owner_user_id = ?
         WHERE resource_type = 'project' AND resource_id = ?
           AND owner_user_id = ?`,
      )
      .bind(targetUserId, project.id, currentUser.id),
      db.prepare(
        `UPDATE access_grants SET revoked_at = ?
         WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
      )
      .bind(now, targetGrant.id, targetUserId),
      db.prepare(
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
  } catch (error) {
    if (error instanceof Error && /task_code|unique/i.test(error.message)) {
      throw new ValidationError("The new owner already has a Project with this code");
    }
    throw error;
  }
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
           CASE WHEN t.release_id IS NULL OR EXISTS (
             SELECT 1 FROM releases active_release
             WHERE active_release.id = t.release_id
               AND active_release.deleted_at IS NULL
           ) THEN t.release_id ELSE NULL END AS visible_release_id,
           CASE WHEN t.parent_task_id IS NULL OR EXISTS (
             SELECT 1 FROM tasks active_parent
             LEFT JOIN projects active_parent_project
               ON active_parent_project.id = active_parent.project_id
             WHERE active_parent.id = t.parent_task_id
               AND active_parent.deleted_at IS NULL
               AND (active_parent.project_id IS NULL
                 OR active_parent_project.deleted_at IS NULL)
           ) THEN t.parent_task_id ELSE NULL END AS visible_parent_task_id,
           ${taskAccessRoleSql("t", "p")} AS access_role
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

export async function loadAccessibleProject(userId: string, projectId: string) {
  const row = await getD1()
    .prepare(
      `WITH scoped AS (
         SELECT p.*,
           ${projectAccessRoleSql("p")} AS access_role
         FROM projects p WHERE p.id = ? OR p.public_id = ?
       ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    )
    .bind(userId, userId, projectId, projectId)
    .first<DbRow>();
  if (!row) throw new NotFoundError("Project not found");
  return mapProject(row);
}

export async function loadAccessibleRelease(userId: string, releaseId: string) {
  const row = await getD1()
    .prepare(
      `WITH scoped AS (
         SELECT r.*,
           ${projectAccessRoleSql("p")} AS access_role
         FROM releases r JOIN projects p ON p.id = r.project_id
         WHERE r.deleted_at IS NULL AND p.deleted_at IS NULL
           AND (r.id = ? OR r.public_id = ?)
       ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    )
    .bind(userId, userId, releaseId, releaseId)
    .first<DbRow>();
  if (!row) throw new NotFoundError("Release not found");
  return mapRelease(row);
}

async function loadAccessibleStoredRelease(userId: string, releaseId: string) {
  const row = await getD1()
    .prepare(
      `WITH scoped AS (
         SELECT r.*,
           ${projectAccessRoleSql("p")} AS access_role
         FROM releases r JOIN projects p ON p.id = r.project_id
         WHERE p.deleted_at IS NULL AND r.id = ?
       ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    )
    .bind(userId, userId, releaseId)
    .first<DbRow>();
  if (!row) {
    throw new ConflictError(
      "Task Release or Project access changed before the mutation",
    );
  }
  return mapRelease(row);
}

export async function loadAccessibleView(userId: string, viewId: string) {
  const row = await getD1()
    .prepare(
      `WITH scoped AS (
         SELECT v.*,
           ${savedViewAccessRoleSql("v", "p")} AS access_role
         FROM saved_views v LEFT JOIN projects p ON p.id = v.scope_project_id
         WHERE v.id = ? OR v.public_id = ?
       ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    )
    .bind(userId, userId, userId, userId, viewId, viewId)
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
           ${projectEffectiveRoleRankSql("p", "u.id")} > 0
           OR (? IS NOT NULL AND EXISTS (
             SELECT 1 FROM team_grants explicit_task_grant
             JOIN teams explicit_task_team
               ON explicit_task_team.id = explicit_task_grant.team_id
               AND explicit_task_team.archived_at IS NULL
             JOIN team_memberships explicit_task_member
               ON explicit_task_member.team_id = explicit_task_team.id
               AND explicit_task_member.user_id = u.id
               AND explicit_task_member.status = 'active'
               AND explicit_task_member.deactivated_at IS NULL
             WHERE explicit_task_grant.resource_type = 'task'
               AND explicit_task_grant.resource_id = ?
               AND explicit_task_grant.revoked_at IS NULL
           ))
         )`,
      )
      .bind(projectId, assigneeUserId, taskId, taskId)
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

function mapUser(row: DbRow): UserProfile["user"] {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    email: String(row.email),
    timezone: String(row.timezone),
    theme: String(row.theme ?? "system") as ThemePreference,
    sidebarPreference: String(row.sidebar_preference ?? "expanded") as SidebarPreference,
    version: Number(row.version ?? 1),
  };
}

function mapUserIdentity(row: DbRow): UserIdentityRecord {
  const provider = String(row.provider);
  if (provider !== "chatgpt" && provider !== "google") {
    throw new ValidationError("Unknown identity provider");
  }
  return {
    provider,
    verifiedEmail: String(row.verified_email),
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
    deletedAt: nullableString(row.deleted_at),
    deletedByUserId: nullableString(row.deleted_by_user_id),
    purgeAfter: nullableString(row.purge_after),
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
    deletedAt: nullableString(row.deleted_at),
    deletedByUserId: nullableString(row.deleted_by_user_id),
    purgeAfter: nullableString(row.purge_after),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    accessRole: effectiveRole(row.access_role),
  };
}

const internalTaskReferences = new WeakMap<
  TaskRecord,
  { releaseId: string | null; parentTaskId: string | null }
>();

function mapTask(row: DbRow): TaskRecord {
  const task: TaskRecord = {
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
    releaseId: Object.hasOwn(row, "visible_release_id")
      ? nullableString(row.visible_release_id)
      : nullableString(row.release_id),
    estimate: row.estimate == null ? null : Number(row.estimate),
    dueDate: nullableString(row.due_date),
    parentTaskId: Object.hasOwn(row, "visible_parent_task_id")
      ? nullableString(row.visible_parent_task_id)
      : nullableString(row.parent_task_id),
    rank: Number(row.rank),
    startedAt: nullableString(row.started_at),
    completedAt: nullableString(row.completed_at),
    canceledAt: nullableString(row.canceled_at),
    archivedAt: nullableString(row.archived_at),
    deletedAt: nullableString(row.deleted_at),
    deletedByUserId: nullableString(row.deleted_by_user_id),
    purgeAfter: nullableString(row.purge_after),
    commentCount: Number(row.comment_count ?? 0),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    accessRole: effectiveRole(row.access_role),
  };
  internalTaskReferences.set(task, {
    releaseId: nullableString(row.release_id),
    parentTaskId: nullableString(row.parent_task_id),
  });
  return task;
}

function internalTaskReleaseId(task: TaskRecord) {
  return internalTaskReferences.get(task)?.releaseId ?? task.releaseId;
}

function internalTaskParentId(task: TaskRecord) {
  return internalTaskReferences.get(task)?.parentTaskId ?? task.parentTaskId;
}

function mapLabel(row: DbRow): LabelRecord {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    groupId: nullableString(row.group_id),
    name: String(row.name),
    color: String(row.color),
    description: String(row.description ?? ""),
    archivedAt: nullableString(row.archived_at),
    version: Number(row.version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at ?? row.created_at),
  };
}

function mapLabelGroup(row: DbRow): LabelGroupRecord {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    description: String(row.description ?? ""),
    position: Number(row.position ?? 0),
    archivedAt: nullableString(row.archived_at),
    version: Number(row.version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at ?? row.created_at),
  };
}

async function loadLabelGroupsForLabels(rows: readonly DbRow[]): Promise<LabelGroupRecord[]> {
  const ids = [...new Set(rows.map((row) => nullableString(row.group_id)).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return [];
  const result = await getD1().prepare(
    `SELECT * FROM label_groups WHERE id IN (${sqlPlaceholders(ids)})
     ORDER BY position, lower(name), id`,
  ).bind(...ids).all<DbRow>();
  return result.results.map(mapLabelGroup);
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
    deletedAt: nullableString(row.deleted_at),
    deletedByUserId: nullableString(row.deleted_by_user_id),
    purgeAfter: nullableString(row.purge_after),
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
