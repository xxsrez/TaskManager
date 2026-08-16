import type {
  AppSnapshot,
  ProjectRecord,
  ReleaseRecord,
  SavedViewRecord,
  TaskRecord,
  WorkspaceSyncCollection,
  WorkspaceSyncResponse,
} from "./types";

export const WORKSPACE_SYNC_INTERVAL_MS = 60_000;
export const WORKSPACE_SYNC_MAX_RETRY_MS = 300_000;

export function workspaceSyncRetryDelay(failureCount: number): number {
  const boundedFailures = Math.max(0, Math.min(20, Math.floor(failureCount)));
  return Math.min(
    WORKSPACE_SYNC_MAX_RETRY_MS,
    WORKSPACE_SYNC_INTERVAL_MS * 2 ** boundedFailures,
  );
}

export function applyWorkspaceSync(
  current: AppSnapshot,
  response: WorkspaceSyncResponse,
): AppSnapshot {
  if (response.resetRequired) return current;

  const touchedTaskIds = new Set([
    ...response.changes.tasks.upsert.map((task) => task.id),
    ...response.changes.tasks.remove,
  ]);
  const tasks = reconcileCollection(
    current.tasks,
    response.changes.tasks,
    (task) => task.id,
    mergeTaskSummary,
  );
  const projects = reconcileCollection(
    current.projects,
    response.changes.projects,
    (project) => project.id,
    mergeVersionedRecord,
  );
  const releases = reconcileCollection(
    current.releases,
    response.changes.releases,
    (release) => release.id,
    mergeVersionedRecord,
  );
  const views = reconcileCollection(
    current.views,
    response.changes.views,
    (view) => view.id,
    mergeVersionedRecord,
  );

  return {
    ...current,
    tasks,
    projects,
    releases,
    views,
    labels: mergeById(current.labels, response.changes.labels),
    taskLabels: [
      ...current.taskLabels.filter(
        (assignment) => !touchedTaskIds.has(assignment.taskId),
      ),
      ...response.changes.taskLabels,
    ],
    relations: [
      ...current.relations.filter(
        (relation) =>
          !touchedTaskIds.has(relation.sourceTaskId) &&
          !touchedTaskIds.has(relation.targetTaskId),
      ),
      ...response.changes.relations,
    ],
    syncCursor: response.cursor,
  };
}

export function mergeTaskSummary(
  retained: TaskRecord | undefined,
  incoming: TaskRecord,
): TaskRecord {
  if (!retained) return incoming;
  if (!incomingWins(retained, incoming)) return retained;
  if (retained.description !== null && incoming.description === null) {
    return {
      ...incoming,
      description: retained.description,
      detailVersion: retained.detailVersion ?? retained.version,
    };
  }
  return incoming;
}

function reconcileCollection<T>(
  current: T[],
  patch: WorkspaceSyncCollection<T>,
  key: (item: T) => string,
  merge: (retained: T | undefined, incoming: T) => T,
): T[] {
  const removed = new Set(patch.remove);
  const incomingById = new Map(patch.upsert.map((item) => [key(item), item]));
  const reconciled = current
    .filter((item) => !removed.has(key(item)))
    .map((item) => {
      const incoming = incomingById.get(key(item));
      if (!incoming) return item;
      incomingById.delete(key(item));
      return merge(item, incoming);
    });
  return [...reconciled, ...[...incomingById.values()].map((item) => merge(undefined, item))];
}

function mergeVersionedRecord<
  T extends ProjectRecord | ReleaseRecord | SavedViewRecord,
>(retained: T | undefined, incoming: T): T {
  if (!retained) return incoming;
  return incomingWins(retained, incoming) ? incoming : retained;
}

function incomingWins(
  retained: { version: number; updatedAt?: string },
  incoming: { version: number; updatedAt?: string },
) {
  if (incoming.version !== retained.version) {
    return incoming.version > retained.version;
  }
  if (incoming.updatedAt && retained.updatedAt) {
    return incoming.updatedAt >= retained.updatedAt;
  }
  return true;
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  return [
    ...current.map((item) => incomingById.get(item.id) ?? item),
    ...incoming.filter((item) => !current.some((currentItem) => currentItem.id === item.id)),
  ];
}
