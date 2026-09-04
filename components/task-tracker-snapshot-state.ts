"use client";

import { nextTaskActivityInvalidationCursor } from "@/lib/task-detail-reconciliation";
import type {
  AppSnapshot,
  LabelGroupRecord,
  LabelRecord,
  TaskLabelAssignment,
  TaskRecord,
  UserProfile,
  WorkflowStatusRecord,
  WorkspaceCatalogKind,
  WorkspaceSyncResponse,
} from "@/lib/types";
import { mergeTaskSummary } from "@/lib/workspace-sync-contract";
import type { TaskSearchState } from "@/components/task-tracker-shared-types";

export type LabelMutationResult = {
  labelGroups?: LabelGroupRecord[];
  labels: LabelRecord[];
  taskLabels: TaskLabelAssignment[];
  taskIds: string[];
  canWrite?: boolean;
};
export type MutationResult =
  | AppSnapshot
  | { task: TaskRecord }
  | { taskUpdates: TaskRecord[] }
  | LabelMutationResult;

export function applyMutationResult(
  current: AppSnapshot,
  result: MutationResult,
): AppSnapshot {
  if ("taskIds" in result && "taskLabels" in result) {
    const replaced = new Set(result.taskIds);
    return {
      ...current,
      tasks: current.tasks.map((task) =>
        replaced.has(task.id) ? invalidateTaskActivity(task) : task,
      ),
      labelGroups: mergeUnique(result.labelGroups ?? [], current.labelGroups ?? [], (group) => group.id),
      labels: mergeUnique(result.labels, current.labels, (label) => label.id),
      taskLabels: [
        ...current.taskLabels.filter((item) => !replaced.has(item.taskId)),
        ...result.taskLabels,
      ],
    };
  }
  if ("taskUpdates" in result) {
    const updates = new Map(result.taskUpdates.map((task) => [task.id, task]));
    return {
      ...current,
      tasks: current.tasks.map((task) => {
        const updated = updates.get(task.id);
        return updated ? mergeTaskMutation(task, updated) : task;
      }),
      workspaceMetrics: workspaceMetricsAfterTaskReplacements(
        current,
        result.taskUpdates,
      ),
    };
  }
  if (!("task" in result)) return result;
  return {
    ...current,
    tasks: current.tasks.map((task) =>
      task.id === result.task.id ? mergeTaskMutation(task, result.task) : task,
    ),
    workspaceMetrics: workspaceMetricsAfterTaskReplacements(current, [result.task]),
  };
}

export function workspaceMetricsAfterTaskReplacements(
  current: AppSnapshot,
  replacements: readonly TaskRecord[],
) {
  if (!current.workspaceMetrics) return undefined;
  const statuses = new Map(current.statuses.map((status) => [status.id, status.category]));
  const currentTasks = new Map(current.tasks.map((task) => [task.id, task]));
  const counts = { ...current.workspaceMetrics.taskCounts };
  for (const replacement of replacements) {
    const retained = currentTasks.get(replacement.id);
    if (!retained) continue;
    for (const [key, value] of Object.entries(taskMetricContribution(
      retained,
      current.user.id,
      statuses,
    ))) {
      counts[key as keyof typeof counts] -= value;
    }
    for (const [key, value] of Object.entries(taskMetricContribution(
      replacement,
      current.user.id,
      statuses,
    ))) {
      counts[key as keyof typeof counts] += value;
    }
  }
  return { taskCounts: counts };
}

export function taskMetricContribution(
  task: TaskRecord,
  currentUserId: string,
  statuses: ReadonlyMap<string, WorkflowStatusRecord["category"]>,
) {
  const category = statuses.get(task.statusId);
  const active = !task.archivedAt;
  return {
    all: active ? 1 : 0,
    active: active && (category === "unstarted" || category === "started") ? 1 : 0,
    backlog: active && category === "backlog" ? 1 : 0,
    mine: active && task.assigneeUserId === currentUserId ? 1 : 0,
    archived: task.archivedAt ? 1 : 0,
  };
}

export function invalidateTaskActivity(
  task: TaskRecord,
  nonce = crypto.randomUUID(),
): TaskRecord {
  return {
    ...task,
    activityInvalidationCursor: `local:${task.version}:${task.updatedAt}:${nonce}`,
  };
}

export function mergeTaskMutation(
  retained: TaskRecord | undefined,
  incoming: TaskRecord,
): TaskRecord {
  if (!retained) return incoming;
  if (
    retained.version > incoming.version ||
    (retained.version === incoming.version && retained.updatedAt > incoming.updatedAt)
  ) return retained;
  const clientState: Partial<TaskRecord> = {};
  const hasLoadedDetailState = retained.detailVersion !== undefined ||
    retained.detailStale !== undefined ||
    retained.detailInvalidationCursor !== undefined;
  if (hasLoadedDetailState) {
    clientState.detailVersion = incoming.description === null
      ? retained.detailVersion
      : incoming.version;
    clientState.detailStale = incoming.description === null
      ? retained.detailStale
      : false;
  }
  if (retained.detailInvalidationCursor !== undefined) {
    clientState.detailInvalidationCursor = retained.detailInvalidationCursor;
  }
  if (retained.commentInvalidationCursor !== undefined) {
    clientState.commentInvalidationCursor = retained.commentInvalidationCursor;
  }
  const activityInvalidationCursor = nextTaskActivityInvalidationCursor(
    retained,
    incoming,
  );
  if (activityInvalidationCursor !== undefined) {
    clientState.activityInvalidationCursor = activityInvalidationCursor;
  }
  if (retained.attachmentInvalidationCursor !== undefined) {
    clientState.attachmentInvalidationCursor = retained.attachmentInvalidationCursor;
  }
  return Object.keys(clientState).length
    ? { ...incoming, ...clientState }
    : incoming;
}

export function mergeDeferredSnapshot(
  current: AppSnapshot,
  incoming: AppSnapshot,
  options: {
    taskIdsAtRequest?: ReadonlySet<string>;
    projectIdsAtRequest?: ReadonlySet<string>;
    releaseIdsAtRequest?: ReadonlySet<string>;
    viewIdsAtRequest?: ReadonlySet<string>;
  } = {},
): AppSnapshot {
  const currentTasks = new Map(current.tasks.map((task) => [task.id, task]));
  const incomingIds = new Set(incoming.tasks.map((task) => task.id));
  const retainedTasks = current.tasks.filter((task) => {
    if (incomingIds.has(task.id)) return false;
    if (!options.taskIdsAtRequest) return true;
    return !options.taskIdsAtRequest.has(task.id);
  });
  const tasks = incoming.tasks.map((task) =>
    mergeTaskSummary(currentTasks.get(task.id), task),
  );
  const mergedTasks = [...retainedTasks, ...tasks];
  const mergedTaskIds = new Set(mergedTasks.map((task) => task.id));
  const mergedTaskLabels = mergeUnique(
    incoming.taskLabels,
    current.taskLabels,
    (assignment) => `${assignment.taskId}:${assignment.labelId}`,
  ).filter(
    (assignment) => !options.taskIdsAtRequest || mergedTaskIds.has(assignment.taskId),
  );
  const mergedRelations = mergeUnique(
    incoming.relations,
    current.relations,
    (relation) => `${relation.sourceTaskId}:${relation.type}:${relation.targetTaskId}`,
  ).filter(
    (relation) => !options.taskIdsAtRequest ||
      (mergedTaskIds.has(relation.sourceTaskId) && mergedTaskIds.has(relation.targetTaskId)),
  );
  const retainedLabelIds = new Set(mergedTaskLabels.map((assignment) => assignment.labelId));
  const incomingLabelIds = new Set(incoming.labels.map((label) => label.id));
  const projectCoverage = incoming.catalogCoverage?.projects ?? "complete";
  const releaseCoverage = incoming.catalogCoverage?.releases ?? "complete";
  const viewCoverage = incoming.catalogCoverage?.views ?? "complete";
  const mergedUserState = mergeDeferredUserState(current, incoming);

  return {
    ...incoming,
    ...mergedUserState,
    admin: incoming.isAdmin ? incoming.admin ?? current.admin : null,
    tasks: mergedTasks,
    projects: mergeResetCollection(
      current.projects,
      incoming.projects,
      projectCoverage === "complete" ? options.projectIdsAtRequest : undefined,
    ),
    releases: mergeResetCollection(
      current.releases,
      incoming.releases,
      releaseCoverage === "complete" ? options.releaseIdsAtRequest : undefined,
    ),
    views: mergeResetCollection(
      current.views,
      incoming.views,
      viewCoverage === "complete" ? options.viewIdsAtRequest : undefined,
    ),
    labelGroups: mergeUnique(incoming.labelGroups ?? [], current.labelGroups ?? [], (group) => group.id),
    labels: mergeUnique(incoming.labels, current.labels, (label) => label.id)
      .filter((label) => !options.taskIdsAtRequest ||
        incomingLabelIds.has(label.id) || retainedLabelIds.has(label.id)),
    taskLabels: mergedTaskLabels,
    relations: mergedRelations,
    navigationCollections: incoming.navigationCollections ?? current.navigationCollections,
    catalogCoverage: {
      projects: mergeCatalogCoverage(current.catalogCoverage?.projects, projectCoverage),
      releases: mergeCatalogCoverage(current.catalogCoverage?.releases, releaseCoverage),
      views: mergeCatalogCoverage(current.catalogCoverage?.views, viewCoverage),
    },
  };
}

export function mergeCatalogCoverage(
  current: "bounded" | "complete" | undefined,
  incoming: "bounded" | "complete",
) {
  return current === "complete" || incoming === "complete" ? "complete" : "bounded";
}

export function snapshotProvesCollectionAbsence(
  snapshot: AppSnapshot,
  kind: WorkspaceCatalogKind,
) {
  return (snapshot.catalogCoverage?.[kind] ?? "complete") === "complete";
}

export function mergeDeferredUserState(
  current: AppSnapshot,
  incoming: AppSnapshot,
): Pick<AppSnapshot, "user" | "userProfile"> {
  if (current.user.id !== incoming.user.id) {
    return { user: incoming.user, userProfile: incoming.userProfile };
  }

  const currentVersion = Number(
    current.userProfile?.user.version ?? current.user.version ?? 0,
  );
  const incomingVersion = Number(
    incoming.userProfile?.user.version ?? incoming.user.version ?? 0,
  );
  const currentVersionedUser = current.userProfile?.user ?? current.user;

  if (currentVersion > incomingVersion) {
    return {
      user: currentVersionedUser,
      userProfile: current.userProfile ?? (incoming.userProfile
        ? { ...incoming.userProfile, user: currentVersionedUser as UserProfile["user"] }
        : undefined),
    };
  }
  if (incomingVersion > currentVersion) {
    return { user: incoming.user, userProfile: incoming.userProfile };
  }

  const verifiedEmail = incoming.userProfile?.user.email ?? incoming.user.email;
  const user = { ...currentVersionedUser, email: verifiedEmail };
  const identities = incoming.userProfile?.identities ?? current.userProfile?.identities;
  return {
    user,
    userProfile: identities
      ? { user: user as UserProfile["user"], identities }
      : undefined,
  };
}

export function mergeResetCollection<T extends { id: string; version: number }>(
  current: T[],
  incoming: T[],
  idsAtRequest?: ReadonlySet<string>,
): T[] {
  const currentById = new Map(current.map((item) => [item.id, item]));
  const incomingIds = new Set(incoming.map((item) => item.id));
  const retained = current.filter((item) => {
    if (incomingIds.has(item.id)) return false;
    if (!idsAtRequest) return true;
    return !idsAtRequest.has(item.id);
  });
  return [
    ...retained,
    ...incoming.map((item) => {
      const existing = currentById.get(item.id);
      return existing && existing.version > item.version ? existing : item;
    }),
  ];
}

export function reconcileTaskSearch(
  current: TaskSearchState | null,
  changes: Pick<WorkspaceSyncResponse["changes"], "tasks">,
): TaskSearchState | null {
  if (!current) return current;
  const removedTaskIds = new Set(changes.tasks.remove);
  const incomingById = new Map(
    changes.tasks.upsert.map((task) => [task.id, task]),
  );
  return {
    ...current,
    taskIds: current.taskIds.filter((taskId) => !removedTaskIds.has(taskId)),
    tasks: current.tasks
      .filter((task) => !removedTaskIds.has(task.id))
      .map((task) => {
        const incoming = incomingById.get(task.id);
        return incoming ? mergeTaskSummary(task, incoming) : task;
      }),
  };
}

export function mergeUnique<T>(
  incoming: T[],
  current: T[],
  key: (item: T) => string,
): T[] {
  const seen = new Set(incoming.map(key));
  return [...incoming, ...current.filter((item) => !seen.has(key(item)))];
}
