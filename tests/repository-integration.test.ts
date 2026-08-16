import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { configureActorResolverForTests } from "../lib/auth";
import { parseAgentTaskListQuery } from "../lib/agent-api-contract";
import { listAgentTasks } from "../lib/agent-api-repository";
import { ConflictError, PermissionError, ValidationError } from "../lib/domain";
import {
  bulkUpdateTasks,
  createProject,
  createRelease,
  createTask,
  getOrCreateUser,
  getSnapshot,
  getTask,
  getTaskDetail,
  grantAccess,
  revokeAccess,
  searchTaskIds,
  searchTaskSummaries,
  updateAccessRole,
  updateTask,
} from "../lib/repository";
import { GET as searchTasksRoute, POST as createTaskRoute } from "../app/api/tasks/route";
import { GET as getTaskRoute, PATCH as updateTaskRoute } from "../app/api/tasks/[id]/route";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "owner-account",
  displayName: "Owner",
  email: "owner@example.test",
};
const collaboratorActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "collaborator-account",
  displayName: "Collaborator",
  email: "collaborator@example.test",
};
const outsiderActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "outsider-account",
  displayName: "Outsider",
  email: "outsider@example.test",
};

let dispose: (() => Promise<void>) | undefined;
let database: D1Database;

before(async () => {
  const harness = await createD1TestHarness();
  database = harness.database;
  dispose = harness.dispose;
});

after(async () => {
  configureActorResolverForTests(null);
  await dispose?.();
});

test("project ACL is enforced by repository reads and writes", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const collaborator = await getOrCreateUser(collaboratorActor);
  const outsider = await getOrCreateUser(outsiderActor);
  await createProject(owner, { name: "Shared project" });
  const project = (await getSnapshot(owner)).projects[0]!;
  await createTask(owner, { title: "Private project task", projectId: project.id });
  const task = (await getSnapshot(owner)).tasks[0]!;

  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: collaborator.email,
    permission: "viewer",
  });
  const viewerSnapshot = await getSnapshot(collaborator);
  assert.equal(viewerSnapshot.tasks[0]?.id, task.id);
  assert.ok(viewerSnapshot.projects.some((item) => item.id === project.id));
  const outsiderSnapshot = await getSnapshot(outsider);
  assert.ok(!outsiderSnapshot.projects.some((item) => item.id === project.id));
  assert.ok(!outsiderSnapshot.tasks.some((item) => item.id === task.id));
  await assert.rejects(
    updateTask(collaborator, task.id, { version: task.version, title: "Denied" }),
    PermissionError,
  );

  const grant = (await getSnapshot(owner)).collaborators.find(
    (item) => item.resourceId === project.id,
  )!;
  await updateAccessRole(owner, grant.grantId, { permission: "editor" });
  const editableTask = (await getSnapshot(collaborator)).tasks[0]!;
  await updateTask(collaborator, editableTask.id, {
    version: editableTask.version,
    title: "Edited by collaborator",
  });
  const editedTask = (await getSnapshot(owner)).tasks.find((item) => item.id === task.id)!;
  assert.equal(editedTask.title, "Edited by collaborator");
  await assert.rejects(
    updateTask(collaborator, editedTask.id, {
      version: editedTask.version,
      projectId: null,
    }),
    /Only the task owner/,
  );
});

test("task route maps authentication and validation boundaries", async () => {
  configureActorResolverForTests(async () => null);
  const unauthenticated = await createTaskRoute(new Request("https://example.test/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Denied" }),
  }));
  assert.equal(unauthenticated.status, 401);

  configureActorResolverForTests(async () => ownerActor);
  const invalid = await createTaskRoute(new Request("https://example.test/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Invalid date", dueDate: "2026-02-29" }),
  }));
  assert.equal(invalid.status, 400);

  const created = await createTaskRoute(new Request("https://example.test/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Created through route" }),
  }));
  assert.equal(created.status, 200);
  const payload = await created.json() as { tasks: Array<{ title: string }> };
  assert.ok(payload.tasks.some((task) => task.title === "Created through route"));
});

test("grouping moves preserve project and release invariants", async () => {
  const owner = await getOrCreateUser(ownerActor);
  await createProject(owner, { name: "Grouping source" });
  await createProject(owner, { name: "Grouping target" });
  const projects = (await getSnapshot(owner)).projects;
  const source = projects.find((project) => project.name === "Grouping source")!;
  const target = projects.find((project) => project.name === "Grouping target")!;
  await createRelease(owner, { name: "Target release", projectId: target.id });
  const release = (await getSnapshot(owner)).releases.find(
    (item) => item.name === "Target release",
  )!;
  await createTask(owner, { title: "Move between groups", projectId: source.id });
  let task = (await getSnapshot(owner)).tasks.find(
    (item) => item.title === "Move between groups",
  )!;

  task = await updateTask(owner, task.id, {
    version: task.version,
    projectId: target.id,
    releaseId: release.id,
    rank: 2000,
  });
  assert.equal(task.projectId, target.id);
  assert.equal(task.releaseId, release.id);

  task = await updateTask(owner, task.id, {
    version: task.version,
    projectId: null,
    rank: 3000,
  });
  assert.equal(task.projectId, null);
  assert.equal(task.releaseId, null);
});

test("status drag mutation preserves unrelated fields, lifecycle rules, ACL, and conflicts", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const collaborator = await getOrCreateUser(collaboratorActor);
  await createProject(owner, { name: "Status drag project" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Status drag project",
  )!;
  const statuses = (await getSnapshot(owner)).statuses.filter(
    (status) => status.ownerUserId === owner.id,
  );
  const done = statuses.find((status) => status.category === "completed")!;
  await createTask(owner, {
    title: "Status drag task",
    description: "Keep this body",
    projectId: project.id,
    priority: "high",
    dueDate: "2026-08-30",
  });
  const original = await getTask(
    owner,
    (await getSnapshot(owner)).tasks.find((task) => task.title === "Status drag task")!.id,
  );

  configureActorResolverForTests(async () => ownerActor);
  const response = await updateTaskRoute(
    new Request(`https://example.test/api/tasks/${original.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: original.version, statusId: done.id, rank: 9_000 }),
    }),
    { params: Promise.resolve({ id: original.id }) },
  );
  assert.equal(response.status, 200);
  const moved = (await response.json() as { task: typeof original }).task;
  assert.equal(moved.statusId, done.id);
  assert.equal(moved.rank, 9_000);
  assert.ok(moved.completedAt);
  assert.equal(moved.canceledAt, null);
  assert.equal(moved.description, original.description);
  assert.equal(moved.projectId, original.projectId);
  assert.equal(moved.releaseId, original.releaseId);
  assert.equal(moved.priority, original.priority);
  assert.equal(moved.dueDate, original.dueDate);

  await assert.rejects(
    updateTask(owner, moved.id, { version: original.version, statusId: original.statusId }),
    ConflictError,
  );

  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: collaborator.email,
    permission: "viewer",
  });
  await assert.rejects(
    updateTask(collaborator, moved.id, { version: moved.version, statusId: original.statusId }),
    PermissionError,
  );
  const persisted = await getTask(owner, moved.id);
  assert.equal(persisted.statusId, done.id);
});

test("assignee grouping commands enforce task access", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const collaborator = await getOrCreateUser(collaboratorActor);
  const outsider = await getOrCreateUser(outsiderActor);
  await createProject(owner, { name: "Assignee project" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Assignee project",
  )!;
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: collaborator.email,
    permission: "editor",
  });

  await createTask(owner, {
    title: "Create in assignee group",
    projectId: project.id,
    assigneeUserId: collaborator.id,
  });
  let task = (await getSnapshot(owner)).tasks.find(
    (item) => item.title === "Create in assignee group",
  )!;
  assert.equal(task.assigneeUserId, collaborator.id);

  task = await updateTask(owner, task.id, {
    version: task.version,
    assigneeUserId: null,
  });
  assert.equal(task.assigneeUserId, null);

  await assert.rejects(
    updateTask(owner, task.id, {
      version: task.version,
      assigneeUserId: outsider.id,
    }),
    ValidationError,
  );

  task = await updateTask(owner, task.id, {
    version: task.version,
    assigneeUserId: collaborator.id,
  });
  const grant = (await getSnapshot(owner)).collaborators.find(
    (item) =>
      item.resourceType === "project" &&
      item.resourceId === project.id &&
      item.userId === collaborator.id,
  )!;
  await revokeAccess(owner, grant.grantId);
  task = (await getSnapshot(owner)).tasks.find((item) => item.id === task.id)!;
  assert.equal(task.assigneeUserId, null);
});

test("bulk mutations return only updated task records", async () => {
  const owner = await getOrCreateUser(ownerActor);
  await createTask(owner, { title: "Bulk one" });
  await createTask(owner, { title: "Bulk two" });
  const selected = (await getSnapshot(owner)).tasks.filter(
    (task) => task.title === "Bulk one" || task.title === "Bulk two",
  );

  const updated = await bulkUpdateTasks(owner, {
    ids: selected.map((task) => task.id),
    field: "priority",
    value: "high",
  });

  assert.equal(updated.length, 2);
  assert.ok(updated.every((task) => task.priority === "high"));
  assert.ok(updated.every((task) => task.version === 2));
});

test("workspace snapshots expose an explicit bounded task window", async () => {
  const owner = await getOrCreateUser(ownerActor);
  await createTask(owner, { title: "Window one" });
  await createTask(owner, { title: "Window two" });
  await createTask(owner, { title: "Window three" });

  const bounded = await getSnapshot(owner, { taskLimit: 2 });

  assert.equal(bounded.tasks.length, 2);
  assert.deepEqual(bounded.taskWindow, { limit: 2, truncated: true });
  const taskIds = new Set(bounded.tasks.map((task) => task.id));
  assert.ok(bounded.taskLabels.every((assignment) => taskIds.has(assignment.taskId)));
  assert.ok(bounded.relations.every(
    (relation) => taskIds.has(relation.sourceTaskId) && taskIds.has(relation.targetTaskId),
  ));
});

test("workspace snapshots defer task descriptions until task details are requested", async () => {
  const owner = await getOrCreateUser(ownerActor);
  await createTask(owner, {
    title: "Deferred task body",
    description: "Large detail content that the task list does not render",
  });

  const snapshot = await getSnapshot(owner);
  const task = snapshot.tasks.find((item) => item.title === "Deferred task body");

  assert.ok(task);
  assert.equal(task.description, null);

  const detail = await getTask(owner, task.id);
  assert.equal(
    detail.description,
    "Large detail content that the task list does not render",
  );

  const publicDetail = await getTask(owner, task.publicId);
  assert.equal(publicDetail.id, task.id);

  const matches = await searchTaskIds(owner, "detail content");
  assert.deepEqual(matches, [task.id]);
});

test("task search returns compact matches outside the initial workspace window", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const hidden = await createTask(owner, {
    title: "Old searchable task",
    description: "unique deferred needle",
  });
  for (let index = 0; index < 41; index += 1) {
    await createTask(owner, { title: `Newer filler ${index}` });
  }

  const initial = await getSnapshot(owner, { taskLimit: 40 });
  assert.equal(initial.tasks.some((task) => task.id === hidden.id), false);

  const matches = await searchTaskSummaries(owner, "unique deferred needle");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.id, hidden.id);
  assert.equal(matches[0]?.description, null);

  configureActorResolverForTests(async () => ownerActor);
  const response = await searchTasksRoute(
    new Request("https://example.test/api/tasks?search=unique%20deferred%20needle"),
  );
  assert.equal(response.status, 200);
  const payload = await response.json() as {
    taskIds: string[];
    tasks: Array<{ id: string; description: string | null }>;
  };
  assert.deepEqual(payload.taskIds, [hidden.id]);
  assert.equal(payload.tasks[0]?.id, hidden.id);
  assert.equal(payload.tasks[0]?.description, null);
});

test("task detail loads ACL-scoped labels, hierarchy, and relations outside the snapshot window", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const parent = await createTask(owner, { title: "Detail context parent" });
  const focused = await createTask(owner, {
    title: "Detail context focused",
    description: "Full focused body",
  });
  const related = await createTask(owner, { title: "Detail context related" });
  await database.batch([
    database.prepare("UPDATE tasks SET parent_task_id = ? WHERE id = ?").bind(parent.id, focused.id),
    database.prepare("INSERT INTO labels (id, owner_user_id, name, color) VALUES (?, ?, ?, ?)").bind("label-detail-context", owner.id, "Detail label", "#123456"),
    database.prepare("INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)").bind(focused.id, "label-detail-context"),
    database.prepare("INSERT INTO task_relations (source_task_id, target_task_id, type, creator_user_id) VALUES (?, ?, ?, ?)").bind(focused.id, related.id, "related", owner.id),
  ]);

  const detail = await getTaskDetail(owner, focused.id);
  assert.equal(detail.task.description, "Full focused body");
  assert.deepEqual(detail.labels.map((label) => label.name), ["Detail label"]);
  assert.deepEqual(detail.taskLabels, [{ taskId: focused.id, labelId: "label-detail-context" }]);
  assert.deepEqual(detail.relations, [{ sourceTaskId: focused.id, targetTaskId: related.id, type: "related" }]);
  assert.deepEqual(
    new Set(detail.relatedTasks.map((task) => task.id)),
    new Set([parent.id, related.id]),
  );

  configureActorResolverForTests(async () => ownerActor);
  const response = await getTaskRoute(
    new Request(`https://example.test/api/tasks/${focused.id}`),
    { params: Promise.resolve({ id: focused.id }) },
  );
  assert.equal(response.status, 200);
  const payload = await response.json() as typeof detail;
  assert.equal(payload.task.id, focused.id);
  assert.equal(payload.relatedTasks.length, 2);
  assert.equal(payload.labels[0]?.name, "Detail label");
});

test("Agent task cursor remains stable when earlier rows are inserted", async () => {
  const owner = await getOrCreateUser(ownerActor);
  await createTask(owner, { title: "Cursor alpha" });
  await createTask(owner, { title: "Cursor beta" });
  await createTask(owner, { title: "Cursor gamma" });

  const firstQuery = await parseAgentTaskListQuery(
    new URLSearchParams("limit=2&search=Cursor&order=title&direction=asc"),
  );
  const first = await listAgentTasks(owner, firstQuery);
  assert.deepEqual(first.data.map((task) => task.title), ["Cursor alpha", "Cursor beta"]);
  assert.ok(first.page.nextCursor);

  await createTask(owner, { title: "Cursor aardvark" });
  const secondQuery = await parseAgentTaskListQuery(
    new URLSearchParams(`limit=2&search=Cursor&order=title&direction=asc&cursor=${first.page.nextCursor}`),
  );
  const second = await listAgentTasks(owner, secondQuery);
  assert.deepEqual(second.data.map((task) => task.title), ["Cursor gamma"]);

  const nonPrefixQuery = await parseAgentTaskListQuery(
    new URLSearchParams("search=ursor&order=title"),
  );
  const nonPrefix = await listAgentTasks(owner, nonPrefixQuery);
  assert.equal(nonPrefix.data.some((task) => task.title.startsWith("Cursor")), false);
});

test("concurrent task creation allocates unique identifiers atomically", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "sequence-owner-account",
    email: "sequence-owner@example.test",
  });

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      createTask(owner, { title: `Concurrent ${index + 1}` }),
    ),
  );

  const created = (await getSnapshot(owner)).tasks.filter((task) =>
    task.title.startsWith("Concurrent "),
  );
  assert.equal(created.length, 20);
  assert.equal(new Set(created.map((task) => task.identifier)).size, 20);
  assert.deepEqual(
    created.map((task) => task.sequenceNumber).sort((left, right) => left - right),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
});
