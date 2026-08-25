import { mergeTaskSummary } from "@/lib/workspace-sync-contract";
import type {
  AppSnapshot,
  TaskDetailRecord,
  TaskRecord,
  WorkspaceSyncResponse,
} from "@/lib/types";

export type TaskDraft = {
  title: string;
  description: string;
  estimate: string;
};

export type TaskDraftDirty = Record<keyof TaskDraft, boolean>;

export function nextTaskActivityInvalidationCursor(
  retained: TaskRecord | undefined,
  incoming: TaskRecord,
): string | undefined {
  if (
    retained &&
    (incoming.version !== retained.version || incoming.updatedAt !== retained.updatedAt)
  ) {
    return `local:${incoming.version}:${incoming.updatedAt}`;
  }
  return incoming.activityInvalidationCursor ?? retained?.activityInvalidationCursor;
}

export function mergeSearchTaskSummaries(
  current: TaskRecord[],
  incoming: TaskRecord[],
): TaskRecord[] {
  const incomingIds = new Set(incoming.map((task) => task.id));
  const currentTasks = new Map(current.map((task) => [task.id, task]));
  return [
    ...current.filter((task) => !incomingIds.has(task.id)),
    ...incoming.map((task) => mergeTaskSummary(currentTasks.get(task.id), task)),
  ];
}

export function taskMutationVersion(task: TaskRecord): number {
  return task.detailVersion ?? task.version;
}

export function taskNeedsDetailRefresh(task: TaskRecord): boolean {
  return task.description === null ||
    Boolean(task.detailStale) ||
    (task.detailVersion !== undefined && task.detailVersion < task.version);
}

export function rebaseTaskDraft(
  current: TaskDraft,
  dirty: TaskDraftDirty,
  latest: TaskRecord,
): TaskDraft {
  return {
    title: dirty.title ? current.title : latest.title,
    description: dirty.description
      ? current.description
      : latest.description ?? "",
    estimate: dirty.estimate
      ? current.estimate
      : latest.estimate?.toString() ?? "",
  };
}

export function taskDraftSyncMode(
  hasVersionConflict: boolean,
  dirty: TaskDraftDirty,
): "none" | "auto" | "manual" {
  if (!hasVersionConflict) return "none";
  return Object.values(dirty).some(Boolean) ? "manual" : "auto";
}

export function taskDraftValueChanged(value: string, baseline: string): boolean {
  return value !== baseline;
}

export function resizeTaskTitle(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return;
  textarea.style.height = "0px";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

export function mergeTaskDetailContext(
  current: AppSnapshot,
  detail: TaskDetailRecord,
): AppSnapshot {
  const currentById = new Map(current.tasks.map((task) => [task.id, task]));
  const focusedTask = mergeLoadedTask(
    currentById.get(detail.task.id),
    detail.task,
  );
  const contextualTasks = [
    focusedTask,
    ...detail.relatedTasks.map((task) =>
      mergeTaskSummary(currentById.get(task.id), task)
    ),
  ];
  const contextualIds = new Set(contextualTasks.map((task) => task.id));
  return {
    ...current,
    tasks: [
      ...current.tasks.filter((task) => !contextualIds.has(task.id)),
      ...contextualTasks,
    ],
    labels: mergeUnique(detail.labels, current.labels, (label) => label.id),
    labelGroups: mergeUnique(
      detail.labelGroups ?? [],
      current.labelGroups ?? [],
      (group) => group.id,
    ),
    taskLabels: [
      ...current.taskLabels.filter(
        (assignment) => assignment.taskId !== detail.task.id,
      ),
      ...detail.taskLabels,
    ],
    relations: [
      ...current.relations.filter(
        (relation) =>
          relation.sourceTaskId !== detail.task.id &&
          relation.targetTaskId !== detail.task.id,
      ),
      ...detail.relations,
    ],
  };
}

export function mergeLoadedTask(
  retained: TaskRecord | undefined,
  incoming: TaskRecord,
): TaskRecord {
  if (retained && retained.version > incoming.version) return retained;
  const activityInvalidationCursor = nextTaskActivityInvalidationCursor(
    retained,
    incoming,
  );
  return {
    ...incoming,
    detailVersion: incoming.version,
    detailStale: false,
    ...(retained?.detailInvalidationCursor !== undefined
      ? { detailInvalidationCursor: retained.detailInvalidationCursor }
      : {}),
    ...(retained?.commentInvalidationCursor !== undefined
      ? { commentInvalidationCursor: retained.commentInvalidationCursor }
      : {}),
    ...(activityInvalidationCursor !== undefined
      ? { activityInvalidationCursor }
      : {}),
  };
}

export function reconcileTaskDetail(
  current: TaskDetailRecord,
  nextTask: TaskRecord,
  collections: Pick<AppSnapshot, "tasks" | "labels" | "taskLabels" | "relations">,
  removedTaskIds: ReadonlySet<string> = new Set(),
): TaskDetailRecord {
  const taskLabels = collections.taskLabels.filter(
    (assignment) => assignment.taskId === nextTask.id,
  );
  const labelIds = new Set(taskLabels.map((assignment) => assignment.labelId));
  const labels = mergeUnique(
    collections.labels.filter((label) => labelIds.has(label.id)),
    current.labels,
    (label) => label.id,
  ).filter((label) => labelIds.has(label.id));
  const relations = collections.relations.filter(
    (relation) =>
      relation.sourceTaskId === nextTask.id ||
      relation.targetTaskId === nextTask.id,
  );
  const relatedPool = mergeSearchTaskSummaries(
    current.relatedTasks.filter((task) => !removedTaskIds.has(task.id)),
    collections.tasks.filter((task) => task.id !== nextTask.id),
  );
  const relatedIds = new Set<string>();
  if (nextTask.parentTaskId) relatedIds.add(nextTask.parentTaskId);
  for (const relation of relations) {
    relatedIds.add(
      relation.sourceTaskId === nextTask.id
        ? relation.targetTaskId
        : relation.sourceTaskId,
    );
  }
  for (const task of relatedPool) {
    if (task.parentTaskId === nextTask.id) relatedIds.add(task.id);
  }

  return {
    ...current,
    task: nextTask,
    labels,
    taskLabels,
    relations,
    relatedTasks: relatedPool.filter(
      (task) => relatedIds.has(task.id) || task.parentTaskId === nextTask.id,
    ),
  };
}

export function reconcileTaskDetailFromSync(
  current: TaskDetailRecord,
  changes: WorkspaceSyncResponse["changes"],
  cursor?: string,
): TaskDetailRecord | null {
  const removedTaskIds = new Set(changes.tasks.remove);
  if (removedTaskIds.has(current.task.id)) return null;

  const nextFocusedTask = changes.tasks.upsert.find(
    (task) => task.id === current.task.id,
  );
  const detailInvalidated = changes.invalidations.taskDetails.includes(
    current.task.id,
  ) && (!cursor || current.task.detailInvalidationCursor !== cursor);
  const focusedTask = nextFocusedTask
    ? mergeTaskSummary(current.task, nextFocusedTask)
    : current.task;
  const nextCurrent = detailInvalidated
    ? {
        ...current,
        task: {
          ...focusedTask,
          detailStale: true,
          ...(cursor ? { detailInvalidationCursor: cursor } : {}),
        },
      }
    : { ...current, task: focusedTask };

  const relationPeerIds = new Set<string>();
  for (const relation of nextCurrent.relations) {
    if (relation.sourceTaskId === nextCurrent.task.id) {
      relationPeerIds.add(relation.targetTaskId);
    } else if (relation.targetTaskId === nextCurrent.task.id) {
      relationPeerIds.add(relation.sourceTaskId);
    }
  }
  const incomingById = new Map(
    changes.tasks.upsert.map((task) => [task.id, task]),
  );
  incomingById.delete(nextCurrent.task.id);
  const reconciled = nextCurrent.relatedTasks.flatMap((task) => {
    if (removedTaskIds.has(task.id)) return [];
    const incoming = incomingById.get(task.id);
    if (!incoming) return [task];
    incomingById.delete(task.id);
    const merged = mergeTaskSummary(task, incoming);
    return merged.parentTaskId === nextCurrent.task.id ||
        nextCurrent.task.parentTaskId === merged.id ||
        relationPeerIds.has(merged.id)
      ? [merged]
      : [];
  });
  for (const task of incomingById.values()) {
    if (
      task.parentTaskId === nextCurrent.task.id ||
      nextCurrent.task.parentTaskId === task.id ||
      relationPeerIds.has(task.id)
    ) {
      reconciled.push(task);
    }
  }
  return { ...nextCurrent, relatedTasks: reconciled };
}

export function reconcileTaskDetailAfterReset(
  current: TaskDetailRecord,
  incoming: AppSnapshot,
): TaskDetailRecord {
  const incomingTask = incoming.tasks.find((task) => task.id === current.task.id);
  return incomingTask
    ? { ...current, task: mergeTaskSummary(current.task, incomingTask) }
    : current;
}

function mergeUnique<T>(incoming: T[], current: T[], key: (item: T) => string): T[] {
  const seen = new Set(incoming.map(key));
  return [...incoming, ...current.filter((item) => !seen.has(key(item)))];
}
