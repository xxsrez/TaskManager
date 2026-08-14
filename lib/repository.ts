import type { Actor } from "./auth";
import { env } from "cloudflare:workers";
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

type DbRow = Record<string, unknown>;

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

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS user_identities (
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_account_key TEXT NOT NULL,
    verified_email TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider, provider_account_key)
  )`,
  `CREATE TABLE IF NOT EXISTS api_credentials (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_api_credentials_token_hash
    ON api_credentials(token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_api_credentials_owner_active
    ON api_credentials(owner_user_id, revoked_at)`,
  `CREATE TABLE IF NOT EXISTS oauth_registered_clients (
    id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    redirect_uris_json TEXT NOT NULL,
    grant_types_json TEXT NOT NULL,
    response_types_json TEXT NOT NULL,
    token_endpoint_auth_method TEXT NOT NULL,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_authorization_requests (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    resource TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    state TEXT,
    code_challenge TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_auth_requests_expires
    ON oauth_authorization_requests(expires_at)`,
  `CREATE TABLE IF NOT EXISTS oauth_grants (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    resource TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_grants_owner_client_resource
    ON oauth_grants(owner_user_id, client_id, resource)`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_grants_owner_active
    ON oauth_grants(owner_user_id, revoked_at)`,
  `CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    resource TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_auth_codes_hash
    ON oauth_authorization_codes(code_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_expires
    ON oauth_authorization_codes(expires_at)`,
  `CREATE TABLE IF NOT EXISTS oauth_access_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_access_tokens_hash
    ON oauth_access_tokens(token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_grant_active
    ON oauth_access_tokens(grant_id, revoked_at)`,
  `CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    family_id TEXT NOT NULL,
    parent_id TEXT,
    owner_user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_hash
    ON oauth_refresh_tokens(token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_family
    ON oauth_refresh_tokens(family_id)`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_grant_active
    ON oauth_refresh_tokens(grant_id, revoked_at)`,
  `CREATE TABLE IF NOT EXISTS workflow_statuses (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    color TEXT NOT NULL,
    position INTEGER NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_statuses_owner_name
    ON workflow_statuses(owner_user_id, name)`,
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    owner_user_id TEXT NOT NULL,
    creator_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned',
    lead_user_id TEXT,
    start_date TEXT,
    target_date TEXT,
    icon TEXT NOT NULL DEFAULT 'cube',
    color TEXT NOT NULL DEFAULT '#8b7cf6',
    archived_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_projects_owner_archived
    ON projects(owner_user_id, archived_at)`,
  `CREATE TABLE IF NOT EXISTS releases (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    creator_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned',
    target_date TEXT,
    released_at TEXT,
    release_notes TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_releases_project_status
    ON releases(project_id, status)`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    owner_user_id TEXT NOT NULL,
    creator_user_id TEXT NOT NULL,
    identifier TEXT NOT NULL,
    sequence_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status_id TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'none',
    assignee_user_id TEXT,
    project_id TEXT,
    release_id TEXT,
    estimate INTEGER,
    due_date TEXT,
    parent_task_id TEXT,
    rank REAL NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    canceled_at TEXT,
    archived_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(owner_user_id, identifier),
    UNIQUE(owner_user_id, sequence_number)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_owner_status_archived
    ON tasks(owner_user_id, status_id, archived_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_project_release
    ON tasks(project_id, release_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_parent
    ON tasks(parent_task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_release_archived
    ON tasks(release_id, archived_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_owner_updated
    ON tasks(owner_user_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS labels (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#6b7280',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(owner_user_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS task_labels (
    task_id TEXT NOT NULL,
    label_id TEXT NOT NULL,
    PRIMARY KEY(task_id, label_id)
  )`,
  `CREATE TABLE IF NOT EXISTS task_relations (
    source_task_id TEXT NOT NULL,
    target_task_id TEXT NOT NULL,
    type TEXT NOT NULL,
    creator_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(source_task_id, target_task_id, type)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_relations_target
    ON task_relations(target_task_id, type)`,
  `CREATE TABLE IF NOT EXISTS saved_views (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    scope_project_id TEXT,
    query_json TEXT NOT NULL DEFAULT '{}',
    display_json TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_saved_views_scope_project
    ON saved_views(scope_project_id)`,
  `CREATE TABLE IF NOT EXISTS external_records (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_url TEXT,
    metadata_json TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(owner_user_id, source, source_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_external_records_target
    ON external_records(target_type, target_id)`,
  `CREATE TABLE IF NOT EXISTS access_grants (
    id TEXT PRIMARY KEY,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    grantee_user_id TEXT NOT NULL,
    granted_by_user_id TEXT NOT NULL,
    permission TEXT NOT NULL DEFAULT 'viewer',
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(resource_type, resource_id, grantee_user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_access_grants_grantee_active
    ON access_grants(grantee_user_id, resource_type, resource_id)
    WHERE revoked_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_access_grants_owner_resource_active
    ON access_grants(owner_user_id, resource_type, resource_id)
    WHERE revoked_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS admin_import_sessions (
    id TEXT PRIMARY KEY,
    created_by_user_id TEXT NOT NULL,
    source_exported_at TEXT NOT NULL,
    source_schema_version INTEGER NOT NULL,
    payload_sha256 TEXT NOT NULL,
    counts_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'staged',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    applied_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_import_sessions_status_created
    ON admin_import_sessions(status, created_at)`,
  `CREATE TABLE IF NOT EXISTS admin_import_rows (
    import_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    row_json TEXT NOT NULL,
    PRIMARY KEY(import_id, table_name, ordinal)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_import_rows_import_table
    ON admin_import_rows(import_id, table_name)`,
  `CREATE TABLE IF NOT EXISTS user_import_sessions (
    id TEXT PRIMARY KEY,
    created_by_user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    source_json TEXT NOT NULL DEFAULT '{}',
    preview_json TEXT NOT NULL DEFAULT '{}',
    payload_sha256 TEXT,
    source_exported_at TEXT,
    project_id TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    applied_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_import_sessions_owner_status
    ON user_import_sessions(created_by_user_id, kind, status, expires_at)`,
  `CREATE TABLE IF NOT EXISTS user_import_rows (
    import_id TEXT NOT NULL,
    row_type TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    row_json TEXT NOT NULL,
    PRIMARY KEY(import_id, row_type, ordinal)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_import_rows_import_type
    ON user_import_rows(import_id, row_type)`,
];

const publicIdTables = [
  { table: "projects", index: "idx_projects_public_id" },
  { table: "releases", index: "idx_releases_public_id" },
  { table: "tasks", index: "idx_tasks_public_id" },
  { table: "saved_views", index: "idx_saved_views_public_id" },
] as const;

let schemaPromise: Promise<void> | null = null;

export async function ensureDatabase() {
  schemaPromise ??= (async () => {
    const db = getD1();
    await db.batch(schemaStatements.map((statement) => db.prepare(statement)));
    await db
      .prepare(
        `UPDATE access_grants
         SET permission = CASE
           WHEN resource_type = 'project' THEN 'manager'
           ELSE 'editor'
         END
         WHERE permission = 'full_access'`,
      )
      .run();
    await ensurePublicIds(db);
    await db.prepare("PRAGMA optimize").run();
  })();
  return schemaPromise;
}

async function ensurePublicIds(db: D1Database) {
  for (const { table, index } of publicIdTables) {
    const columns = await db
      .prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string }>();
    if (!columns.results.some((column) => column.name === "public_id")) {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN public_id TEXT`).run();
    }

    const missing = await db
      .prepare(
        `SELECT id FROM ${table} WHERE public_id IS NULL OR public_id = ''`,
      )
      .all<{ id: string }>();
    for (let offset = 0; offset < missing.results.length; offset += 100) {
      const updates = missing.results.slice(offset, offset + 100).map((row) =>
        db
          .prepare(`UPDATE ${table} SET public_id = ? WHERE id = ?`)
          .bind(crypto.randomUUID(), row.id),
      );
      if (updates.length) await db.batch(updates);
    }

    await db
      .prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${index} ON ${table}(public_id)`,
      )
      .run();
  }
}

export async function getOrCreateUser(actor: Actor): Promise<UserRecord> {
  await ensureDatabase();
  const db = getD1();
  const identity = await db
    .prepare(
      `SELECT user_id FROM user_identities
       WHERE provider = ? AND provider_account_key = ?`,
    )
    .bind(actor.provider, actor.providerAccountKey)
    .first<{ user_id: string }>();

  if (identity) {
    await db
      .prepare(
        `UPDATE users SET display_name = ?, email = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .bind(actor.displayName, actor.email, identity.user_id)
      .run();
    await ensureDefaultStatuses(identity.user_id);
    return loadUser(identity.user_id);
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
  ]);
  await ensureDefaultStatuses(userId);
  return loadUser(userId);
}

async function loadUser(userId: string): Promise<UserRecord> {
  const row = await getD1()
    .prepare(
      `SELECT id, display_name, email, timezone FROM users WHERE id = ?`,
    )
    .bind(userId)
    .first<DbRow>();
  if (!row) throw new NotFoundError("User not found");
  return mapUser(row);
}

async function ensureDefaultStatuses(ownerUserId: string) {
  const db = getD1();
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM workflow_statuses WHERE owner_user_id = ?",
    )
    .bind(ownerUserId)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > 0) return;

  const defaults: Array<[string, StatusCategory, string, number, number]> = [
    ["Backlog", "backlog", "#6b7280", 0, 0],
    ["Todo", "unstarted", "#94a3b8", 1, 1],
    ["In Progress", "started", "#f59e0b", 2, 0],
    ["Done", "completed", "#22c55e", 3, 0],
    ["Canceled", "canceled", "#ef4444", 4, 0],
  ];
  await db.batch(
    defaults.map(([name, category, color, position, isDefault]) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO workflow_statuses
            (id, owner_user_id, name, category, color, position, is_default)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `status:${ownerUserId}:${category}`,
          ownerUserId,
          name,
          category,
          color,
          position,
          isDefault,
        ),
    ),
  );
}

export async function getSnapshot(
  user: UserRecord,
  options: { includeAdminOverview?: boolean } = {},
): Promise<AppSnapshot> {
  await ensureDatabase();
  const db = getD1();
  const configuredAdminEmails = adminEmailsFromEnvironment();
  const isAdmin = isAdminEmail(user.email, configuredAdminEmails);
  const [
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
    admin,
  ] =
    await Promise.all([
      db
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
           ORDER BY rank ASC, created_at DESC`,
        )
        .bind(user.id, user.id, user.id, user.id)
        .all<DbRow>(),
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
        .bind(user.id, user.id)
        .all<DbRow>(),
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
        .bind(user.id, user.id)
        .all<DbRow>(),
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
        .bind(user.id, user.id, user.id, user.id)
        .all<DbRow>(),
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
        )
        .all<DbRow>(),
      db
        .prepare(
          `SELECT DISTINCT u.id, u.display_name, u.email, u.timezone
           FROM users u
           WHERE u.id = ? OR EXISTS (
             SELECT 1 FROM access_grants ag
             WHERE ag.revoked_at IS NULL
               AND (ag.owner_user_id = ? OR ag.grantee_user_id = ?)
               AND (ag.owner_user_id = u.id OR ag.grantee_user_id = u.id)
           ) ORDER BY u.display_name`,
        )
        .bind(user.id, user.id, user.id)
        .all<DbRow>(),
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
                     AND actor_grant.permission IN ('manager', 'full_access')
                 )
               )
             )) OR
             (ag.resource_type = 'task' AND EXISTS (
               SELECT 1 FROM tasks t
               WHERE t.id = ag.resource_id AND t.project_id IS NULL
                 AND t.owner_user_id = ?
             )) OR
             (ag.resource_type = 'saved_view' AND EXISTS (
               SELECT 1 FROM saved_views v
               WHERE v.id = ag.resource_id AND v.scope_project_id IS NULL
                 AND v.owner_user_id = ?
             ))
           )
           ORDER BY ag.created_at DESC`,
        )
        .bind(user.id, user.id, user.id, user.id)
        .all<DbRow>(),
      db
        .prepare(
          `SELECT l.* FROM labels l
           WHERE l.owner_user_id = ?
              OR EXISTS (
                SELECT 1 FROM task_labels tl
                JOIN tasks t ON t.id = tl.task_id
                LEFT JOIN projects p ON p.id = t.project_id
                WHERE tl.label_id = l.id
                  AND ((t.project_id IS NOT NULL AND (
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
                  )))
              )
           ORDER BY l.name`,
        )
        .bind(user.id, user.id, user.id, user.id, user.id)
        .all<DbRow>(),
      db
        .prepare(
          `SELECT tl.* FROM task_labels tl
           JOIN tasks t ON t.id = tl.task_id
           LEFT JOIN projects p ON p.id = t.project_id
           WHERE (t.project_id IS NOT NULL AND (
             p.owner_user_id = ? OR EXISTS (
               SELECT 1 FROM access_grants ag
               WHERE ag.resource_type = 'project' AND ag.resource_id = t.project_id
                 AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
             )
           )) OR (t.project_id IS NULL AND (
             t.owner_user_id = ? OR EXISTS (
                SELECT 1 FROM access_grants ag
                WHERE ag.resource_type = 'task' AND ag.resource_id = t.id
                  AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
              )
           ))`,
        )
        .bind(user.id, user.id, user.id, user.id)
        .all<DbRow>(),
      db
        .prepare(
          `SELECT tr.source_task_id, tr.target_task_id, tr.type
           FROM task_relations tr
           JOIN tasks source_task ON source_task.id = tr.source_task_id
           JOIN tasks target_task ON target_task.id = tr.target_task_id
           LEFT JOIN projects source_project ON source_project.id = source_task.project_id
           LEFT JOIN projects target_project ON target_project.id = target_task.project_id
           WHERE ((source_task.project_id IS NOT NULL AND (
             source_project.owner_user_id = ? OR EXISTS (
               SELECT 1 FROM access_grants ag
               WHERE ag.resource_type = 'project'
                 AND ag.resource_id = source_task.project_id
                 AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
             )
           )) OR (source_task.project_id IS NULL AND (
             source_task.owner_user_id = ? OR EXISTS (
               SELECT 1 FROM access_grants ag
               WHERE ag.resource_type = 'task' AND ag.resource_id = source_task.id
                 AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
             )
           ))) AND ((target_task.project_id IS NOT NULL AND (
             target_project.owner_user_id = ? OR EXISTS (
               SELECT 1 FROM access_grants ag
               WHERE ag.resource_type = 'project'
                 AND ag.resource_id = target_task.project_id
                 AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
             )
           )) OR (target_task.project_id IS NULL AND (
             target_task.owner_user_id = ? OR EXISTS (
               SELECT 1 FROM access_grants ag
               WHERE ag.resource_type = 'task' AND ag.resource_id = target_task.id
                 AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
             )
           )))`,
        )
        .bind(
          user.id,
          user.id,
          user.id,
          user.id,
          user.id,
          user.id,
          user.id,
          user.id,
        )
        .all<DbRow>(),
      isAdmin && options.includeAdminOverview
        ? getAdminOverview(user, configuredAdminEmails)
        : Promise.resolve(null),
    ]);

  return {
    user,
    isAdmin,
    admin,
    users: users.results.map(mapUser),
    statuses: statuses.results.map(mapStatus),
    projects: projects.results.map(mapProject),
    releases: releases.results.map(mapRelease),
    tasks: tasks.results.map(mapTask),
    labels: labels.results.map(mapLabel),
    taskLabels: taskLabels.results.map(mapTaskLabel),
    relations: relations.results.map(mapRelation),
    views: views.results.map(mapView),
    collaborators: collaborators.results.map(mapCollaborator),
  };
}

export async function getTaskExternalSource(
  currentUser: UserRecord,
  taskId: string,
): Promise<ExternalSourceRecord | null> {
  await ensureDatabase();
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

export async function getAdminOverview(
  currentUser: UserRecord,
  configuredAdminEmails = adminEmailsFromEnvironment(),
) {
  assertAdmin(currentUser, configuredAdminEmails);
  await ensureDatabase();
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

  const sequenceRow = await db
    .prepare(
      "SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next FROM tasks WHERE owner_user_id = ?",
    )
    .bind(ownerUserId)
    .first<{ next: number }>();
  const rankRow = await db
    .prepare(
      "SELECT COALESCE(MAX(rank), 0) + 1000 AS next FROM tasks WHERE owner_user_id = ? AND status_id = ?",
    )
    .bind(ownerUserId, status.id)
    .first<{ next: number }>();
  const sequence = sequenceRow?.next ?? 1;
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
      currentUser.id,
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
    if (task.projectId && !targetProject) {
      throw new ValidationError(
        "Moving a project task back to standalone is not supported",
      );
    }
    if (task.projectId && targetProject?.id !== task.projectId) {
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
        project_id = ?, release_id = ?, estimate = ?, due_date = ?, rank = ?,
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
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Task was changed in another session");
  }
  return loadAccessibleTask(currentUser.id, taskId);
}

export async function bulkUpdateTasks(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const ids = Array.isArray(input.ids) ? input.ids.map(String) : [];
  if (ids.length === 0 || ids.length > 100) {
    throw new ValidationError("Select between 1 and 100 tasks");
  }
  const field = input.field;
  if (field !== "statusId" && field !== "priority" && field !== "archived") {
    throw new ValidationError("Unsupported bulk action");
  }
  const tasks = await Promise.all(
    ids.map((id) => loadAccessibleTask(currentUser.id, id)),
  );
  tasks.forEach((task) => requireContentEdit(task.accessRole));
  const now = new Date().toISOString();
  const db = getD1();
  const statements = [];
  for (const task of tasks) {
    if (field === "priority") {
      statements.push(
        db
          .prepare(
            `UPDATE tasks SET priority = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND ${editableTaskWhere}`,
          )
          .bind(
            priority(input.value),
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
      const status = await loadStatus(task.ownerUserId, String(input.value));
      const timestamps = statusTimestamps(status.category, task, now);
      statements.push(
        db
          .prepare(
            `UPDATE tasks SET status_id = ?, started_at = ?, completed_at = ?,
              canceled_at = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND ${editableTaskWhere}`,
          )
          .bind(
            status.id,
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
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new ConflictError("One or more tasks changed in another session");
  }
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
  const result = await getD1()
    .prepare(
      `UPDATE access_grants SET revoked_at = CURRENT_TIMESTAMP
       WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
    )
    .bind(grantId, grant.ownerUserId)
    .run();
  if ((result.meta.changes ?? 0) !== 1) throw new NotFoundError("Grant not found");
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
  if ((result.meta.changes ?? 0) !== 1) throw new NotFoundError("Grant not found");
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
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Project ownership changed in another session");
  }
}

async function loadAccessibleTask(userId: string, taskId: string) {
  const row = await getD1()
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
         WHERE t.id = ?
       ) SELECT * FROM scoped WHERE access_role IS NOT NULL`,
    )
    .bind(userId, userId, userId, userId, taskId)
    .first<DbRow>();
  if (!row) throw new NotFoundError("Task not found");
  return mapTask(row);
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
      `SELECT resource_type, resource_id, owner_user_id, permission
       FROM access_grants WHERE id = ? AND revoked_at IS NULL`,
    )
    .bind(grantId)
    .first<{
      resource_type: string;
      resource_id: string;
      owner_user_id: string;
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
  return (
    env as unknown as { TASK_MANAGER_ADMIN_EMAILS?: string }
  ).TASK_MANAGER_ADMIN_EMAILS ?? "";
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
    description: String(row.description ?? ""),
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
