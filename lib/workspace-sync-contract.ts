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
export const WORKSPACE_SYNC_REQUEST_TIMEOUT_MS = 45_000;

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

  const removedTaskIds = new Set(response.changes.tasks.remove);
  const reconciledTasks = reconcileCollection(
    current.tasks,
    response.changes.tasks,
    (task) => task.id,
    mergeTaskSummary,
  );
  const tasks = applyLazyInvalidations(
    reconciledTasks,
    response.changes.invalidations,
    response.cursor,
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
    taskLabels: current.taskLabels.filter(
      (assignment) => !removedTaskIds.has(assignment.taskId),
    ),
    relations: current.relations.filter(
      (relation) =>
        !removedTaskIds.has(relation.sourceTaskId) &&
        !removedTaskIds.has(relation.targetTaskId),
    ),
    syncCursor: response.cursor,
  };
}

export function mergeTaskSummary(
  retained: TaskRecord | undefined,
  incoming: TaskRecord,
): TaskRecord {
  if (!retained) return incoming;
  if (!incomingWins(retained, incoming)) return retained;
  const clientState: Partial<TaskRecord> = {};
  const detailVersion = incoming.detailVersion ?? retained.detailVersion;
  const detailStale = incoming.detailStale ?? retained.detailStale;
  const detailInvalidationCursor = incoming.detailInvalidationCursor ??
    retained.detailInvalidationCursor;
  const commentInvalidationCursor = incoming.commentInvalidationCursor ??
    retained.commentInvalidationCursor;
  const attachmentInvalidationCursor = incoming.attachmentInvalidationCursor ??
    retained.attachmentInvalidationCursor;
  const externalSourceInvalidationCursor = incoming.externalSourceInvalidationCursor ??
    retained.externalSourceInvalidationCursor;
  if (detailVersion !== undefined) clientState.detailVersion = detailVersion;
  if (detailStale !== undefined) clientState.detailStale = detailStale;
  if (detailInvalidationCursor !== undefined) {
    clientState.detailInvalidationCursor = detailInvalidationCursor;
  }
  if (commentInvalidationCursor !== undefined) {
    clientState.commentInvalidationCursor = commentInvalidationCursor;
  }
  if (attachmentInvalidationCursor !== undefined) {
    clientState.attachmentInvalidationCursor = attachmentInvalidationCursor;
  }
  if (externalSourceInvalidationCursor !== undefined) {
    clientState.externalSourceInvalidationCursor = externalSourceInvalidationCursor;
  }
  if (retained.description !== null && incoming.description === null) {
    return {
      ...incoming,
      ...clientState,
      description: retained.description,
      detailVersion: retained.detailVersion ?? retained.version,
    };
  }
  return { ...incoming, ...clientState };
}

function applyLazyInvalidations(
  tasks: TaskRecord[],
  invalidations: WorkspaceSyncResponse["changes"]["invalidations"],
  cursor: string,
): TaskRecord[] {
  const detailIds = new Set(invalidations.taskDetails);
  const commentIds = new Set(invalidations.taskComments);
  const attachmentIds = new Set(invalidations.taskAttachments);
  const externalSourceIds = new Set(invalidations.taskExternalSources);
  if (!detailIds.size && !commentIds.size && !attachmentIds.size && !externalSourceIds.size) return tasks;
  return tasks.map((task) => {
    const detailInvalidated = detailIds.has(task.id) &&
      task.detailInvalidationCursor !== cursor;
    const commentsInvalidated = commentIds.has(task.id) &&
      task.commentInvalidationCursor !== cursor;
    const attachmentsInvalidated = attachmentIds.has(task.id) &&
      task.attachmentInvalidationCursor !== cursor;
    const externalSourceInvalidated = externalSourceIds.has(task.id) &&
      task.externalSourceInvalidationCursor !== cursor;
    if (!detailInvalidated && !commentsInvalidated && !attachmentsInvalidated && !externalSourceInvalidated) {
      return task;
    }
    return {
      ...task,
      ...(detailInvalidated
        ? { detailStale: true, detailInvalidationCursor: cursor }
        : {}),
      ...(commentsInvalidated ? { commentInvalidationCursor: cursor } : {}),
      ...(attachmentsInvalidated ? { attachmentInvalidationCursor: cursor } : {}),
      ...(externalSourceInvalidated
        ? { externalSourceInvalidationCursor: cursor }
        : {}),
    };
  });
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
