import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskGroups,
  canMoveTaskToGroup,
  projectTaskGroupMove,
  rollbackTaskGroupMove,
  shouldShowEmptyTaskGroups,
  taskGroupCreateDefaults,
  taskGroupMutation,
  tasksInGroupOrder,
} from "../lib/task-groups";
import type {
  ProjectRecord,
  ReleaseRecord,
  TaskRecord,
  UserRecord,
  WorkflowStatusRecord,
} from "../lib/types";

const now = "2026-08-15T08:00:00.000Z";
const statuses: WorkflowStatusRecord[] = [
  {
    id: "todo",
    ownerUserId: "user-1",
    name: "Todo",
    category: "unstarted",
    color: "#888888",
    position: 0,
    isDefault: true,
    systemRole: null,
    archivedAt: null,
    version: 1,
  },
];
const projects: ProjectRecord[] = [
  {
    id: "project-1",
    publicId: "11111111-1111-4111-8111-111111111111",
    ownerUserId: "user-1",
    creatorUserId: "user-1",
    name: "Alpha",
    taskCode: "AL",
    taskSequence: 1,
    codeLockedAt: now,
    summary: "",
    description: "",
    status: "active",
    leadUserId: null,
    startDate: null,
    targetDate: null,
    color: "#5e6ad2",
    version: 1,
    createdAt: now,
    updatedAt: now,
    accessRole: "owner",
  },
];
const releases: ReleaseRecord[] = [
  {
    id: "release-1",
    publicId: "22222222-2222-4222-8222-222222222222",
    projectId: "project-1",
    ownerUserId: "user-1",
    creatorUserId: "user-1",
    name: "v1",
    description: "",
    status: "planned",
    targetDate: null,
    releasedAt: null,
    releaseNotes: "",
    version: 1,
    createdAt: now,
    updatedAt: now,
    accessRole: "owner",
  },
];
const users: UserRecord[] = [
  {
    id: "user-2",
    displayName: "Alex Editor",
    email: "alex@example.test",
    timezone: "UTC",
  },
  {
    id: "user-1",
    displayName: "Test Owner",
    email: "owner@example.test",
    timezone: "UTC",
  },
];
const baseTask: TaskRecord = {
  id: "task-1",
  publicId: "33333333-3333-4333-8333-333333333333",
  ownerUserId: "user-1",
  creatorUserId: "user-1",
  identifier: "TM-1",
  sequenceNumber: 1,
  title: "Urgent launch",
  description: "",
  statusId: "todo",
  priority: "urgent",
  assigneeUserId: null,
  projectId: "project-1",
  releaseId: "release-1",
  estimate: null,
  dueDate: null,
  parentTaskId: null,
  rank: 1000,
  startedAt: null,
  completedAt: null,
  canceledAt: null,
  archivedAt: null,
  commentCount: 0,
  version: 1,
  createdAt: now,
  updatedAt: now,
  accessRole: "owner",
  hasExternalSource: false,
};

test("priority grouping creates ordered empty groups and preserves task order", () => {
  const groups = buildTaskGroups({
    tasks: [baseTask],
    statuses,
    projects,
    releases,
    groupBy: "priority",
    showEmptyGroups: true,
  });

  assert.deepEqual(groups.map((group) => group.label), [
    "Urgent",
    "High",
    "Medium",
    "Low",
    "No priority",
  ]);
  assert.deepEqual(groups[0]?.tasks.map((task) => task.id), ["task-1"]);
  assert.deepEqual(
    tasksInGroupOrder(groups, new Set([groups[0]!.id])).map((task) => task.id),
    [],
  );
});

test("status grouping follows workflow order while first and last tasks change groups", () => {
  const done: WorkflowStatusRecord = {
    id: "done",
    ownerUserId: "user-1",
    name: "Done",
    category: "completed",
    color: "#22c55e",
    position: 1,
    isDefault: false,
    systemRole: null,
    archivedAt: null,
    version: 1,
  };
  const labels = (tasks: TaskRecord[]) => buildTaskGroups({
    tasks,
    statuses: [...statuses, done],
    projects,
    releases,
    groupBy: "status",
    showEmptyGroups: false,
  }).map((group) => group.label);
  const movedToDone = { ...baseTask, statusId: done.id };

  assert.deepEqual(labels([baseTask]), ["Todo"]);
  assert.deepEqual(labels([movedToDone]), ["Done"]);
  assert.deepEqual(labels([baseTask, {
    ...movedToDone,
    id: "task-2",
    publicId: "66666666-6666-4666-8666-666666666666",
    identifier: "TM-2",
  }]), ["Todo", "Done"]);
  assert.deepEqual(labels([]), []);
});

test("status drag projection changes only status and rank and can roll back safely", () => {
  const done: WorkflowStatusRecord = {
    id: "done",
    ownerUserId: "user-1",
    name: "Done",
    category: "completed",
    color: "#22c55e",
    position: 1,
    isDefault: false,
    systemRole: null,
    archivedAt: null,
    version: 1,
  };
  const target = buildTaskGroups({
    tasks: [],
    statuses: [done],
    projects,
    releases,
    users,
    groupBy: "status",
    showEmptyGroups: true,
  })[0]!;

  const optimistic = projectTaskGroupMove(baseTask, target, 2_000);
  assert.equal(optimistic.statusId, done.id);
  assert.equal(optimistic.rank, 2_000);
  assert.equal(optimistic.projectId, baseTask.projectId);
  assert.equal(optimistic.releaseId, baseTask.releaseId);
  assert.equal(optimistic.priority, baseTask.priority);
  assert.deepEqual(rollbackTaskGroupMove(optimistic, baseTask, optimistic), baseTask);

  const concurrent = { ...optimistic, version: 2, title: "Server changed" };
  assert.equal(
    rollbackTaskGroupMove(concurrent, baseTask, optimistic),
    concurrent,
  );
});

test("dragging exposes empty status targets without changing saved empty-group preferences", () => {
  assert.equal(shouldShowEmptyTaskGroups("status", false, false), false);
  assert.equal(shouldShowEmptyTaskGroups("status", false, true), true);
  assert.equal(shouldShowEmptyTaskGroups("priority", false, true), false);
  assert.equal(shouldShowEmptyTaskGroups("priority", true, false), true);
});

test("project grouping is always assigned while release grouping can be unassigned", () => {
  const withoutRelease = {
    ...baseTask,
    id: "task-2",
    publicId: "44444444-4444-4444-8444-444444444444",
    identifier: "TM-2",
    projectId: "project-1",
    releaseId: null,
  };

  const projectGroups = buildTaskGroups({
    tasks: [baseTask, withoutRelease],
    statuses,
    projects,
    releases,
    groupBy: "project",
    showEmptyGroups: false,
  });
  assert.deepEqual(projectGroups.map((group) => group.label), ["Alpha"]);

  const releaseGroups = buildTaskGroups({
    tasks: [baseTask, withoutRelease],
    statuses,
    projects,
    releases,
    groupBy: "release",
    showEmptyGroups: false,
  });
  assert.deepEqual(releaseGroups.map((group) => group.label), ["v1", "No release"]);
});

test("assignee grouping includes people and an explicit unassigned group", () => {
  const assigned = {
    ...baseTask,
    id: "task-assigned",
    publicId: "55555555-5555-4555-8555-555555555555",
    identifier: "TM-3",
    assigneeUserId: "user-2",
  };

  const groups = buildTaskGroups({
    tasks: [assigned, baseTask],
    statuses,
    projects,
    releases,
    users,
    groupBy: "assignee",
    showEmptyGroups: true,
  });

  assert.deepEqual(groups.map((group) => group.label), [
    "Alex Editor",
    "Test Owner",
    "No assignee",
  ]);
  assert.deepEqual(groups[0]?.tasks.map((task) => task.id), ["task-assigned"]);
  assert.deepEqual(groups[2]?.tasks.map((task) => task.id), ["task-1"]);
  assert.deepEqual(taskGroupMutation(groups[0]!, 2500), {
    assigneeUserId: "user-2",
    rank: 2500,
  });
  assert.deepEqual(taskGroupCreateDefaults(groups[2]!), {
    assigneeUserId: null,
  });
});

test("group actions update and create the grouping property", () => {
  const releaseGroup = buildTaskGroups({
    tasks: [baseTask],
    statuses,
    projects,
    releases,
    groupBy: "release",
    showEmptyGroups: false,
  })[0]!;

  assert.deepEqual(taskGroupMutation(releaseGroup, 2000), {
    releaseId: "release-1",
    projectId: "project-1",
    rank: 2000,
  });
  assert.deepEqual(taskGroupCreateDefaults(releaseGroup), {
    releaseId: "release-1",
    projectId: "project-1",
  });
});

test("group moves fail closed across owner and edit boundaries", () => {
  const projectGroup = buildTaskGroups({
    tasks: [baseTask],
    statuses,
    projects,
    releases,
    groupBy: "project",
    showEmptyGroups: true,
  });
  const noProject = projectGroup.find((group) => group.value === null)!;
  assert.equal(canMoveTaskToGroup({ ...baseTask, accessRole: "editor" }, noProject), false);

  const foreignStatus = {
    ...statuses[0]!,
    id: "foreign",
    ownerUserId: "user-2",
  };
  const statusGroup = buildTaskGroups({
    tasks: [],
    statuses: [foreignStatus],
    projects,
    releases,
    groupBy: "status",
    showEmptyGroups: true,
  })[0]!;
  assert.equal(canMoveTaskToGroup(baseTask, statusGroup), false);
});
