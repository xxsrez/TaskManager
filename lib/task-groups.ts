import type {
  Priority,
  ProjectRecord,
  ReleaseRecord,
  TaskRecord,
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
  groupBy,
  showEmptyGroups,
}: {
  tasks: TaskRecord[];
  statuses: WorkflowStatusRecord[];
  projects: ProjectRecord[];
  releases: ReleaseRecord[];
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

export function taskMatchesGroup(task: TaskRecord, group: TaskGroup): boolean {
  switch (group.kind) {
    case "status":
      return task.statusId === group.value;
    case "priority":
      return task.priority === group.value;
    case "project":
      return task.projectId === group.value;
    case "release":
      return task.releaseId === group.value;
  }
}

export function canMoveTaskToGroup(task: TaskRecord, group: TaskGroup): boolean {
  if (task.accessRole === "viewer") return false;
  if (group.status) return group.status.ownerUserId === task.ownerUserId;
  if (group.project) {
    return group.project.ownerUserId === task.ownerUserId && group.project.accessRole !== "viewer";
  }
  if (group.kind === "project" && group.value === null) {
    return task.accessRole === "owner";
  }
  if (group.release) {
    return group.release.ownerUserId === task.ownerUserId && group.release.accessRole !== "viewer";
  }
  return true;
}

export function taskGroupMutation(
  group: TaskGroup,
  rank: number,
): Record<string, unknown> {
  return { ...taskGroupCreateDefaults(group), rank };
}

export function taskGroupCreateDefaults(group: TaskGroup): Record<string, unknown> {
  switch (group.kind) {
    case "status":
      return { statusId: group.value };
    case "priority":
      return { priority: group.value };
    case "project":
      return { projectId: group.value };
    case "release":
      return group.release
        ? { releaseId: group.release.id, projectId: group.release.projectId }
        : { releaseId: null };
  }
}
