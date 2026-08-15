import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { configureActorResolverForTests } from "../lib/auth";
import { parseAgentTaskListQuery } from "../lib/agent-api-contract";
import { listAgentTasks } from "../lib/agent-api-repository";
import { PermissionError, ValidationError } from "../lib/domain";
import {
  bulkUpdateTasks,
  createProject,
  createRelease,
  createTask,
  getOrCreateUser,
  getSnapshot,
  getTask,
  grantAccess,
  revokeAccess,
  searchTaskIds,
  updateAccessRole,
  updateTask,
} from "../lib/repository";
import { POST as createTaskRoute } from "../app/api/tasks/route";
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

before(async () => {
  const harness = await createD1TestHarness();
  dispose = harness.dispose;
});

after(async () => {
  configureActorResolverForTests(null);
  await dispose?.();
});

test("project ACL is enforced by repository reads and writes", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const collaborator = await getOrCreateUser(collaboratorActor);
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

  const matches = await searchTaskIds(owner, "detail content");
  assert.deepEqual(matches, [task.id]);
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
