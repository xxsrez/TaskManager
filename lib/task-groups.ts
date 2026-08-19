import type {
  LabelGroupRecord,
  LabelRecord,
  Priority,
  ProjectRecord,
  ReleaseRecord,
  TaskRecord,
  TaskLabelAssignment,
  UserRecord,
  ViewDisplay,
  WorkflowStatusRecord,
} from "./types";

export type TaskGroupKind = Exclude<ViewDisplay["groupBy"], "none">;

export type TaskGroup = {
  id: string;
  kind: TaskGroupKind;
  value: string | null;
  label: string;
  tasks: TaskRecord[];
  status?: WorkflowStatusRecord;
  priority?: Priority;
  project?: ProjectRecord;
  release?: ReleaseRecord;
  assignee?: UserRecord;
  labelGroup?: LabelGroupRecord;
  labelRecord?: LabelRecord;
};

const priorities: Array<{ value: Priority; label: string }> = [
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "none", label: "No priority" },
];

export function buildTaskGroups({
  tasks,
  statuses,
  projects,
  releases,
  users = [],
  labelGroups = [],
  labels = [],
  taskLabels = [],
  labelGroupId = null,
  groupBy,
  showEmptyGroups,
}: {
  tasks: TaskRecord[];
  statuses: WorkflowStatusRecord[];
  projects: ProjectRecord[];
  releases: ReleaseRecord[];
  users?: UserRecord[];
  labelGroups?: LabelGroupRecord[];
  labels?: LabelRecord[];
  taskLabels?: TaskLabelAssignment[];
  labelGroupId?: string | null;
  groupBy: ViewDisplay["groupBy"];
  showEmptyGroups: boolean;
}): TaskGroup[] {
  if (groupBy === "none") return [];

  let groups: TaskGroup[];
  if (groupBy === "status") {
    groups = [...statuses]
      .sort((left, right) => left.position - right.position)
      .map((status) => ({
        id: `status:${status.id}`,
        kind: "status",
        value: status.id,
        label: status.name,
        status,
        tasks: tasks.filter((task) => task.statusId === status.id),
      }));
  } else if (groupBy === "priority") {
    groups = priorities.map(({ value, label }) => ({
      id: `priority:${value}`,
      kind: "priority",
      value,
      label,
      priority: value,
      tasks: tasks.filter((task) => task.priority === value),
    }));
  } else if (groupBy === "assignee") {
    groups = [...users]
      .sort((left, right) =>
        left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
      )
      .map((assignee) => ({
        id: `assignee:${assignee.id}`,
        kind: "assignee" as const,
        value: assignee.id,
        label: assignee.displayName,
        assignee,
        tasks: tasks.filter((task) => task.assigneeUserId === assignee.id),
      }));
    groups.push({
      id: "assignee:none",
      kind: "assignee",
      value: null,
      label: "No assignee",
      tasks: tasks.filter((task) => task.assigneeUserId === null),
    });
  } else if (groupBy === "project") {
    groups = [...projects]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((project) => ({
        id: `project:${project.id}`,
        kind: "project" as const,
        value: project.id,
        label: project.name,
        project,
        tasks: tasks.filter((task) => task.projectId === project.id),
      }));
    groups.push({
      id: "project:none",
      kind: "project",
      value: null,
      label: "No project",
      tasks: tasks.filter((task) => task.projectId === null),
    });
  } else if (groupBy === "label_group") {
    const labelGroup = labelGroups.find((group) => group.id === labelGroupId);
    if (!labelGroup) return [];
    const assignedByTask = new Map(taskLabels.map((assignment) => [
      `${assignment.taskId}:${labels.find((label) => label.id === assignment.labelId)?.groupId ?? ""}`,
      assignment.labelId,
    ]));
    groups = labels
      .filter((label) => label.groupId === labelGroup.id)
      .filter((label) => !label.archivedAt || tasks.some((task) => assignedByTask.get(`${task.id}:${labelGroup.id}`) === label.id))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .map((label) => ({
        id: `label-group:${labelGroup.id}:${label.id}`,
        kind: "label_group" as const,
        value: label.id,
        label: label.name,
        labelGroup,
        labelRecord: label,
        tasks: tasks.filter((task) => assignedByTask.get(`${task.id}:${labelGroup.id}`) === label.id),
      }));
    groups.push({
      id: `label-group:${labelGroup.id}:none`,
      kind: "label_group",
      value: null,
      label: `No ${labelGroup.name}`,
      labelGroup,
      tasks: tasks.filter((task) => !assignedByTask.has(`${task.id}:${labelGroup.id}`)),
    });
  } else {
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    groups = [...releases]
      .sort((left, right) => {
        const projectOrder = (projectNames.get(left.projectId) ?? "").localeCompare(
          projectNames.get(right.projectId) ?? "",
        );
        return projectOrder || left.name.localeCompare(right.name);
      })
      .map((release) => ({
        id: `release:${release.id}`,
        kind: "release" as const,
        value: release.id,
        label: release.name,
        release,
        tasks: tasks.filter((task) => task.releaseId === release.id),
      }));
    groups.push({
      id: "release:none",
      kind: "release",
      value: null,
      label: "No release",
      tasks: tasks.filter((task) => task.releaseId === null),
    });
  }

  return showEmptyGroups ? groups : groups.filter((group) => group.tasks.length > 0);
}

export function tasksInGroupOrder(
  groups: TaskGroup[],
  collapsed: ReadonlySet<string>,
): TaskRecord[] {
  return groups.flatMap((group) => collapsed.has(group.id) ? [] : group.tasks);
}

export function taskMatchesGroup(
  task: TaskRecord,
  group: TaskGroup,
  taskLabels: readonly TaskLabelAssignment[] = [],
  labels: readonly LabelRecord[] = [],
): boolean {
  switch (group.kind) {
    case "status":
      return task.statusId === group.value;
    case "priority":
      return task.priority === group.value;
    case "assignee":
      return task.assigneeUserId === group.value;
    case "project":
      return task.projectId === group.value;
    case "release":
      return task.releaseId === group.value;
    case "label_group":
      return taskGroupValue(
        task,
        "label_group",
        taskLabels,
        labels,
        group.labelGroup?.id ?? null,
      ) === group.value;
  }
}

export function canMoveTaskToGroup(task: TaskRecord, group: TaskGroup): boolean {
  if (task.accessRole === "viewer") return false;
  if (group.status) return group.status.ownerUserId === task.ownerUserId;
  if (group.project) {
    return group.project.accessRole !== "viewer";
  }
  if (group.kind === "project" && group.value === null) {
    return task.accessRole === "owner";
  }
  if (group.release) {
    return group.release.projectId === task.projectId && group.release.accessRole !== "viewer";
  }
  if (group.labelGroup) {
    return !group.labelGroup.archivedAt && (!group.labelRecord || !group.labelRecord.archivedAt);
  }
  return true;
}

export function taskGroupValue(
  task: TaskRecord,
  groupBy: ViewDisplay["groupBy"],
  taskLabels: readonly TaskLabelAssignment[] = [],
  labels: readonly LabelRecord[] = [],
  labelGroupId: string | null = null,
): string | null {
  switch (groupBy) {
    case "none": return null;
    case "status": return task.statusId;
    case "priority": return task.priority;
    case "assignee": return task.assigneeUserId;
    case "project": return task.projectId;
    case "release": return task.releaseId;
    case "label_group": {
      const assignment = taskLabels.find((item) => item.taskId === task.id &&
        labels.find((label) => label.id === item.labelId)?.groupId === labelGroupId);
      return assignment?.labelId ?? null;
    }
  }
}

export function rankBetweenNeighbors(
  previousRank: number | null,
  nextRank: number | null,
): number {
  if (previousRank !== null && nextRank !== null) {
    if (!Number.isFinite(previousRank) || !Number.isFinite(nextRank) || previousRank >= nextRank) {
      throw new Error("Task neighbors are not in a stable manual order");
    }
    const midpoint = previousRank + (nextRank - previousRank) / 2;
    if (!Number.isFinite(midpoint) || midpoint === previousRank || midpoint === nextRank) {
      throw new Error("Manual rank space is exhausted; reload and retry");
    }
    return midpoint;
  }
  if (previousRank !== null) {
    if (!Number.isFinite(previousRank)) throw new Error("Previous Task rank is invalid");
    return previousRank + 1000;
  }
  if (nextRank !== null) {
    if (!Number.isFinite(nextRank)) throw new Error("Next Task rank is invalid");
    return nextRank - 1000;
  }
  return 1000;
}

export function reorderInsertionNeighbors(
  tasks: TaskRecord[],
  movingTaskId: string,
  beforeTaskId: string | null,
): { previousTaskId: string | null; nextTaskId: string | null } {
  const candidates = tasks.filter((task) => task.id !== movingTaskId);
  const insertionIndex = beforeTaskId === null
    ? candidates.length
    : candidates.findIndex((task) => task.id === beforeTaskId);
  if (insertionIndex < 0) throw new Error("Task drop target is no longer visible");
  return {
    previousTaskId: candidates[insertionIndex - 1]?.id ?? null,
    nextTaskId: candidates[insertionIndex]?.id ?? null,
  };
}

export function keyboardReorderNeighbors(
  tasks: TaskRecord[],
  movingTaskId: string,
  direction: "up" | "down",
): { previousTaskId: string | null; nextTaskId: string | null } | null {
  const currentIndex = tasks.findIndex((task) => task.id === movingTaskId);
  if (currentIndex < 0) return null;
  if (direction === "up" && currentIndex === 0) return null;
  if (direction === "down" && currentIndex === tasks.length - 1) return null;
  const candidates = tasks.filter((task) => task.id !== movingTaskId);
  const insertionIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  return {
    previousTaskId: candidates[insertionIndex - 1]?.id ?? null,
    nextTaskId: candidates[insertionIndex]?.id ?? null,
  };
}

export function taskGroupMutation(
  group: TaskGroup,
  rank: number,
): Record<string, unknown> {
  return { ...taskGroupCreateDefaults(group), rank };
}

export function projectTaskGroupMove(
  task: TaskRecord,
  group: TaskGroup,
  rank: number,
): TaskRecord {
  const next = { ...task, rank };
  switch (group.kind) {
    case "status":
      next.statusId = group.value!;
      break;
    case "priority":
      next.priority = group.value as Priority;
      break;
    case "assignee":
      next.assigneeUserId = group.value;
      break;
    case "project":
      if (group.value && next.projectId !== group.value) next.releaseId = null;
      if (group.value) next.projectId = group.value;
      break;
    case "release":
      next.releaseId = group.release?.id ?? null;
      if (group.release) next.projectId = group.release.projectId;
      break;
    case "label_group":
      break;
  }
  return next;
}

const taskMoveFields = [
  "statusId",
  "priority",
  "assigneeUserId",
  "projectId",
  "releaseId",
  "rank",
] as const;

export function rollbackTaskGroupMove(
  current: TaskRecord,
  original: TaskRecord,
  optimistic: TaskRecord,
): TaskRecord {
  if (current.id !== original.id || current.version !== original.version) {
    return current;
  }
  const changedFields = taskMoveFields.filter(
    (field) => optimistic[field] !== original[field],
  );
  if (changedFields.some((field) => current[field] !== optimistic[field])) {
    return current;
  }
  const restored = { ...current };
  for (const field of changedFields) {
    Object.assign(restored, { [field]: original[field] });
  }
  return restored;
}

export function shouldShowEmptyTaskGroups(
  groupBy: ViewDisplay["groupBy"],
  configured: boolean,
  dragging: boolean,
): boolean {
  return groupBy === "status" ? dragging : configured;
}

export function taskGroupCreateDefaults(group: TaskGroup): Record<string, unknown> {
  switch (group.kind) {
    case "status":
      return { statusId: group.value };
    case "priority":
      return { priority: group.value };
    case "assignee":
      return { assigneeUserId: group.value };
    case "project":
      return { projectId: group.value };
    case "release":
      return group.release
        ? { releaseId: group.release.id, projectId: group.release.projectId }
        : { releaseId: null };
    case "label_group":
      return { labelGroupId: group.labelGroup?.id, labelId: group.labelRecord?.id ?? null };
  }
}
