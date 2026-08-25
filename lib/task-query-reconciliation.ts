import { canonicalViewQuery } from "./task-filter";
import type { TaskRecord, ViewDisplay, ViewFilterField, ViewQuery } from "./types";

/**
 * Task properties and related collections that can affect an authoritative
 * task-query result. The names intentionally describe domain dependencies,
 * not React events, so every mutation path can report the same small set.
 */
export type TaskQueryDependency =
  | "identifier"
  | "title"
  | "description"
  | "status"
  | "status_category"
  | "priority"
  | "assignee"
  | "project"
  | "release"
  | "estimate"
  | "due_date"
  | "parent"
  | "subtasks"
  | "created_at"
  | "updated_at"
  | "started_at"
  | "completed_at"
  | "canceled_at"
  | "archived"
  | "label"
  | "label_group"
  | "relation"
  | "rank"
  | "access_role";

export type ActiveTaskQuery = {
  query: ViewQuery;
  surface: string;
  scopeProjectId?: string | null;
  display: Pick<ViewDisplay, "groupBy" | "orderBy">;
};

const FILTER_DEPENDENCIES: Record<ViewFilterField, readonly TaskQueryDependency[]> = {
  status: ["status"],
  status_category: ["status", "status_category"],
  priority: ["priority"],
  assignee: ["assignee"],
  project: ["project"],
  release: ["release"],
  estimate: ["estimate"],
  due_date: ["due_date", "completed_at", "canceled_at"],
  parent: ["parent"],
  subtasks: ["parent", "subtasks"],
  created_at: ["created_at"],
  updated_at: ["updated_at"],
  started_at: ["started_at"],
  completed_at: ["completed_at"],
  canceled_at: ["canceled_at"],
  label: ["label"],
  label_group: ["label", "label_group"],
  relation: ["relation"],
  archived: ["archived"],
};

const GROUP_DEPENDENCIES: Record<ViewDisplay["groupBy"], readonly TaskQueryDependency[]> = {
  status: ["status"],
  priority: ["priority"],
  assignee: ["assignee"],
  project: ["project"],
  release: ["release"],
  label_group: ["label", "label_group"],
  none: [],
};

const ORDER_DEPENDENCIES: Record<ViewDisplay["orderBy"], readonly TaskQueryDependency[]> = {
  manual: ["rank"],
  priority: ["priority"],
  created: ["created_at"],
  updated: ["updated_at"],
  due: ["due_date"],
  title: ["title"],
};

/** Returns every field capable of changing membership, grouping, or ordering. */
export function activeTaskQueryDependencies(input: ActiveTaskQuery): ReadonlySet<TaskQueryDependency> {
  const dependencies = new Set<TaskQueryDependency>();
  const query = canonicalViewQuery(input.query);

  for (const condition of query.conditions) {
    addAll(dependencies, FILTER_DEPENDENCIES[condition.field]);
  }
  if (query.search?.trim()) {
    addAll(dependencies, ["identifier", "title", "description"]);
  }

  addSurfaceDependencies(dependencies, input.surface);
  if (input.scopeProjectId) dependencies.add("project");
  addAll(dependencies, GROUP_DEPENDENCIES[input.display.groupBy]);
  addAll(dependencies, ORDER_DEPENDENCIES[input.display.orderBy]);
  return dependencies;
}

function addSurfaceDependencies(dependencies: Set<TaskQueryDependency>, surface: string) {
  if (surface === "mine") dependencies.add("assignee");
  else if (surface === "shared") dependencies.add("access_role");
  else if (surface === "active" || surface === "backlog") {
    dependencies.add("status");
    dependencies.add("status_category");
  } else if (surface.startsWith("project:")) dependencies.add("project");
  else if (surface.startsWith("release:")) dependencies.add("release");

  // Every task collection applies an implicit active/archived partition unless
  // the query replaces it with an explicit archived condition.
  dependencies.add("archived");
}

function addAll(
  target: Set<TaskQueryDependency>,
  values: Iterable<TaskQueryDependency>,
) {
  for (const value of values) target.add(value);
}

/**
 * Derives task-owned facets from an exact before/after pair. Collection-only
 * changes (labels, relations, or a parent's subtasks) should be added by the
 * mutation caller because they do not necessarily increment Task.version.
 */
export function taskMutationDependencies(
  before: TaskRecord | null | undefined,
  after: TaskRecord,
): ReadonlySet<TaskQueryDependency> {
  const dependencies = new Set<TaskQueryDependency>();
  if (!before) {
    addAll(dependencies, [
      "identifier", "title", "description", "status", "status_category",
      "priority", "assignee", "project", "release", "estimate", "due_date",
      "parent", "created_at", "updated_at", "started_at", "completed_at",
      "canceled_at", "archived", "rank", "access_role",
    ]);
    return dependencies;
  }

  addIfChanged(dependencies, before.identifier, after.identifier, "identifier");
  addIfChanged(dependencies, before.title, after.title, "title");
  addIfChanged(dependencies, before.description, after.description, "description");
  if (before.statusId !== after.statusId) {
    dependencies.add("status");
    dependencies.add("status_category");
  }
  addIfChanged(dependencies, before.priority, after.priority, "priority");
  addIfChanged(dependencies, before.assigneeUserId, after.assigneeUserId, "assignee");
  addIfChanged(dependencies, before.projectId, after.projectId, "project");
  addIfChanged(dependencies, before.releaseId, after.releaseId, "release");
  addIfChanged(dependencies, before.estimate, after.estimate, "estimate");
  addIfChanged(dependencies, before.dueDate, after.dueDate, "due_date");
  addIfChanged(dependencies, before.parentTaskId, after.parentTaskId, "parent");
  addIfChanged(dependencies, before.rank, after.rank, "rank");
  addIfChanged(dependencies, before.startedAt, after.startedAt, "started_at");
  addIfChanged(dependencies, before.completedAt, after.completedAt, "completed_at");
  addIfChanged(dependencies, before.canceledAt, after.canceledAt, "canceled_at");
  addIfChanged(dependencies, before.archivedAt, after.archivedAt, "archived");
  addIfChanged(dependencies, before.updatedAt, after.updatedAt, "updated_at");
  addIfChanged(dependencies, before.accessRole, after.accessRole, "access_role");
  return dependencies;
}

function addIfChanged<T>(
  dependencies: Set<TaskQueryDependency>,
  before: T,
  after: T,
  dependency: TaskQueryDependency,
) {
  if (before !== after) dependencies.add(dependency);
}

export function mutationAffectsTaskQuery(
  activeDependencies: ReadonlySet<TaskQueryDependency>,
  mutationDependencies: Iterable<TaskQueryDependency>,
) {
  for (const dependency of mutationDependencies) {
    if (activeDependencies.has(dependency)) return true;
  }
  return false;
}

export type TaskQueryMembership = {
  taskIds: string[];
  tasks: TaskRecord[];
};

/**
 * Reconciles only the supplied tasks. Removed rows leave their cached summary
 * intact so an open details pane can remain mounted; newly matching rows are
 * appended to the ID window and are sorted by the caller's normal renderer.
 */
export function reconcileTaskQueryMembership<T extends TaskQueryMembership>(
  current: T,
  affectedTasks: readonly TaskRecord[],
  matches: (task: TaskRecord) => boolean,
): T {
  if (!affectedTasks.length) return current;

  const affectedById = new Map(affectedTasks.map((task) => [task.id, task]));
  const membership = new Set(current.taskIds);
  for (const task of affectedById.values()) {
    if (matches(task)) membership.add(task.id);
    else membership.delete(task.id);
  }

  const retainedIds = current.taskIds.filter((id) => membership.has(id));
  for (const task of affectedById.values()) {
    if (membership.has(task.id) && !retainedIds.includes(task.id)) retainedIds.push(task.id);
  }

  const incomingIds = new Set(affectedById.keys());
  const tasks = [
    ...current.tasks.filter((task) => !incomingIds.has(task.id)),
    ...affectedById.values(),
  ];
  return { ...current, taskIds: retainedIds, tasks };
}

export type TaskQueryRequestToken = Readonly<{
  queryKey: string;
  generation: number;
}>;

export function taskQueryRequestToken(
  queryKey: string,
  generation: number,
): TaskQueryRequestToken {
  return Object.freeze({ queryKey, generation });
}

/** Applies equally to first-page and pagination responses. */
export function taskQueryResponseIsCurrent(
  token: TaskQueryRequestToken,
  activeQueryKey: string,
  activeGeneration: number,
) {
  return token.queryKey === activeQueryKey && token.generation === activeGeneration;
}

export function authoritativeTaskQueryRefreshLimit(
  loadedTaskCount: number,
  defaultLimit = 500,
  maximumLimit = 2_000,
) {
  const safeDefault = Math.max(1, Math.floor(defaultLimit));
  const safeMaximum = Math.max(safeDefault, Math.floor(maximumLimit));
  const loaded = Number.isFinite(loadedTaskCount) ? Math.max(0, Math.floor(loadedTaskCount)) : 0;
  return Math.min(safeMaximum, Math.max(safeDefault, loaded));
}

export type TaskQueryRefreshCoordinator = {
  request: (
    activeDependencies: ReadonlySet<TaskQueryDependency>,
    mutationDependencies: Iterable<TaskQueryDependency>,
  ) => boolean;
  cancel: () => void;
  readonly pending: boolean;
};

/**
 * Coalesces all relevant mutations inside the caller-provided debounce window.
 * Injecting scheduling makes timing deterministic in tests and lets React own
 * the actual window.setTimeout lifecycle.
 */
export function createTaskQueryRefreshCoordinator<Handle>(
  schedule: (refresh: () => void) => Handle,
  cancelScheduled: (handle: Handle) => void,
  refresh: () => void,
): TaskQueryRefreshCoordinator {
  let handle: Handle | null = null;
  return {
    request(activeDependencies, mutationDependencies) {
      if (!mutationAffectsTaskQuery(activeDependencies, mutationDependencies)) return false;
      if (handle !== null) return false;
      handle = schedule(() => {
        handle = null;
        refresh();
      });
      return true;
    },
    cancel() {
      if (handle === null) return;
      cancelScheduled(handle);
      handle = null;
    },
    get pending() {
      return handle !== null;
    },
  };
}
