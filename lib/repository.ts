import {
  NotFoundError,
  ValidationError,
} from "./domain";
import type {
  TaskDetailRecord,
  TaskRecord,
  UserRecord,
  ViewDisplay,
  ViewQuery,
} from "./types";
import {
  validateViewDisplay,
  validateViewQuery,
} from "./view-contract";
import {
  queryExplicitlyFiltersArchived,
  taskFilterSql,
} from "./task-filter";
import { getD1 } from "@/db";
import {
  projectAccessRoleSql,
  savedViewAccessRoleSql,
  taskAccessRoleSql,
} from "./access-sql";
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
  loadLabelGroupsForLabels,
  mapLabel,
  mapRelation,
  mapTask,
  nullableString,
  type DbRow,
} from "./repository-mappers";
import {
  loadAccessibleProject,
  loadAccessibleRelease,
  loadAccessibleTask,
  loadAccessibleView,
} from "./repository-access-loaders";
import {
  getWorkspaceSyncProjection,
  MAX_UI_SNAPSHOT_TASKS,
  resolveWorkspaceScope,
  snapshotTaskProjection,
  workspacePredicate,
} from "./repository-workspace";
import { validateTaskFilterReferences } from "./repository-views";

export {
  loadAccessibleProject,
  loadAccessibleRelease,
  loadAccessibleView,
};
export * from "./repository-labels";
export * from "./repository-users";
export * from "./repository-admin";
export * from "./repository-projects";
export * from "./repository-sharing";
export * from "./repository-tasks";
export * from "./repository-workspace";
export * from "./repository-views";

export async function getTask(
  currentUser: UserRecord,
  taskId: string,
): Promise<TaskRecord> {
  return loadAccessibleTask(currentUser.id, taskId, true);
}

export async function getTaskForMutation(
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
  const task = await loadAccessibleTask(currentUser.id, taskId, true);
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
           ${taskAccessRoleSql("t", "p")} AS access_role,
           ${projectAccessRoleSql("p")} AS project_access_role
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
         ${taskAccessRoleSql("t", "p")} AS access_role,
         ${projectAccessRoleSql("p")} AS project_access_role
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN releases r ON r.id = t.release_id AND r.deleted_at IS NULL
       WHERE t.archived_at IS NULL AND t.deleted_at IS NULL
         AND (t.project_id IS NULL OR (p.archived_at IS NULL AND p.deleted_at IS NULL))
     ), visible AS MATERIALIZED (
       SELECT * FROM scoped WHERE access_role IS NOT NULL
     )
     SELECT id, public_id, identifier, title,
       CASE WHEN project_access_role IS NOT NULL THEN project_name END AS project_name,
       CASE WHEN project_access_role IS NOT NULL THEN project_public_id END AS project_public_id,
       CASE WHEN project_access_role IS NOT NULL THEN release_name END AS release_name,
       updated_at
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
         ${taskAccessRoleSql("t", "p")} AS access_role,
         ${projectAccessRoleSql("p")} AS project_access_role
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
         scoped.access_role, scoped.project_access_role
       FROM scoped WHERE access_role IS NOT NULL
     )
     SELECT
       v.id, v.public_id, v.owner_user_id, v.creator_user_id,
       v.identifier, v.sequence_number, v.title, NULL AS description,
       v.status_id, v.priority, v.assignee_user_id, v.project_id, v.release_id,
       v.estimate, v.due_date, v.parent_task_id, v.rank,
       v.started_at, v.completed_at, v.canceled_at, v.archived_at,
       v.comment_count, v.version, v.created_at, v.updated_at,
       v.access_role, v.project_access_role, ${order} AS cursor_sort_value
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
