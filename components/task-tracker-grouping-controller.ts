"use client";

import { useMemo, useState } from "react";
import { canEditContent } from "@/lib/access";
import {
  buildTaskGroups,
  canMoveTaskToGroup,
  projectTaskGroupMove,
  rankBetweenNeighbors,
  rollbackTaskGroupMove,
  shouldShowEmptyTaskGroups,
  taskGroupCreateDefaults,
  taskGroupValue,
  tasksInGroupOrder,
  type TaskGroup,
} from "@/lib/task-groups";
import { taskMutationVersion } from "@/lib/task-detail-reconciliation";
import type {
  AppSnapshot,
  ProjectRecord,
  TaskRecord,
  UserRecord,
  ViewDisplay,
} from "@/lib/types";
import type { Layout } from "@/lib/navigation";
import {
  projectGroupMovePreview,
  type PendingProjectGroupMove,
} from "@/components/task-tracker-state";
import {
  confirmReleasedCompositionChange,
  releasedCompositionNeedsConfirmation,
  taskAssigneeOptions,
} from "@/components/task-tracker-view";

type Mutate = (path: string, method: string, body: unknown) => Promise<boolean>;
type UpdateClientTask = (
  taskId: string,
  update: (task: TaskRecord) => TaskRecord,
) => void;

type GroupingControllerOptions = {
  data: AppSnapshot;
  visibleTasks: TaskRecord[];
  taskPool: TaskRecord[];
  userMap: Map<string, UserRecord>;
  contextProject: string | null;
  contextProjectRecord: ProjectRecord | undefined;
  display: ViewDisplay;
  layout: Layout;
  collapsedGroups: Set<string>;
  draggingTaskId: string | null;
  mutate: Mutate;
  updateClientTask: UpdateClientTask;
  onError: (message: string) => void;
};

type MovePosition = {
  group: TaskGroup | null;
  previousTaskId: string | null;
  nextTaskId: string | null;
};

function releasedMoveNeedsConfirmation(
  task: TaskRecord,
  nextReleaseId: string | null,
  data: AppSnapshot,
) {
  return releasedCompositionNeedsConfirmation(
    task.releaseId,
    nextReleaseId,
    data.releases,
  );
}

function createAssigneeIds(data: AppSnapshot, project: ProjectRecord | undefined) {
  const ids = new Set<string>([data.user.id]);
  if (!project) return ids;
  ids.add(project.ownerUserId);
  for (const collaborator of data.collaborators) {
    if (
      collaborator.resourceType === "project" &&
      collaborator.resourceId === project.id
    ) {
      ids.add(collaborator.userId);
    }
  }
  return ids;
}

function groupingModel({
  data,
  visibleTasks,
  userMap,
  contextProject,
  contextProjectRecord,
  display,
  layout,
  collapsedGroups,
  draggingTaskId,
}: Omit<GroupingControllerOptions, "taskPool" | "mutate" | "updateClientTask" | "onError">) {
  const ownerIds = new Set(visibleTasks.map((task) => task.ownerUserId));
  if (!ownerIds.size) ownerIds.add(contextProjectRecord?.ownerUserId ?? data.user.id);
  const statuses = data.statuses
    .filter((status) => ownerIds.has(status.ownerUserId))
    .filter((status) => !status.archivedAt || visibleTasks.some((task) => task.statusId === status.id))
    .sort((left, right) => left.position - right.position);
  const projects = contextProject
    ? data.projects.filter((project) => project.id === contextProject)
    : data.projects;
  const releases = contextProject
    ? data.releases.filter((release) => release.projectId === contextProject)
    : data.releases;
  const users = contextProject
    ? taskAssigneeOptions(data, contextProject)
    : [...userMap.values()];
  const taskGroups = buildTaskGroups({
    tasks: visibleTasks,
    statuses,
    projects,
    releases,
    users,
    labelGroups: data.labelGroups ?? [],
    labels: data.labels,
    taskLabels: data.taskLabels,
    labelGroupId: display.labelGroupId ?? null,
    groupBy: display.groupBy,
    showEmptyGroups: shouldShowEmptyTaskGroups(
      display.groupBy,
      display.showEmptyGroups,
      draggingTaskId !== null,
    ),
  });
  const keyboardTasks = display.groupBy !== "none"
    ? tasksInGroupOrder(taskGroups, layout === "list" ? collapsedGroups : new Set())
    : visibleTasks;
  const keyboardTaskIds = keyboardTasks.map((task) => task.id);
  const selectableTaskIds = new Set(
    keyboardTasks
      .filter((task) => canEditContent(task.accessRole))
      .map((task) => task.id),
  );
  return {
    taskGroups,
    keyboardTaskIds,
    selectableTaskIds,
    keyboardTaskIdsKey: keyboardTaskIds.join("\u0000"),
    selectableTaskIdsKey: [...selectableTaskIds].join("\u0000"),
    createAssigneeUserIds: createAssigneeIds(data, contextProjectRecord),
  };
}

export function useTaskTrackerGroupingController(options: GroupingControllerOptions) {
  const {
    data,
    visibleTasks,
    taskPool,
    userMap,
    contextProject,
    contextProjectRecord,
    display,
    layout,
    collapsedGroups,
    draggingTaskId,
    mutate,
    updateClientTask,
    onError,
  } = options;
  const [pendingProjectMove, setPendingProjectMove] =
    useState<PendingProjectGroupMove | null>(null);
  const model = useMemo(() => groupingModel({
    data,
    visibleTasks,
    userMap,
    contextProject,
    contextProjectRecord,
    display,
    layout,
    collapsedGroups,
    draggingTaskId,
  }), [
    collapsedGroups,
    contextProject,
    contextProjectRecord,
    data,
    display,
    draggingTaskId,
    layout,
    userMap,
    visibleTasks,
  ]);

  async function moveWithoutManualOrder(task: TaskRecord, group: TaskGroup | null) {
    if (!group || group.kind === "project") return false;
    const confirmReleasedComposition = group.kind === "release" &&
      releasedMoveNeedsConfirmation(task, group.release?.id ?? null, data);
    if (confirmReleasedComposition && !confirmReleasedCompositionChange()) return false;
    return mutate(`/api/tasks/${task.id}`, "PATCH", {
      version: taskMutationVersion(task),
      ...taskGroupCreateDefaults(group),
      ...(confirmReleasedComposition ? { confirmReleasedComposition: true } : {}),
    });
  }

  async function moveWithManualOrder(task: TaskRecord, position: MovePosition) {
    const previousTask = position.previousTaskId
      ? taskPool.find((item) => item.id === position.previousTaskId)
      : null;
    const nextTask = position.nextTaskId
      ? taskPool.find((item) => item.id === position.nextTaskId)
      : null;
    let rank: number;
    try {
      rank = rankBetweenNeighbors(previousTask?.rank ?? null, nextTask?.rank ?? null);
    } catch (rankError) {
      onError(rankError instanceof Error
        ? rankError.message
        : "Task order changed; reload and retry");
      return false;
    }
    const targetGroupValue = position.group?.value ?? null;
    const nextReleaseId = display.groupBy === "release" ? targetGroupValue : task.releaseId;
    const confirmReleasedComposition = releasedMoveNeedsConfirmation(
      task,
      nextReleaseId,
      data,
    );
    if (confirmReleasedComposition && !confirmReleasedCompositionChange()) return false;
    const optimistic = position.group
      ? projectTaskGroupMove(task, position.group, rank)
      : { ...task, rank };
    updateClientTask(task.id, (current) => position.group
      ? projectTaskGroupMove(current, position.group, rank)
      : { ...current, rank });
    const saved = await mutate(`/api/tasks/${task.id}/reorder`, "POST", {
      version: taskMutationVersion(task),
      groupBy: display.groupBy,
      expectedGroupValue: taskGroupValue(
        task,
        display.groupBy,
        data.taskLabels,
        data.labels,
        display.labelGroupId ?? null,
      ),
      targetGroupValue,
      previousTaskId: position.previousTaskId,
      nextTaskId: position.nextTaskId,
      ...(confirmReleasedComposition ? { confirmReleasedComposition: true } : {}),
    });
    if (!saved) {
      updateClientTask(task.id, (current) =>
        rollbackTaskGroupMove(current, task, optimistic));
    }
    return saved;
  }

  async function moveTaskToGroup(
    task: TaskRecord,
    group: TaskGroup | null,
    previousTaskId: string | null,
    nextTaskId: string | null,
  ) {
    const statusArchived = group?.kind === "status" &&
      Boolean(data.statuses.find((status) => status.id === group.value)?.archivedAt);
    if (group && (!canMoveTaskToGroup(task, group) || statusArchived)) return false;
    if (display.groupBy === "label_group") {
      if (!display.labelGroupId || !group) return false;
      return mutate(`/api/tasks/${task.id}/label-groups`, "PUT", {
        groupId: display.labelGroupId,
        labelId: group.value,
      });
    }
    const projectMove = projectGroupMovePreview(task, group);
    if (projectMove) {
      setPendingProjectMove(projectMove);
      return true;
    }
    if (display.orderBy !== "manual") return moveWithoutManualOrder(task, group);
    return moveWithManualOrder(task, { group, previousTaskId, nextTaskId });
  }

  return {
    ...model,
    pendingProjectMove,
    setPendingProjectMove,
    moveTaskToGroup,
  };
}
