import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { listAgentTaskActivity } from "../lib/agent-api-repository";
import { listTaskActivity } from "../lib/activity";
import { createComment, editComment, setCommentReaction } from "../lib/comments";
import { ConflictError, NotFoundError } from "../lib/domain";
import {
  createLabel,
  createProject,
  createTask,
  getOrCreateUser,
  getSnapshot,
  getTask,
  grantAccess,
  revokeAccess,
  setTaskLabel,
  setTaskParent,
  updateTask,
} from "../lib/repository";
import { createTaskRelation } from "../lib/task-relations";
import { createD1TestHarness } from "./helpers/d1";

let dispose: (() => Promise<void>) | undefined;
let database: D1Database;

before(async () => {
  const harness = await createD1TestHarness();
  database = harness.database;
  dispose = harness.dispose;
});

after(async () => {
  await dispose?.();
});

test("Task activity is atomic, paginated, ACL-scoped, immutable, and agent-readable", async () => {
  const owner = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "activity-owner",
    displayName: "Activity Owner",
    email: "activity-owner@example.test",
  });
  const viewer = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "activity-viewer",
    displayName: "Activity Viewer",
    email: "activity-viewer@example.test",
  });
  const outsider = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "activity-outsider",
    displayName: "Activity Outsider",
    email: "activity-outsider@example.test",
  });
  await createProject(owner, { name: "Activity project", taskCode: "ACT" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Activity project",
  )!;
  const parent = await createTask(owner, {
    title: "Activity parent",
    projectId: project.id,
  });
  const taskIdentity = await createTask(owner, {
    title: "Activity subject",
    projectId: project.id,
  });
  const task = await getTask(owner, taskIdentity.id);

  assert.deepEqual(
    (await listTaskActivity(owner, task.id)).events.map((event) => event.eventType),
    ["task_created"],
  );

  let current = await updateTask(owner, task.id, {
    version: task.version,
    title: "Activity subject updated",
  });
  const afterTitleCount = (await listTaskActivity(owner, task.id)).totalCount;
  const noOp = await updateTask(owner, task.id, {
    version: current.version,
    title: current.title,
  });
  assert.equal(noOp.version, current.version);
  assert.equal((await listTaskActivity(owner, task.id)).totalCount, afterTitleCount);
  await assert.rejects(
    updateTask(owner, task.id, { version: task.version, priority: "high" }),
    ConflictError,
  );
  assert.equal((await listTaskActivity(owner, task.id)).totalCount, afterTitleCount);

  const started = (await getSnapshot(owner)).statuses.find(
    (status) => status.ownerUserId === owner.id && status.category === "started",
  )!;
  current = await updateTask(owner, task.id, {
    version: current.version,
    statusId: started.id,
  });
  const labels = await createLabel(owner, { name: "Activity label", color: "#336699" });
  const label = labels.find((item) => item.name === "Activity label")!;
  await setTaskLabel(owner, task.id, { labelId: label.id, active: true });
  const afterLabelCount = (await listTaskActivity(owner, task.id)).totalCount;
  await setTaskLabel(owner, task.id, { labelId: label.id, active: true });
  assert.equal((await listTaskActivity(owner, task.id)).totalCount, afterLabelCount);

  current = await setTaskParent(owner, task.id, {
    version: current.version,
    parentTaskId: parent.id,
  });
  await createTaskRelation(owner, task.id, {
    targetTaskId: parent.id,
    type: "related",
    direction: "outgoing",
    idempotencyKey: "activity-relation",
  });
  const comment = await createComment(owner, task.id, {
    body: "Activity comment",
    idempotencyKey: "activity-comment",
  });
  const afterCommentCount = (await listTaskActivity(owner, task.id)).totalCount;
  await editComment(owner, task.id, comment.id, {
    version: comment.version,
    body: comment.body,
  });
  assert.equal((await listTaskActivity(owner, task.id)).totalCount, afterCommentCount);
  await setCommentReaction(owner, task.id, comment.id, { emoji: "👍", active: true });
  const afterReactionCount = (await listTaskActivity(owner, task.id)).totalCount;
  await setCommentReaction(owner, task.id, comment.id, { emoji: "👍", active: true });
  assert.equal((await listTaskActivity(owner, task.id)).totalCount, afterReactionCount);

  const all = await listTaskActivity(owner, task.id, { limit: 50 });
  const eventTypes = new Set(all.events.map((event) => event.eventType));
  for (const expected of [
    "task_created",
    "task_updated",
    "status_changed",
    "labels_changed",
    "hierarchy_changed",
    "relation_created",
    "comment_added",
    "comment_reaction_changed",
  ]) {
    assert.ok(eventTypes.has(expected), `missing ${expected}`);
  }
  assert.ok(all.events.every((event) => event.actor.displayName === owner.displayName));
  assert.ok(all.events.every((event) => event.schemaVersion === 1));

  const firstPage = await listTaskActivity(owner, task.id, { limit: 3 });
  assert.equal(firstPage.events.length, 3);
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);
  const secondPage = await listTaskActivity(owner, task.id, {
    limit: 3,
    cursor: firstPage.nextCursor,
  });
  assert.equal(
    new Set([...firstPage.events, ...secondPage.events].map((event) => event.id)).size,
    firstPage.events.length + secondPage.events.length,
  );

  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: viewer.email,
    permission: "viewer",
  });
  assert.equal((await listTaskActivity(viewer, task.id)).totalCount, all.totalCount);
  const agentPage = await listAgentTaskActivity(viewer, task.identifier, { limit: 2 });
  assert.equal(agentPage.data.length, 2);
  assert.equal(agentPage.totalCount, all.totalCount);
  assert.equal(agentPage.data[0]?.actor.isCurrentUser, false);
  const agentAll = await listAgentTaskActivity(viewer, task.identifier, { limit: 50 });
  const agentJson = JSON.stringify(agentAll.data);
  for (const internalId of [task.id, parent.id, project.id, started.id, label.id, owner.id]) {
    assert.equal(agentJson.includes(internalId), false);
  }
  await assert.rejects(listTaskActivity(outsider, task.id), NotFoundError);

  const grant = (await getSnapshot(owner)).collaborators.find(
    (item) => item.resourceId === project.id && item.userId === viewer.id,
  )!;
  await revokeAccess(owner, grant.grantId);
  await assert.rejects(listTaskActivity(viewer, task.id), NotFoundError);

  const event = all.events[0]!;
  await assert.rejects(
    database.prepare(
      "UPDATE activity_events SET actor_name = 'Tampered' WHERE id = ?",
    ).bind(event.id).run(),
    /immutable|constraint|not authorized/i,
  );
  assert.equal((await getTask(owner, task.id)).parentTaskId, parent.id);
});

test("a compound relation rollback leaves neither relation nor activity, then commits one event", async () => {
  const owner = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "activity-rollback-owner",
    displayName: "Activity Rollback Owner",
    email: "activity-rollback-owner@example.test",
  });
  await createProject(owner, { name: "Activity rollback", taskCode: "ARB" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Activity rollback",
  )!;
  const sourceIdentity = await createTask(owner, {
    title: "Duplicate source",
    projectId: project.id,
  });
  const targetIdentity = await createTask(owner, {
    title: "Canonical target",
    projectId: project.id,
  });
  const source = await getTask(owner, sourceIdentity.id);
  const before = (await listTaskActivity(owner, source.id)).totalCount;
  await database.prepare(
    `CREATE TRIGGER activity_test_abort_status
     BEFORE UPDATE OF status_id ON tasks
     WHEN OLD.id = '${source.id}'
     BEGIN SELECT RAISE(ABORT, 'forced activity rollback'); END`,
  ).run();
  try {
    await assert.rejects(createTaskRelation(owner, source.id, {
      targetTaskId: targetIdentity.id,
      type: "duplicate_of",
      direction: "outgoing",
      idempotencyKey: "activity-rollback-relation",
      taskVersion: source.version,
    }), ConflictError);
  } finally {
    await database.prepare("DROP TRIGGER activity_test_abort_status").run();
  }
  assert.equal((await listTaskActivity(owner, source.id)).totalCount, before);
  assert.equal(
    (await database.prepare(
      "SELECT COUNT(*) AS count FROM task_relations WHERE source_task_id = ? AND target_task_id = ?",
    ).bind(source.id, targetIdentity.id).first<{ count: number }>())?.count,
    0,
  );

  await createTaskRelation(owner, source.id, {
    targetTaskId: targetIdentity.id,
    type: "duplicate_of",
    direction: "outgoing",
    idempotencyKey: "activity-rollback-relation",
    taskVersion: source.version,
  });
  const committed = await listTaskActivity(owner, source.id);
  assert.equal(committed.totalCount, before + 1);
  const relationEvent = committed.events.find(
    (event) => event.eventType === "relation_created",
  )!;
  assert.equal(
    (relationEvent.payload.changes as { status: { taskId: string } }).status.taskId,
    source.id,
  );
});
