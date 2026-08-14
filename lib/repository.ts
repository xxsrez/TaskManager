import type { Actor } from "./auth";
import {
  assertReleaseProject,
  ConflictError,
  NotFoundError,
  optionalDate,
  optionalText,
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
  ViewDisplay,
  ViewQuery,
  WorkflowStatusRecord,
} from "./types";
import { getD1 } from "@/db";

type DbRow = Record<string, unknown>;

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
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    scope_project_id TEXT,
    query_json TEXT NOT NULL DEFAULT '{}',
    display_json TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
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
    permission TEXT NOT NULL DEFAULT 'full_access',
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(resource_type, resource_id, grantee_user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_access_grants_grantee_active
    ON access_grants(grantee_user_id, resource_type, resource_id)
    WHERE revoked_at IS NULL`,
];

let schemaPromise: Promise<void> | null = null;

export async function ensureDatabase() {
  schemaPromise ??= (async () => {
    const db = getD1();
    await db.batch(schemaStatements.map((statement) => db.prepare(statement)));
    await db.prepare("PRAGMA optimize").run();
  })();
  return schemaPromise;
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

export async function getSnapshot(user: UserRecord): Promise<AppSnapshot> {
  await ensureDatabase();
  const db = getD1();
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
    externalSources,
  ] =
    await Promise.all([
      db
        .prepare(
          `SELECT t.* FROM tasks t
           WHERE t.owner_user_id = ?
              OR EXISTS (
                SELECT 1 FROM access_grants ag
                WHERE ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                  AND ((ag.resource_type = 'task' AND ag.resource_id = t.id)
                    OR (ag.resource_type = 'project' AND ag.resource_id = t.project_id))
              )
           ORDER BY t.rank ASC, t.created_at DESC`,
        )
        .bind(user.id, user.id)
        .all<DbRow>(),
      db
        .prepare(
          `SELECT p.* FROM projects p
           WHERE p.archived_at IS NULL AND (
             p.owner_user_id = ? OR EXISTS (
               SELECT 1 FROM access_grants ag
               WHERE ag.resource_type = 'project' AND ag.resource_id = p.id
                 AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
             )
           ) ORDER BY p.updated_at DESC`,
        )
        .bind(user.id, user.id)
        .all<DbRow>(),
      db
        .prepare(
          `SELECT r.* FROM releases r
           WHERE r.owner_user_id = ? OR EXISTS (
             SELECT 1 FROM access_grants ag
             WHERE ag.resource_type = 'project' AND ag.resource_id = r.project_id
               AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
           ) ORDER BY r.created_at DESC`,
        )
        .bind(user.id, user.id)
        .all<DbRow>(),
      db
        .prepare(
          `SELECT v.* FROM saved_views v
           WHERE v.owner_user_id = ? OR EXISTS (
             SELECT 1 FROM access_grants ag
             WHERE ag.resource_type = 'saved_view' AND ag.resource_id = v.id
               AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
           ) ORDER BY v.updated_at DESC`,
        )
        .bind(user.id, user.id)
        .all<DbRow>(),
      db
        .prepare(
          `SELECT s.* FROM workflow_statuses s
           WHERE s.owner_user_id = ?
              OR EXISTS (
                SELECT 1 FROM projects p
                WHERE p.owner_user_id = s.owner_user_id AND EXISTS (
                  SELECT 1 FROM access_grants ag
                  WHERE ag.resource_type = 'project' AND ag.resource_id = p.id
                    AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                )
              )
           ORDER BY s.owner_user_id, s.position`,
        )
        .bind(user.id, user.id)
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
          `SELECT ag.id, ag.resource_type, ag.resource_id,
                  u.id AS user_id, u.display_name, u.email
           FROM access_grants ag
           JOIN users u ON u.id = ag.grantee_user_id
           WHERE ag.owner_user_id = ? AND ag.revoked_at IS NULL
           ORDER BY ag.created_at DESC`,
        )
        .bind(user.id)
        .all<DbRow>(),
      db
        .prepare(
          `SELECT l.* FROM labels l
           WHERE l.owner_user_id = ?
              OR EXISTS (
                SELECT 1 FROM task_labels tl
                JOIN tasks t ON t.id = tl.task_id
                JOIN access_grants ag ON (
                  (ag.resource_type = 'task' AND ag.resource_id = t.id)
                  OR (ag.resource_type = 'project' AND ag.resource_id = t.project_id)
                )
                WHERE tl.label_id = l.id
                  AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
              )
           ORDER BY l.name`,
        )
        .bind(user.id, user.id)
        .all<DbRow>(),
      db
        .prepare(
          `SELECT tl.* FROM task_labels tl
           JOIN tasks t ON t.id = tl.task_id
           WHERE t.owner_user_id = ?
              OR EXISTS (
                SELECT 1 FROM access_grants ag
                WHERE ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                  AND ((ag.resource_type = 'task' AND ag.resource_id = t.id)
                    OR (ag.resource_type = 'project' AND ag.resource_id = t.project_id))
              )`,
        )
        .bind(user.id, user.id)
        .all<DbRow>(),
      db
        .prepare(
          `SELECT tr.source_task_id, tr.target_task_id, tr.type
           FROM task_relations tr
           JOIN tasks source_task ON source_task.id = tr.source_task_id
           JOIN tasks target_task ON target_task.id = tr.target_task_id
           WHERE (
             source_task.owner_user_id = ? OR EXISTS (
               SELECT 1 FROM access_grants ag
               WHERE ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                 AND ((ag.resource_type = 'task' AND ag.resource_id = source_task.id)
                   OR (ag.resource_type = 'project' AND ag.resource_id = source_task.project_id))
             )
           ) AND (
             target_task.owner_user_id = ? OR EXISTS (
               SELECT 1 FROM access_grants ag
               WHERE ag.grantee_user_id = ? AND ag.revoked_at IS NULL
                 AND ((ag.resource_type = 'task' AND ag.resource_id = target_task.id)
                   OR (ag.resource_type = 'project' AND ag.resource_id = target_task.project_id))
             )
           )`,
        )
        .bind(user.id, user.id, user.id, user.id)
        .all<DbRow>(),
      db
        .prepare(
          `SELECT target_type, target_id, source, source_id, source_url,
                  metadata_json
           FROM external_records
           WHERE owner_user_id = ?`,
        )
        .bind(user.id)
        .all<DbRow>(),
    ]);

  return {
    user,
    users: users.results.map(mapUser),
    statuses: statuses.results.map(mapStatus),
    projects: projects.results.map(mapProject),
    releases: releases.results.map(mapRelease),
    tasks: tasks.results.map(mapTask),
    labels: labels.results.map(mapLabel),
    taskLabels: taskLabels.results.map(mapTaskLabel),
    relations: relations.results.map(mapRelation),
    externalSources: externalSources.results.map(mapExternalSource),
    views: views.results.map(mapView),
    collaborators: collaborators.results.map(mapCollaborator),
  };
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
  const ownerUserId = project?.ownerUserId ?? currentUser.id;
  const status = await loadStatus(
    ownerUserId,
    input.statusId ? String(input.statusId) : null,
  );
  const release = input.releaseId
    ? await loadAccessibleRelease(currentUser.id, String(input.releaseId))
    : null;
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

  await db
    .prepare(
      `INSERT INTO tasks (
        id, owner_user_id, creator_user_id, identifier, sequence_number,
        title, description, status_id, priority, assignee_user_id,
        project_id, release_id, estimate, due_date, rank,
        started_at, completed_at, canceled_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `task_${crypto.randomUUID()}`,
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
}

export async function updateTask(
  currentUser: UserRecord,
  taskId: string,
  input: Record<string, unknown>,
) {
  const task = await loadAccessibleTask(currentUser.id, taskId);
  const expectedVersion = Number(input.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== task.version) {
    throw new ConflictError("Task was changed in another session");
  }

  let projectId = task.projectId;
  if (Object.hasOwn(input, "projectId")) {
    const targetProject = input.projectId
      ? await loadAccessibleProject(currentUser.id, String(input.projectId))
      : null;
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
         owner_user_id = ? OR EXISTS (
           SELECT 1 FROM access_grants ag
           WHERE ag.grantee_user_id = ? AND ag.revoked_at IS NULL
             AND ((ag.resource_type = 'task' AND ag.resource_id = tasks.id)
               OR (ag.resource_type = 'project' AND ag.resource_id = tasks.project_id))
         )
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
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ConflictError("Task was changed in another session");
  }
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
  const now = new Date().toISOString();
  const db = getD1();
  const statements = [];
  for (const task of tasks) {
    if (field === "priority") {
      statements.push(
        db
          .prepare(
            `UPDATE tasks SET priority = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .bind(priority(input.value), now, task.id, task.version),
      );
    } else if (field === "archived") {
      statements.push(
        db
          .prepare(
            `UPDATE tasks SET archived_at = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .bind(input.value ? now : null, now, task.id, task.version),
      );
    } else {
      const status = await loadStatus(task.ownerUserId, String(input.value));
      const timestamps = statusTimestamps(status.category, task, now);
      statements.push(
        db
          .prepare(
            `UPDATE tasks SET status_id = ?, started_at = ?, completed_at = ?,
              canceled_at = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .bind(
            status.id,
            timestamps.startedAt,
            timestamps.completedAt,
            timestamps.canceledAt,
            now,
            task.id,
            task.version,
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
        (id, owner_user_id, creator_user_id, name, summary, description,
         target_date, lead_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `project_${crypto.randomUUID()}`,
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
  const now = new Date().toISOString();
  await getD1()
    .prepare(
      `INSERT INTO releases
        (id, project_id, owner_user_id, creator_user_id, name, description,
         status, target_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `release_${crypto.randomUUID()}`,
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
  await getD1()
    .prepare(
      `INSERT INTO saved_views
        (id, owner_user_id, name, scope_project_id, query_json, display_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `view_${crypto.randomUUID()}`,
      currentUser.id,
      requireTitle(input.name),
      input.scopeProjectId ? String(input.scopeProjectId) : null,
      JSON.stringify(query),
      JSON.stringify(display),
    )
    .run();
}

export async function grantAccess(
  currentUser: UserRecord,
  input: Record<string, unknown>,
) {
  const resourceType = String(input.resourceType ?? "");
  if (!["project", "task", "saved_view"].includes(resourceType)) {
    throw new ValidationError("Unsupported share target");
  }
  const resourceId = String(input.resourceId ?? "");
  const ownerUserId = await requireSharePermission(
    currentUser.id,
    resourceType,
    resourceId,
  );
  if (resourceType === "task") {
    const task = await loadAccessibleTask(currentUser.id, resourceId);
    if (task.projectId) {
      throw new ValidationError("Share the project instead of a project task");
    }
  }
  const email = String(input.email ?? "").trim().toLowerCase();
  const grantee = await getD1()
    .prepare("SELECT id FROM users WHERE lower(email) = ? LIMIT 1")
    .bind(email)
    .first<{ id: string }>();
  if (!grantee) {
    throw new NotFoundError("That user must sign in once before you can share");
  }
  if (grantee.id === ownerUserId) {
    throw new ValidationError("The owner already has access");
  }
  await getD1()
    .prepare(
      `INSERT INTO access_grants
        (id, resource_type, resource_id, owner_user_id, grantee_user_id,
         granted_by_user_id, permission, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, 'full_access', NULL)
       ON CONFLICT(resource_type, resource_id, grantee_user_id)
       DO UPDATE SET revoked_at = NULL, granted_by_user_id = excluded.granted_by_user_id`,
    )
    .bind(
      `grant_${crypto.randomUUID()}`,
      resourceType,
      resourceId,
      ownerUserId,
      grantee.id,
      currentUser.id,
    )
    .run();
}

export async function revokeAccess(currentUser: UserRecord, grantId: string) {
  const result = await getD1()
    .prepare(
      `UPDATE access_grants SET revoked_at = CURRENT_TIMESTAMP
       WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
    )
    .bind(grantId, currentUser.id)
    .run();
  if ((result.meta.changes ?? 0) !== 1) throw new NotFoundError("Grant not found");
}

async function loadAccessibleTask(userId: string, taskId: string) {
  const row = await getD1()
    .prepare(
      `SELECT t.* FROM tasks t WHERE t.id = ? AND (
        t.owner_user_id = ? OR EXISTS (
          SELECT 1 FROM access_grants ag
          WHERE ag.grantee_user_id = ? AND ag.revoked_at IS NULL
            AND ((ag.resource_type = 'task' AND ag.resource_id = t.id)
              OR (ag.resource_type = 'project' AND ag.resource_id = t.project_id))
        )
      )`,
    )
    .bind(taskId, userId, userId)
    .first<DbRow>();
  if (!row) throw new NotFoundError("Task not found");
  return mapTask(row);
}

async function loadAccessibleProject(userId: string, projectId: string) {
  const row = await getD1()
    .prepare(
      `SELECT p.* FROM projects p WHERE p.id = ? AND (
        p.owner_user_id = ? OR EXISTS (
          SELECT 1 FROM access_grants ag
          WHERE ag.resource_type = 'project' AND ag.resource_id = p.id
            AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
        )
      )`,
    )
    .bind(projectId, userId, userId)
    .first<DbRow>();
  if (!row) throw new NotFoundError("Project not found");
  return mapProject(row);
}

async function loadAccessibleRelease(userId: string, releaseId: string) {
  const row = await getD1()
    .prepare(
      `SELECT r.* FROM releases r WHERE r.id = ? AND (
        r.owner_user_id = ? OR EXISTS (
          SELECT 1 FROM access_grants ag
          WHERE ag.resource_type = 'project' AND ag.resource_id = r.project_id
            AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
        )
      )`,
    )
    .bind(releaseId, userId, userId)
    .first<DbRow>();
  if (!row) throw new NotFoundError("Release not found");
  return mapRelease(row);
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

async function requireSharePermission(
  currentUserId: string,
  resourceType: string,
  resourceId: string,
) {
  const table =
    resourceType === "project"
      ? "projects"
      : resourceType === "task"
        ? "tasks"
        : "saved_views";
  const row = await getD1()
    .prepare(
      `SELECT owner_user_id FROM ${table} resource
       WHERE id = ? AND (
         owner_user_id = ? OR EXISTS (
           SELECT 1 FROM access_grants ag
           WHERE ag.resource_type = ? AND ag.resource_id = resource.id
             AND ag.grantee_user_id = ? AND ag.revoked_at IS NULL
             AND ag.permission = 'full_access'
         )
       )`,
    )
    .bind(resourceId, currentUserId, resourceType, currentUserId)
    .first<{ owner_user_id: string }>();
  if (!row) throw new NotFoundError("Resource not found");
  return row.owner_user_id;
}

function optionalEstimate(value: unknown): number | null {
  if (value == null || value === "") return null;
  const estimate = Number(value);
  if (!Number.isInteger(estimate) || estimate < 0 || estimate > 100) {
    throw new ValidationError("Estimate must be an integer from 0 to 100");
  }
  return estimate;
}

function finiteNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ValidationError(`${label} is invalid`);
  return number;
}

function validateViewQuery(value: unknown): ViewQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as ViewQuery;
}

function validateViewDisplay(value: unknown): ViewDisplay {
  const fallback: ViewDisplay = {
    layout: "list",
    groupBy: "status",
    orderBy: "manual",
    direction: "asc",
    showEmptyGroups: true,
    visibleFields: ["priority", "project", "release", "dueDate", "assignee"],
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  return { ...fallback, ...(value as Partial<ViewDisplay>) };
}

function mapUser(row: DbRow): UserRecord {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    email: String(row.email),
    timezone: String(row.timezone),
  };
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
  };
}

function mapRelease(row: DbRow): ReleaseRecord {
  return {
    id: String(row.id),
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
  };
}

function mapTask(row: DbRow): TaskRecord {
  return {
    id: String(row.id),
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
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    scopeProjectId: nullableString(row.scope_project_id),
    query: safeJson<ViewQuery>(row.query_json, {}),
    display: safeJson<ViewDisplay>(row.display_json, validateViewDisplay(null)),
    version: Number(row.version),
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
  };
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
