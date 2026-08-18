import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { configureActorResolverForTests } from "../lib/auth";
import { AgentApiError, parseAgentTaskListQuery } from "../lib/agent-api-contract";
import {
  getAgentTaskDetail,
  listAgentLabels,
  listAgentTasks,
  moveAgentTask,
  setAgentTaskLabel,
} from "../lib/agent-api-repository";
import { ConflictError, PermissionError, ValidationError } from "../lib/domain";
import {
  bulkUpdateTasks,
  bulkMoveTasks,
  bulkSetTaskLabel,
  createLabel,
  createProject,
  createRelease,
  createTask,
  getOrCreateUser,
  getProjectLabelCatalog,
  getSnapshot,
  getTaskLabelState,
  getTask,
  getTaskDetail,
  grantAccess,
  moveTask,
  queryTaskSummaries,
  revokeAccess,
  reorderTask,
  searchTaskIds,
  searchTaskSummaries,
  setTaskLabel,
  setTaskParent,
  transferProjectOwnership,
  updateAccessRole,
  updateTask,
  updateLabel,
} from "../lib/repository";
import { createTaskRelation } from "../lib/task-relations";
import type { TaskRecord } from "../lib/types";
import { GET as searchTasksRoute, POST as createTaskRoute } from "../app/api/tasks/route";
import { POST as queryTasksRoute } from "../app/api/tasks/query/route";
import { GET as getTaskRoute, PATCH as updateTaskRoute } from "../app/api/tasks/[id]/route";
import { POST as moveTaskRoute } from "../app/api/tasks/[id]/move/route";
import { POST as reorderTaskRoute } from "../app/api/tasks/[id]/reorder/route";
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

async function ensureRepositoryTestProject(owner: Awaited<ReturnType<typeof getOrCreateUser>>) {
  let project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Repository Test Tasks" && item.accessRole === "owner",
  );
  if (!project) {
    await createProject(owner, {
      name: "Repository Test Tasks",
      taskCode: "RT",
    });
    project = (await getSnapshot(owner)).projects.find(
      (item) => item.name === "Repository Test Tasks" && item.accessRole === "owner",
    );
  }
  return project!;
}

test("project ACL is enforced by repository reads and writes", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const collaborator = await getOrCreateUser(collaboratorActor);
  const outsider = await getOrCreateUser(outsiderActor);
  await createProject(owner, { name: "Shared project", taskCode: "SP" });
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
    /Project cannot be cleared/,
  );
});

test("one ACL-scoped filter engine covers every Task field, hierarchy, relations, dates, and archive state", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "filter-owner-account",
    email: "filter-owner@example.test",
  });
  const outsider = await getOrCreateUser({
    ...outsiderActor,
    providerAccountKey: "filter-outsider-account",
    email: "filter-outsider@example.test",
  });
  await createProject(owner, { name: "Filter Contract", taskCode: "FC" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Filter Contract")!;
  await createRelease(owner, { name: "Filter Release", projectId: project.id });
  const release = (await getSnapshot(owner)).releases.find((item) => item.name === "Filter Release")!;
  const labels = await createLabel(owner, { name: "Filter Label", color: "#336699" });
  const label = labels.find((item) => item.name === "Filter Label")!;
  const statuses = (await getSnapshot(owner)).statuses.filter((item) => item.ownerUserId === owner.id);
  const started = statuses.find((item) => item.category === "started")!;
  const completed = statuses.find((item) => item.category === "completed")!;
  const canceled = statuses.find((item) => item.category === "canceled" && item.systemRole !== "duplicate")!;

  const parentIdentity = await createTask(owner, { title: "Filter parent", projectId: project.id, assigneeUserId: null });
  const targetIdentity = await createTask(owner, {
    title: "Filter target needle",
    projectId: project.id,
    releaseId: release.id,
    statusId: started.id,
    priority: "urgent",
    assigneeUserId: owner.id,
    estimate: 5,
    dueDate: "2026-08-24",
    labelIds: [label.id],
  });
  const childIdentity = await createTask(owner, { title: "Filter child", projectId: project.id, assigneeUserId: null });
  const relatedIdentity = await createTask(owner, { title: "Filter related", projectId: project.id, assigneeUserId: null });
  const completedIdentity = await createTask(owner, { title: "Filter completed", projectId: project.id, statusId: completed.id, assigneeUserId: owner.id });
  const canceledIdentity = await createTask(owner, { title: "Filter canceled", projectId: project.id, statusId: canceled.id, assigneeUserId: owner.id });
  const archivedIdentity = await createTask(owner, { title: "Filter archived", projectId: project.id, assigneeUserId: owner.id });

  let snapshot = await getSnapshot(owner);
  const child = snapshot.tasks.find((item) => item.id === childIdentity.id)!;
  await setTaskParent(owner, child.id, { version: child.version, parentTaskId: parentIdentity.id });
  await createTaskRelation(owner, targetIdentity.id, {
    targetTaskId: relatedIdentity.id,
    type: "blocks",
    direction: "outgoing",
    idempotencyKey: "filter-contract-blocks",
  });
  const archived = (await getSnapshot(owner)).tasks.find((item) => item.id === archivedIdentity.id)!;
  await updateTask(owner, archived.id, { version: archived.version, archived: true });
  snapshot = await getSnapshot(owner);

  const target = snapshot.tasks.find((item) => item.id === targetIdentity.id)!;
  const parent = snapshot.tasks.find((item) => item.id === parentIdentity.id)!;
  const completedTask = snapshot.tasks.find((item) => item.id === completedIdentity.id)!;
  const canceledTask = snapshot.tasks.find((item) => item.id === canceledIdentity.id)!;
  const query = async (condition: Record<string, unknown>) => queryTaskSummaries(owner, {
    limit: 200,
    query: { version: 1, op: "all", conditions: [condition as never] },
  });
  const includes = async (condition: Record<string, unknown>, taskId: string) => {
    assert.ok((await query(condition)).taskIds.includes(taskId), JSON.stringify(condition));
  };

  await includes({ field: "status", operator: "is", value: started.id }, target.id);
  await includes({ field: "status_category", operator: "is", value: "started" }, target.id);
  await includes({ field: "priority", operator: "in", value: ["urgent"] }, target.id);
  await includes({ field: "assignee", operator: "is", value: owner.id }, target.id);
  await includes({ field: "project", operator: "is", value: project.id }, target.id);
  await includes({ field: "release", operator: "is", value: release.id }, target.id);
  await includes({ field: "label", operator: "is", value: label.id }, target.id);
  await includes({ field: "estimate", operator: "gte", value: 5 }, target.id);
  await includes({ field: "due_date", operator: "on", value: "2026-08-24" }, target.id);
  await includes({ field: "parent", operator: "is", value: parent.id }, child.id);
  await includes({ field: "subtasks", operator: "is", value: true }, parent.id);
  await includes({ field: "relation", operator: "is", value: { type: "blocks", direction: "outgoing" } }, target.id);
  await includes({ field: "created_at", operator: "on", value: target.createdAt.slice(0, 10) }, target.id);
  await includes({ field: "updated_at", operator: "recent", value: 24 }, target.id);
  await includes({ field: "started_at", operator: "on", value: target.startedAt!.slice(0, 10) }, target.id);
  await includes({ field: "completed_at", operator: "on", value: completedTask.completedAt!.slice(0, 10) }, completedTask.id);
  await includes({ field: "canceled_at", operator: "on", value: canceledTask.canceledAt!.slice(0, 10) }, canceledTask.id);
  await includes({ field: "archived", operator: "is", value: true }, archivedIdentity.id);
  await includes({ field: "release", operator: "is_empty" }, parent.id);
  assert.ok((await query({ field: "priority", operator: "is_not", value: "urgent" })).taskIds.every((id) => id !== target.id));
  assert.ok((await queryTaskSummaries(owner, {
    query: { version: 1, op: "all", conditions: [], search: "target needle" },
  })).taskIds.includes(target.id));

  const myTasks = await queryTaskSummaries(owner, { surface: "mine" });
  assert.ok(myTasks.taskIds.includes(target.id));
  assert.ok(myTasks.taskIds.includes(completedIdentity.id));
  assert.ok(myTasks.taskIds.includes(canceledIdentity.id));
  assert.ok(!myTasks.taskIds.includes(parent.id));
  assert.ok(!myTasks.taskIds.includes(archivedIdentity.id));
  const allTasks = await queryTaskSummaries(owner, { surface: "all" });
  assert.ok(allTasks.taskIds.includes(target.id));
  assert.ok(allTasks.taskIds.includes(parent.id));
  await assert.rejects(
    queryTaskSummaries(owner, {
      surface: "mine",
      query: { version: 1, op: "all", conditions: [{ field: "assignee", operator: "is", value: outsider.id }] },
    }),
    /assignee filter is inaccessible/i,
  );

  configureActorResolverForTests(async () => ({
    ...ownerActor,
    providerAccountKey: "filter-owner-account",
    email: "filter-owner@example.test",
  }));
  const routeResponse = await queryTasksRoute(new Request("https://example.test/api/tasks/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: { version: 1, op: "all", conditions: [{ field: "label", operator: "is", value: label.id }] },
      limit: 1,
    }),
  }));
  assert.equal(routeResponse.status, 200);
  const routeBody = await routeResponse.json() as { taskIds: string[]; page: { hasMore: boolean; next: unknown } };
  assert.deepEqual(routeBody.taskIds, [target.id]);
  assert.equal(routeBody.page.hasMore, false);
  configureActorResolverForTests(null);

  const [labelPlan, duePlan, pagePlan] = await database.batch<Record<string, unknown>>([
    database.prepare("EXPLAIN QUERY PLAN SELECT task_id FROM task_labels WHERE label_id = ?").bind(label.id),
    database.prepare("EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE due_date >= ? AND archived_at IS NULL").bind("2026-08-18"),
    database.prepare("EXPLAIN QUERY PLAN SELECT id FROM tasks ORDER BY updated_at DESC, id DESC LIMIT 20"),
  ]);
  assert.match(JSON.stringify(labelPlan.results), /idx_task_labels_label_task/);
  assert.match(JSON.stringify(duePlan.results), /idx_tasks_due_archived/);
  assert.match(JSON.stringify(pagePlan.results), /idx_tasks_updated_id/);

  await assert.rejects(
    queryTaskSummaries(outsider, {
      query: { version: 1, op: "all", conditions: [{ field: "project", operator: "is", value: project.id }] },
    }),
    /inaccessible|not found/i,
  );
});

test("native Labels enforce owner catalogs, ACL, idempotency, archive, bulk, and Agent parity", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "label-owner-account",
    email: "label-owner@example.test",
  });
  const editor = await getOrCreateUser({
    ...collaboratorActor,
    providerAccountKey: "label-editor-account",
    email: "label-editor@example.test",
  });
  await createProject(owner, { name: "Native Label Project", taskCode: "NL" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Native Label Project",
  )!;
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: editor.email,
    permission: "viewer",
  });

  let catalog = await createLabel(owner, {
    name: "Backend",
    color: "#336699",
    description: "Server work",
  });
  const backend = catalog.find((label) => label.name === "Backend")!;
  await assert.rejects(createLabel(owner, { name: "backend" }), /already exists/i);
  await assert.rejects(updateLabel(editor, backend.id, {
    version: backend.version,
    name: "Denied",
  }), /not found/i);

  const created = await createTask(owner, {
    title: "Labelled at creation",
    projectId: project.id,
    labelIds: [backend.id, backend.id],
  });
  const first = await getTask(owner, created.id);
  assert.deepEqual(
    (await getTaskLabelState(owner, first.id)).taskLabels,
    [{ taskId: first.id, labelId: backend.id }],
  );
  await assert.rejects(
    setTaskLabel(editor, first.id, { labelId: backend.id, active: false }),
    PermissionError,
  );

  const grant = (await getSnapshot(owner)).collaborators.find(
    (item) => item.resourceId === project.id && item.userId === editor.id,
  )!;
  await updateAccessRole(owner, grant.grantId, { permission: "editor" });
  await setTaskLabel(editor, first.id, { labelId: backend.id, active: true });
  await setTaskLabel(editor, first.id, { labelId: backend.id, active: true });
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM task_labels WHERE task_id = ? AND label_id = ?",
    ).bind(first.id, backend.id).first<{ count: number }>())!.count),
    1,
  );

  catalog = await createLabel(owner, { name: "Frontend", color: "#aa5500" });
  const frontend = catalog.find((label) => label.name === "Frontend")!;
  await Promise.all([
    setTaskLabel(editor, first.id, { labelId: backend.id, active: true }),
    setTaskLabel(editor, first.id, { labelId: frontend.id, active: true }),
  ]);
  assert.deepEqual(
    (await getTaskLabelState(editor, first.id)).taskLabels.map((item) => item.labelId).sort(),
    [backend.id, frontend.id].sort(),
  );

  await createTask(owner, { title: "Label bulk peer", projectId: project.id });
  const second = (await getSnapshot(owner)).tasks.find(
    (task) => task.title === "Label bulk peer",
  )!;
  await bulkSetTaskLabel(editor, {
    ids: [first.id, second.id],
    labelId: frontend.id,
    active: true,
  });
  await bulkSetTaskLabel(editor, {
    ids: [first.id, second.id],
    labelId: frontend.id,
    active: true,
  });
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM task_labels WHERE label_id = ? AND task_id IN (?, ?)",
    ).bind(frontend.id, first.id, second.id).first<{ count: number }>())!.count),
    2,
  );

  catalog = await updateLabel(owner, backend.id, {
    action: "archive",
    version: backend.version,
  });
  const archived = catalog.find((label) => label.id === backend.id)!;
  assert.equal(
    (await getProjectLabelCatalog(editor, project.id)).labels.some((label) => label.id === backend.id),
    false,
  );
  assert.equal(
    (await getProjectLabelCatalog(editor, project.id, true)).labels.some((label) => label.id === backend.id),
    true,
  );
  await assert.rejects(
    setTaskLabel(editor, second.id, { labelId: backend.id, active: true }),
    /Archived Labels cannot be assigned/,
  );
  await setTaskLabel(editor, first.id, { labelId: backend.id, active: false });
  await setTaskLabel(editor, first.id, { labelId: backend.id, active: false });
  await assert.rejects(updateLabel(owner, backend.id, {
    action: "restore",
    version: archived.version - 1,
  }), ConflictError);

  const agentCatalog = await listAgentLabels(editor, true);
  const frontendRef = agentCatalog.items.find((label) => label.name === "Frontend")!.ref;
  await setAgentTaskLabel(editor, first.publicId, frontendRef, true);
  await setAgentTaskLabel(editor, first.publicId, frontendRef, true);
  assert.equal(
    (await getAgentTaskDetail(editor, first.publicId)).labels.some(
      (label) => label.ref === frontendRef,
    ),
    true,
  );
  const editorCatalog = await createLabel(editor, { name: "Backend", color: "#112233" });
  const foreignLabel = editorCatalog.find((label) => label.name === "Backend")!;
  await assert.rejects(
    setTaskLabel(editor, first.id, { labelId: foreignLabel.id, active: true }),
    /Label not found/,
  );

  await revokeAccess(owner, grant.grantId);
  await assert.rejects(
    setTaskLabel(editor, second.id, { labelId: frontend.id, active: false }),
    /not found/i,
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
  const owner = await getOrCreateUser(ownerActor);
  const project = await ensureRepositoryTestProject(owner);
  const invalid = await createTaskRoute(new Request("https://example.test/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Invalid date", dueDate: "2026-02-29", projectId: project.id }),
  }));
  assert.equal(invalid.status, 400);

  const created = await createTaskRoute(new Request("https://example.test/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Created through route", projectId: project.id }),
  }));
  assert.equal(created.status, 200);
  const payload = await created.json() as {
    tasks: Array<{ id: string; title: string }>;
    createdTask: { id: string; publicId: string };
  };
  assert.equal(
    payload.tasks.find((task) => task.title === "Created through route")?.id,
    payload.createdTask.id,
  );
});

test("generic Task patches cannot bypass the explicit Project move boundary", async () => {
  const owner = await getOrCreateUser(ownerActor);
  await createProject(owner, { name: "Grouping source", taskCode: "GS" });
  await createProject(owner, { name: "Grouping target", taskCode: "GT" });
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

  await assert.rejects(
    updateTask(owner, task.id, {
      version: task.version,
      projectId: target.id,
      releaseId: release.id,
      rank: 2000,
    }),
    /explicit Task move command/,
  );
  await assert.rejects(
    updateTask(owner, task.id, {
      version: task.version,
      projectId: null,
      rank: 3000,
    }),
    /Project cannot be cleared/,
  );
  task = (await getSnapshot(owner)).tasks.find((item) => item.id === task.id)!;
  assert.equal(task.projectId, source.id);
  assert.equal(task.releaseId, null);
});

test("explicit Task moves allocate atomically, preserve identity, and enforce dependent effects", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const collaborator = await getOrCreateUser(collaboratorActor);
  const outsider = await getOrCreateUser(outsiderActor);
  await createProject(owner, { name: "Move source project", taskCode: "MS" });
  await createProject(owner, { name: "Move target project", taskCode: "MT" });
  await createProject(owner, { name: "Move archived target", taskCode: "MA" });
  const projects = (await getSnapshot(owner)).projects;
  const source = projects.find((project) => project.name === "Move source project")!;
  const target = projects.find((project) => project.name === "Move target project")!;
  const archivedTarget = projects.find((project) => project.name === "Move archived target")!;
  await database.prepare("UPDATE projects SET archived_at = ? WHERE id = ?")
    .bind("2026-08-18T00:00:00.000Z", archivedTarget.id)
    .run();
  await createRelease(owner, { name: "Move source release", projectId: source.id });
  await createRelease(owner, { name: "Move target release", projectId: target.id });
  const releases = (await getSnapshot(owner)).releases;
  const sourceRelease = releases.find((release) => release.name === "Move source release")!;
  const targetRelease = releases.find((release) => release.name === "Move target release")!;

  await grantAccess(owner, {
    resourceType: "project",
    resourceId: source.id,
    email: collaborator.email,
    permission: "editor",
  });
  await createTask(owner, {
    title: "Existing target sequence",
    projectId: target.id,
  });
  await createTask(owner, {
    title: "Atomic move subject",
    description: "Keep description and identity",
    projectId: source.id,
    releaseId: sourceRelease.id,
    assigneeUserId: collaborator.id,
  });
  let task = (await getSnapshot(owner)).tasks.find(
    (item) => item.title === "Atomic move subject",
  )!;
  const oldIdentifier = task.identifier;
  const publicId = task.publicId;
  await database.prepare(
    `INSERT INTO comments
       (id, task_id, author_user_id, body, idempotency_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind("comment-move-preserve", task.id, owner.id, "Keep comment", "move-preserve").run();

  const initialTargetSequence = Number((await database.prepare(
    "SELECT task_sequence FROM projects WHERE id = ?",
  ).bind(target.id).first<{ task_sequence: number }>())!.task_sequence);
  await assert.rejects(
    moveTask(owner, task.id, {
      version: task.version,
      targetProjectId: target.id,
    }),
    /explicitly clear the current Release/,
  );
  assert.equal(
    Number((await database.prepare("SELECT task_sequence FROM projects WHERE id = ?")
      .bind(target.id).first<{ task_sequence: number }>())!.task_sequence),
    initialTargetSequence,
  );
  await assert.rejects(
    moveTask(owner, task.id, {
      version: task.version,
      targetProjectId: target.id,
      releaseId: targetRelease.id,
    }),
    /explicitly clear the assignee/,
  );

  await grantAccess(owner, {
    resourceType: "project",
    resourceId: target.id,
    email: collaborator.email,
    permission: "viewer",
  });
  task = await moveTask(owner, task.id, {
    version: task.version,
    targetProjectId: target.id,
    releaseId: targetRelease.id,
  });
  assert.equal(task.projectId, target.id);
  assert.equal(task.identifier, "MT-2");
  assert.equal(task.sequenceNumber, 2);
  assert.equal(task.publicId, publicId);
  assert.equal(task.title, "Atomic move subject");
  assert.equal(task.description, "Keep description and identity");
  assert.equal(task.releaseId, targetRelease.id);
  assert.equal(task.assigneeUserId, collaborator.id);
  assert.equal(
    (await database.prepare("SELECT COUNT(*) AS count FROM comments WHERE task_id = ?")
      .bind(task.id).first<{ count: number }>())!.count,
    1,
  );
  assert.equal((await searchTaskIds(owner, oldIdentifier))[0], task.id);
  assert.equal((await getAgentTaskDetail(owner, oldIdentifier)).ref, publicId);
  const alias = await database.prepare(
    "SELECT identifier FROM task_identifier_aliases WHERE task_id = ? AND identifier = ?",
  ).bind(task.id, oldIdentifier).first<{ identifier: string }>();
  assert.equal(alias?.identifier, oldIdentifier);

  const sameProjectSequence = Number((await database.prepare(
    "SELECT task_sequence FROM projects WHERE id = ?",
  ).bind(target.id).first<{ task_sequence: number }>())!.task_sequence);
  const sameProject = await moveTask(owner, task.id, {
    version: task.version,
    targetProjectId: target.id,
  });
  assert.deepEqual(sameProject, task);
  assert.equal(
    Number((await database.prepare("SELECT task_sequence FROM projects WHERE id = ?")
      .bind(target.id).first<{ task_sequence: number }>())!.task_sequence),
    sameProjectSequence,
  );
  await assert.rejects(
    moveTask(owner, task.id, {
      version: task.version - 1,
      targetProjectId: source.id,
      releaseId: null,
      assigneeUserId: null,
    }),
    ConflictError,
  );
  await assert.rejects(
    moveTask(outsider, task.id, {
      version: task.version,
      targetProjectId: source.id,
      releaseId: null,
      assigneeUserId: null,
    }),
    /not found/i,
  );

  await createTask(owner, { title: "Move hierarchy child", projectId: target.id });
  const child = (await getSnapshot(owner)).tasks.find(
    (item) => item.title === "Move hierarchy child",
  )!;
  await database.prepare("UPDATE tasks SET parent_task_id = ? WHERE id = ?")
    .bind(task.id, child.id)
    .run();
  await assert.rejects(
    moveTask(owner, task.id, {
      version: task.version,
      targetProjectId: source.id,
      releaseId: null,
      assigneeUserId: null,
    }),
    /Detach or reparent/,
  );
  await database.prepare("UPDATE tasks SET parent_task_id = NULL WHERE id = ?")
    .bind(child.id)
    .run();
  await database.prepare(
    `INSERT INTO task_relations
       (id, source_task_id, target_task_id, type, creator_user_id, idempotency_key)
     VALUES (?, ?, ?, 'related', ?, ?)`,
  ).bind("relation-move-preserve", task.id, child.id, owner.id, "move-preserve").run();
  await database.prepare(
    "INSERT INTO labels (id, owner_user_id, name) VALUES (?, ?, ?)",
  ).bind("label-move-preserve", owner.id, "Move preserved").run();
  await database.prepare(
    "INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)",
  ).bind(task.id, "label-move-preserve").run();
  task = await moveTask(owner, task.id, {
    version: task.version,
    targetProjectId: source.id,
    releaseId: null,
    assigneeUserId: null,
  });
  assert.equal(task.projectId, source.id);
  assert.equal(task.releaseId, null);
  assert.equal(task.assigneeUserId, null);
  assert.equal(
    (await database.prepare("SELECT COUNT(*) AS count FROM task_relations WHERE id = ?")
      .bind("relation-move-preserve").first<{ count: number }>())!.count,
    1,
  );
  assert.equal(
    (await database.prepare("SELECT COUNT(*) AS count FROM task_labels WHERE task_id = ?")
      .bind(task.id).first<{ count: number }>())!.count,
    1,
  );

  await createTask(owner, { title: "Archived target subject", projectId: source.id });
  const archivedSubject = (await getSnapshot(owner)).tasks.find(
    (item) => item.title === "Archived target subject",
  )!;
  await assert.rejects(
    moveTask(owner, archivedSubject.id, {
      version: archivedSubject.version,
      targetProjectId: archivedTarget.id,
      releaseId: null,
    }),
    /archived Project/,
  );

  configureActorResolverForTests(async () => ownerActor);
  const response = await moveTaskRoute(
    new Request(`https://example.test/api/tasks/${archivedSubject.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: archivedSubject.version,
        targetProjectId: target.id,
        releaseId: null,
      }),
    }),
    { params: Promise.resolve({ id: archivedSubject.id }) },
  );
  assert.equal(response.status, 200);
  const movedByRoute = await response.json() as { task: { publicId: string; identifier: string } };
  assert.equal(movedByRoute.task.publicId, archivedSubject.publicId);
  assert.match(movedByRoute.task.identifier, /^MT-\d+$/);

  await createTask(owner, { title: "Forced rollback subject", projectId: source.id });
  const rollbackSubject = (await getSnapshot(owner)).tasks.find(
    (item) => item.title === "Forced rollback subject",
  )!;
  const sequenceBeforeRollback = Number((await database.prepare(
    "SELECT task_sequence FROM projects WHERE id = ?",
  ).bind(target.id).first<{ task_sequence: number }>())!.task_sequence);
  await database.prepare(
    `CREATE TRIGGER force_move_alias_rollback
     BEFORE INSERT ON task_identifier_aliases
     WHEN NEW.task_id IS NOT NULL
     BEGIN
       SELECT RAISE(ABORT, 'forced move rollback');
     END`,
  ).run();
  await assert.rejects(moveTask(owner, rollbackSubject.id, {
    version: rollbackSubject.version,
    targetProjectId: target.id,
    releaseId: null,
  }));
  await database.prepare("DROP TRIGGER force_move_alias_rollback").run();
  const afterRollback = await getTask(owner, rollbackSubject.id);
  assert.equal(afterRollback.projectId, source.id);
  assert.equal(afterRollback.identifier, rollbackSubject.identifier);
  assert.equal(afterRollback.version, rollbackSubject.version);
  assert.equal(
    Number((await database.prepare("SELECT task_sequence FROM projects WHERE id = ?")
      .bind(target.id).first<{ task_sequence: number }>())!.task_sequence),
    sequenceBeforeRollback,
  );

  await createTask(owner, { title: "Agent move subject", projectId: source.id });
  const agentSubject = (await getSnapshot(owner)).tasks.find(
    (item) => item.title === "Agent move subject",
  )!;
  const agentMoved = await moveAgentTask(owner, agentSubject.publicId, {
    version: agentSubject.version,
    targetProjectRef: target.publicId,
    releaseRef: null,
  });
  assert.equal(agentMoved.ref, agentSubject.publicId);
  assert.ok(agentMoved.project);
  assert.equal(agentMoved.project.ref, target.publicId);

  const concurrentIds: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const created = await createTask(owner, {
      title: `Concurrent move ${index}`,
      projectId: source.id,
    });
    concurrentIds.push(created.id);
  }
  const concurrentTasks = (await getSnapshot(owner)).tasks.filter(
    (item) => concurrentIds.includes(item.id),
  );
  const concurrentlyMoved = await Promise.all(concurrentTasks.map((item) =>
    moveTask(owner, item.id, {
      version: item.version,
      targetProjectId: target.id,
      releaseId: null,
    })));
  assert.equal(new Set(concurrentlyMoved.map((item) => item.identifier)).size, 6);
  assert.equal(new Set(concurrentlyMoved.map((item) => item.sequenceNumber)).size, 6);
});

test("status drag mutation preserves unrelated fields, lifecycle rules, ACL, and conflicts", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const collaborator = await getOrCreateUser(collaboratorActor);
  await createProject(owner, { name: "Status drag project", taskCode: "SD" });
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
  await createProject(owner, { name: "Assignee project", taskCode: "AP" });
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
  const project = await ensureRepositoryTestProject(owner);
  await createTask(owner, { title: "Bulk one", projectId: project.id });
  await createTask(owner, { title: "Bulk two", projectId: project.id });
  const selected = (await getSnapshot(owner)).tasks.filter(
    (task) => task.title === "Bulk one" || task.title === "Bulk two",
  );

  const updated = await bulkUpdateTasks(owner, {
    ids: selected.map((task) => task.id),
    versions: Object.fromEntries(selected.map((task) => [task.id, task.version])),
    field: "priority",
    value: "high",
  });

  assert.equal(updated.length, 2);
  assert.ok(updated.every((task) => task.priority === "high"));
  assert.ok(updated.every((task) => task.version === 2));
});

test("bulk assignee changes are atomic, versioned, ACL-safe, and reversible", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "bulk-assignee-owner",
    email: "bulk-assignee-owner@example.test",
  });
  const member = await getOrCreateUser({
    ...collaboratorActor,
    providerAccountKey: "bulk-assignee-member",
    email: "bulk-assignee-member@example.test",
  });
  const outsider = await getOrCreateUser({
    ...outsiderActor,
    providerAccountKey: "bulk-assignee-outsider",
    email: "bulk-assignee-outsider@example.test",
  });
  await createProject(owner, { name: "Bulk assignee A", taskCode: "BA" });
  await createProject(owner, { name: "Bulk assignee B", taskCode: "BB" });
  let ownerSnapshot = await getSnapshot(owner);
  const projectA = ownerSnapshot.projects.find((project) => project.name === "Bulk assignee A")!;
  const projectB = ownerSnapshot.projects.find((project) => project.name === "Bulk assignee B")!;
  for (const project of [projectA, projectB]) {
    await grantAccess(owner, {
      resourceType: "project",
      resourceId: project.id,
      email: member.email,
      permission: "editor",
    });
  }
  await createTask(owner, { title: "Bulk assignee one", projectId: projectA.id, assigneeUserId: null });
  await createTask(owner, { title: "Bulk assignee two", projectId: projectB.id, assigneeUserId: null });
  const selected = () => getSnapshot(owner).then((snapshot) => snapshot.tasks.filter(
    (task) => task.title === "Bulk assignee one" || task.title === "Bulk assignee two",
  ));
  const request = (tasks: TaskRecord[], value: string | null) => ({
    ids: tasks.map((task) => task.id),
    versions: Object.fromEntries(tasks.map((task) => [task.id, task.version])),
    field: "assigneeUserId",
    value,
  });

  let tasks = await selected();
  let updated = await bulkUpdateTasks(owner, request(tasks, member.id));
  assert.equal(updated.length, 2);
  assert.ok(updated.every((task) => task.assigneeUserId === member.id));

  updated = await bulkUpdateTasks(owner, request(updated, null));
  assert.ok(updated.every((task) => task.assigneeUserId === null));

  await assert.rejects(
    bulkUpdateTasks(owner, request(updated, outsider.id)),
    /assignee must have access/i,
  );
  assert.ok((await selected()).every((task) => task.assigneeUserId === null));

  const stale = await selected();
  await updateTask(owner, stale[0]!.id, {
    version: stale[0]!.version,
    priority: "urgent",
  });
  await assert.rejects(
    bulkUpdateTasks(owner, request(stale, owner.id)),
    ConflictError,
  );
  assert.ok((await selected()).every((task) => task.assigneeUserId === null));

  ownerSnapshot = await getSnapshot(owner);
  const projectBGrant = ownerSnapshot.collaborators.find((grant) =>
    grant.resourceType === "project" &&
    grant.resourceId === projectB.id &&
    grant.userId === member.id
  )!;
  await updateAccessRole(owner, projectBGrant.grantId, { permission: "viewer" });
  tasks = await selected();
  const memberTasks = (await getSnapshot(member)).tasks.filter((task) =>
    tasks.some((selectedTask) => selectedTask.id === task.id)
  );
  await assert.rejects(
    bulkUpdateTasks(member, request(memberTasks, member.id)),
    PermissionError,
  );
  assert.ok((await selected()).every((task) => task.assigneeUserId === null));
});

test("bulk Project and Release changes preserve identity and roll back every invalid set", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "bulk-move-owner",
    email: "bulk-move-owner@example.test",
  });
  await createProject(owner, { name: "Bulk move source", taskCode: "BS" });
  await createProject(owner, { name: "Bulk move target", taskCode: "BT" });
  let snapshot = await getSnapshot(owner);
  const source = snapshot.projects.find((project) => project.name === "Bulk move source")!;
  const target = snapshot.projects.find((project) => project.name === "Bulk move target")!;
  await createRelease(owner, { name: "Source release", projectId: source.id });
  await createRelease(owner, { name: "Target release", projectId: target.id });
  snapshot = await getSnapshot(owner);
  const sourceRelease = snapshot.releases.find((release) => release.name === "Source release")!;
  const targetRelease = snapshot.releases.find((release) => release.name === "Target release")!;
  await createTask(owner, { title: "Bulk move one", projectId: source.id, releaseId: sourceRelease.id });
  await createTask(owner, { title: "Bulk move two", projectId: source.id });
  snapshot = await getSnapshot(owner);
  const selected = snapshot.tasks.filter((task) => task.title === "Bulk move one" || task.title === "Bulk move two");
  const originalPublicIds = new Map(selected.map((task) => [task.id, task.publicId]));
  const originalIdentifiers = new Map(selected.map((task) => [task.id, task.identifier]));
  const versions = Object.fromEntries(selected.map((task) => [task.id, task.version]));
  const targetSequence = target.taskSequence;

  await assert.rejects(
    bulkMoveTasks(owner, {
      ids: selected.map((task) => task.id),
      versions,
      targetProjectId: target.id,
    }),
    /clearing incompatible Releases/i,
  );
  assert.equal((await getSnapshot(owner)).projects.find((project) => project.id === target.id)?.taskSequence, targetSequence);

  const moved = await bulkMoveTasks(owner, {
    ids: selected.map((task) => task.id),
    versions,
    targetProjectId: target.id,
    clearRelease: true,
  });
  assert.deepEqual(moved.map((task) => task.identifier).sort(), [
    `BT-${targetSequence + 1}`,
    `BT-${targetSequence + 2}`,
  ]);
  assert.ok(moved.every((task) => task.projectId === target.id && task.releaseId === null));
  assert.ok(moved.every((task) => task.publicId === originalPublicIds.get(task.id)));
  for (const task of moved) {
    assert.ok((await searchTaskIds(owner, originalIdentifiers.get(task.id)!)).includes(task.id));
  }

  const sequenceAfterMove = (await getSnapshot(owner)).projects.find((project) => project.id === target.id)!.taskSequence;
  const noOp = await bulkMoveTasks(owner, {
    ids: moved.map((task) => task.id),
    versions: Object.fromEntries(moved.map((task) => [task.id, task.version])),
    targetProjectId: target.id,
  });
  assert.deepEqual(noOp.map((task) => task.version), moved.map((task) => task.version));
  assert.equal((await getSnapshot(owner)).projects.find((project) => project.id === target.id)?.taskSequence, sequenceAfterMove);

  let released = await bulkUpdateTasks(owner, {
    ids: moved.map((task) => task.id),
    versions: Object.fromEntries(moved.map((task) => [task.id, task.version])),
    field: "releaseId",
    value: targetRelease.id,
  });
  assert.ok(released.every((task) => task.releaseId === targetRelease.id && task.projectId === target.id));
  released = await bulkUpdateTasks(owner, {
    ids: released.map((task) => task.id),
    versions: Object.fromEntries(released.map((task) => [task.id, task.version])),
    field: "releaseId",
    value: null,
  });
  assert.ok(released.every((task) => task.releaseId === null));

  await createTask(owner, { title: "Bulk hierarchy parent", projectId: source.id });
  await createTask(owner, { title: "Bulk hierarchy child", projectId: source.id });
  snapshot = await getSnapshot(owner);
  const hierarchyParent = snapshot.tasks.find((task) => task.title === "Bulk hierarchy parent")!;
  const hierarchyChild = snapshot.tasks.find((task) => task.title === "Bulk hierarchy child")!;
  await setTaskParent(owner, hierarchyChild.id, { version: hierarchyChild.version, parentTaskId: hierarchyParent.id });
  snapshot = await getSnapshot(owner);
  const hierarchyTasks = snapshot.tasks.filter((task) => task.id === hierarchyParent.id || task.id === hierarchyChild.id);
  const sequenceBeforeBlocked = snapshot.projects.find((project) => project.id === target.id)!.taskSequence;
  await assert.rejects(
    bulkMoveTasks(owner, {
      ids: hierarchyTasks.map((task) => task.id),
      versions: Object.fromEntries(hierarchyTasks.map((task) => [task.id, task.version])),
      targetProjectId: target.id,
      clearRelease: true,
    }),
    /hierarch/i,
  );
  snapshot = await getSnapshot(owner);
  assert.equal(snapshot.projects.find((project) => project.id === target.id)?.taskSequence, sequenceBeforeBlocked);
  assert.ok(snapshot.tasks.filter((task) => hierarchyTasks.some((selectedTask) => selectedTask.id === task.id)).every((task) => task.projectId === source.id));
});

test("manual rank reorder is neighbor-bound, atomic across groups, and conflict-safe", async () => {
  const actor = {
    ...ownerActor,
    providerAccountKey: "rank-owner",
    email: "rank-owner@example.test",
  };
  const owner = await getOrCreateUser(actor);
  await createProject(owner, { name: "Manual rank", taskCode: "MR" });
  let snapshot = await getSnapshot(owner);
  const project = snapshot.projects.find((item) => item.name === "Manual rank")!;
  for (const title of ["Rank A", "Rank B", "Rank C", "Rank D"]) {
    await createTask(owner, { title, projectId: project.id });
  }
  snapshot = await getSnapshot(owner);
  const ordered = snapshot.tasks
    .filter((task) => task.projectId === project.id)
    .sort((left, right) => left.rank - right.rank);
  const [taskA, taskB, taskC, taskD] = ordered;
  assert.ok(taskA && taskB && taskC && taskD);

  const movedFirst = await reorderTask(owner, taskD.id, {
    version: taskD.version,
    groupBy: "status",
    expectedGroupValue: taskD.statusId,
    targetGroupValue: taskA.statusId,
    previousTaskId: null,
    nextTaskId: taskA.id,
  });
  assert.ok(movedFirst.rank < taskA.rank);

  const started = snapshot.statuses.find((status) =>
    status.ownerUserId === owner.id && status.category === "started"
  )!;
  const movedGroup = await reorderTask(owner, taskC.id, {
    version: taskC.version,
    groupBy: "status",
    expectedGroupValue: taskC.statusId,
    targetGroupValue: started.id,
    previousTaskId: null,
    nextTaskId: null,
  });
  assert.equal(movedGroup.statusId, started.id);
  assert.equal(movedGroup.rank, 1000);

  const beforeInvalid = (await getSnapshot(owner)).tasks.find((task) => task.id === taskB.id)!;
  await assert.rejects(
    reorderTask(owner, beforeInvalid.id, {
      version: beforeInvalid.version,
      groupBy: "status",
      expectedGroupValue: beforeInvalid.statusId,
      targetGroupValue: beforeInvalid.statusId,
      previousTaskId: null,
      nextTaskId: movedGroup.id,
    }),
    /neighbor changed groups/i,
  );
  assert.equal((await getSnapshot(owner)).tasks.find((task) => task.id === taskB.id)?.rank, beforeInvalid.rank);

  const current = (await getSnapshot(owner)).tasks.filter((task) => task.projectId === project.id);
  const currentA = current.find((task) => task.id === taskA.id)!;
  const currentB = current.find((task) => task.id === taskB.id)!;
  const currentD = current.find((task) => task.id === taskD.id)!;
  const results = await Promise.allSettled([
    reorderTask(owner, currentA.id, {
      version: currentA.version,
      groupBy: "status",
      expectedGroupValue: currentA.statusId,
      targetGroupValue: currentA.statusId,
      previousTaskId: currentD.id,
      nextTaskId: currentB.id,
    }),
    reorderTask(owner, currentB.id, {
      version: currentB.version,
      groupBy: "status",
      expectedGroupValue: currentB.statusId,
      targetGroupValue: currentB.statusId,
      previousTaskId: currentD.id,
      nextTaskId: currentA.id,
    }),
  ]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  const rankedTasks = (await getSnapshot(owner)).tasks.filter((task) => task.projectId === project.id);
  for (const statusId of new Set(rankedTasks.map((task) => task.statusId))) {
    const ranks = rankedTasks.filter((task) => task.statusId === statusId).map((task) => task.rank);
    assert.equal(new Set(ranks).size, ranks.length);
  }

  configureActorResolverForTests(async () => actor);
  const latest = (await getSnapshot(owner)).tasks.find((task) => task.id === taskD.id)!;
  const response = await reorderTaskRoute(new Request("https://example.test/api/tasks/reorder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: latest.version,
      groupBy: "status",
      expectedGroupValue: latest.statusId,
      targetGroupValue: latest.statusId,
      previousTaskId: null,
      nextTaskId: null,
    }),
  }), { params: Promise.resolve({ id: latest.id }) });
  assert.equal(response.status, 200);
  configureActorResolverForTests(null);
});

test("workspace snapshots expose an explicit bounded task window", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const project = await ensureRepositoryTestProject(owner);
  await createTask(owner, { title: "Window one", projectId: project.id });
  await createTask(owner, { title: "Window two", projectId: project.id });
  await createTask(owner, { title: "Window three", projectId: project.id });

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
  const project = await ensureRepositoryTestProject(owner);
  await createTask(owner, {
    title: "Deferred task body",
    description: "Large detail content that the task list does not render",
    projectId: project.id,
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
  const project = await ensureRepositoryTestProject(owner);
  const hidden = await createTask(owner, {
    title: "Old searchable task",
    description: "unique deferred needle",
    projectId: project.id,
  });
  for (let index = 0; index < 41; index += 1) {
    await createTask(owner, { title: `Newer filler ${index}`, projectId: project.id });
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
  const project = await ensureRepositoryTestProject(owner);
  const parent = await createTask(owner, { title: "Detail context parent", projectId: project.id });
  const focused = await createTask(owner, {
    title: "Detail context focused",
    description: "Full focused body",
    projectId: project.id,
  });
  const related = await createTask(owner, { title: "Detail context related", projectId: project.id });
  await database.batch([
    database.prepare("UPDATE tasks SET parent_task_id = ? WHERE id = ?").bind(parent.id, focused.id),
    database.prepare("INSERT INTO labels (id, owner_user_id, name, color) VALUES (?, ?, ?, ?)").bind("label-detail-context", owner.id, "Detail label", "#123456"),
    database.prepare("INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)").bind(focused.id, "label-detail-context"),
    database.prepare(`INSERT INTO task_relations
      (id, source_task_id, target_task_id, type, creator_user_id, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind("relation-detail-context", focused.id, related.id, "related", owner.id, "relation-detail-context"),
  ]);

  const detail = await getTaskDetail(owner, focused.id);
  assert.equal(detail.task.description, "Full focused body");
  assert.deepEqual(detail.labels.map((label) => label.name), ["Detail label"]);
  assert.deepEqual(detail.taskLabels, [{ taskId: focused.id, labelId: "label-detail-context" }]);
  assert.deepEqual(detail.relations, [{
    id: "relation-detail-context",
    sourceTaskId: focused.id,
    targetTaskId: related.id,
    type: "related",
    version: 1,
    createdAt: detail.relations[0]!.createdAt,
    updatedAt: detail.relations[0]!.updatedAt,
  }]);
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
  const project = await ensureRepositoryTestProject(owner);
  await createTask(owner, { title: "Cursor alpha", projectId: project.id });
  await createTask(owner, { title: "Cursor beta", projectId: project.id });
  await createTask(owner, { title: "Cursor gamma", projectId: project.id });

  const firstQuery = await parseAgentTaskListQuery(
    new URLSearchParams("limit=2&search=Cursor&order=title&direction=asc"),
  );
  const first = await listAgentTasks(owner, firstQuery);
  assert.deepEqual(first.data.map((task) => task.title), ["Cursor alpha", "Cursor beta"]);
  assert.ok(first.page.nextCursor);

  await createTask(owner, { title: "Cursor aardvark", projectId: project.id });
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

test("Project codes drive allocation and legacy aliases resolve safely", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "project-code-owner-account",
    email: "project-code-owner@example.test",
  });
  await createProject(owner, { name: "Code project", taskCode: "pc" });
  await assert.rejects(
    createProject(owner, { name: "Duplicate code", taskCode: "PC" }),
    /Project code is already in use/,
  );
  await assert.rejects(
    createProject(owner, { name: "Invalid code", taskCode: "P1" }),
    /2 or 3 Latin letters/,
  );
  await assert.rejects(
    createTask(owner, { title: "Missing Project" }),
    /Project is required/,
  );

  const firstProject = (await getSnapshot(owner)).projects.find(
    (project) => project.name === "Code project",
  )!;
  await createTask(owner, { title: "First coded Task", projectId: firstProject.id });
  const firstTask = (await getSnapshot(owner)).tasks.find(
    (task) => task.title === "First coded Task",
  )!;
  assert.equal(firstTask.identifier, "PC-1");
  const allocatedProject = (await getSnapshot(owner)).projects.find(
    (project) => project.id === firstProject.id,
  )!;
  assert.equal(allocatedProject.taskSequence, 1);
  assert.ok(allocatedProject.codeLockedAt);
  await assert.rejects(
    database.prepare("UPDATE projects SET task_code = 'PX' WHERE id = ?")
      .bind(firstProject.id).run(),
    /locked Project task code/,
  );
  await assert.rejects(
    database.prepare("UPDATE projects SET task_sequence = 0 WHERE id = ?")
      .bind(firstProject.id).run(),
    /locked Project task code/,
  );

  await database.prepare(
    `INSERT INTO task_identifier_aliases (id, task_id, identifier)
     VALUES ('alias-code-first', ?, 'OLD-9')`,
  ).bind(firstTask.id).run();
  assert.equal((await getAgentTaskDetail(owner, "old-9")).ref, firstTask.publicId);

  await createProject(owner, { name: "Second code project", taskCode: "PD" });
  const secondProject = (await getSnapshot(owner)).projects.find(
    (project) => project.name === "Second code project",
  )!;
  await createTask(owner, { title: "Second coded Task", projectId: secondProject.id });
  const secondTask = (await getSnapshot(owner)).tasks.find(
    (task) => task.title === "Second coded Task",
  )!;
  await database.prepare(
    `INSERT INTO task_identifier_aliases (id, task_id, identifier)
     VALUES ('alias-code-second', ?, 'OLD-9')`,
  ).bind(secondTask.id).run();
  const aliasSearch = await listAgentTasks(
    owner,
    await parseAgentTaskListQuery(
      new URLSearchParams("search=OLD-9&order=title&direction=asc"),
    ),
  );
  assert.deepEqual(
    aliasSearch.data.map((task) => task.identifier),
    ["PC-1", "PD-1"],
  );
  await assert.rejects(
    getAgentTaskDetail(owner, "OLD-9"),
    (error: unknown) =>
      error instanceof AgentApiError &&
      error.code === "ambiguous_reference" &&
      Array.isArray((error.details as { candidates?: unknown[] }).candidates) &&
      (error.details as { candidates: unknown[] }).candidates.length === 2,
  );
});

test("ownership transfer rejects a Project code conflict before mutation", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "transfer-code-owner-account",
    email: "transfer-code-owner@example.test",
  });
  const successor = await getOrCreateUser({
    ...collaboratorActor,
    providerAccountKey: "transfer-code-successor-account",
    email: "transfer-code-successor@example.test",
  });
  await createProject(owner, { name: "Transfer source", taskCode: "CF" });
  await createProject(successor, { name: "Conflicting target", taskCode: "CF" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Transfer source",
  )!;
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: successor.email,
    permission: "manager",
  });

  await assert.rejects(
    transferProjectOwnership(owner, project.id, successor.id),
    /already has a Project with this code/,
  );
  assert.equal(
    (await getSnapshot(owner)).projects.find((item) => item.id === project.id)?.accessRole,
    "owner",
  );
});

test("concurrent task creation allocates unique identifiers atomically", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "sequence-owner-account",
    email: "sequence-owner@example.test",
  });
  const project = await ensureRepositoryTestProject(owner);

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      createTask(owner, { title: `Concurrent ${index + 1}`, projectId: project.id }),
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
