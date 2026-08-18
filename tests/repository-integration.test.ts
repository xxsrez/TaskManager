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
  revokeAccess,
  searchTaskIds,
  searchTaskSummaries,
  setTaskLabel,
  transferProjectOwnership,
  updateAccessRole,
  updateTask,
  updateLabel,
} from "../lib/repository";
import { GET as searchTasksRoute, POST as createTaskRoute } from "../app/api/tasks/route";
import { GET as getTaskRoute, PATCH as updateTaskRoute } from "../app/api/tasks/[id]/route";
import { POST as moveTaskRoute } from "../app/api/tasks/[id]/move/route";
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
    field: "priority",
    value: "high",
  });

  assert.equal(updated.length, 2);
  assert.ok(updated.every((task) => task.priority === "high"));
  assert.ok(updated.every((task) => task.version === 2));
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
