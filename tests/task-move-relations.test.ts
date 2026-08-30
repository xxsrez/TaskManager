import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { listTaskActivity } from "../lib/activity";
import { ValidationError } from "../lib/domain";
import {
  bulkMoveTasks,
  createProject,
  createTask,
  getOrCreateUser,
  getSnapshot,
  getTask,
  getTaskDetail,
  moveTask,
} from "../lib/repository";
import { getWorkspaceSync } from "../lib/workspace-sync";
import { createD1TestHarness } from "./helpers/d1";

let dispose: (() => Promise<void>) | undefined;
let database: D1Database;

before(async () => {
  const harness = await createD1TestHarness();
  database = harness.database;
  dispose = harness.dispose;
});

after(async () => dispose?.());

async function ownerWithProjects(key: string) {
  const owner = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: `move-relations-${key}`,
    displayName: `Move Relations ${key}`,
    email: `move-relations-${key}@example.test`,
  });
  await createProject(owner, { name: `Move source ${key}`, taskCode: `MS${key}` });
  await createProject(owner, { name: `Move target ${key}`, taskCode: `MT${key}` });
  const projects = (await getSnapshot(owner)).projects;
  return {
    owner,
    sourceProject: projects.find((project) => project.name === `Move source ${key}`)!,
    targetProject: projects.find((project) => project.name === `Move target ${key}`)!,
  };
}

async function insertRelation(
  id: string,
  sourceTaskId: string,
  targetTaskId: string,
  type: "blocks" | "related" | "duplicate_of",
  creatorUserId: string,
) {
  await database.prepare(
    `INSERT INTO task_relations
      (id, source_task_id, target_task_id, type, creator_user_id, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, sourceTaskId, targetTaskId, type, creatorUserId, id).run();
}

test("single Project move preserves blocks and related edges and invalidates both relation endpoints", async () => {
  const { owner, sourceProject, targetProject } = await ownerWithProjects("A");
  const source = await createTask(owner, { title: "Moving source", projectId: sourceProject.id });
  const blocker = await createTask(owner, { title: "Blocking peer", projectId: sourceProject.id });
  const related = await createTask(owner, { title: "Related peer", projectId: sourceProject.id });
  await insertRelation("move-single-blocks", source.id, blocker.id, "blocks", owner.id);
  await insertRelation("move-single-related", source.id, related.id, "related", owner.id);
  const currentSource = await getTask(owner, source.id);
  const initial = await getSnapshot(owner);

  const moved = await moveTask(owner, source.id, {
    version: currentSource.version,
    targetProjectId: targetProject.id,
  });

  assert.equal(moved.projectId, targetProject.id);
  const rows = await database.prepare(
    `SELECT id FROM task_relations
     WHERE id IN ('move-single-blocks', 'move-single-related') ORDER BY id`,
  ).all<{ id: string }>();
  assert.deepEqual(rows.results.map((row) => row.id), ["move-single-blocks", "move-single-related"]);
  const detail = await getTaskDetail(owner, moved.id);
  assert.deepEqual(
    new Set(detail.relatedTasks.map((task) => task.id)),
    new Set([blocker.id, related.id]),
  );

  const sync = await getWorkspaceSync(owner, initial.syncCursor!);
  assert.equal(sync.changes.tasks.upsert.some((task) => task.id === moved.id), true);
  assert.deepEqual(
    new Set(sync.changes.invalidations.taskDetails),
    new Set([source.id, blocker.id, related.id]),
  );
  assert.deepEqual(sync.changes.invalidations.taskActivities, [source.id]);
  assert.equal((await listTaskActivity(owner, source.id)).events[0]?.eventType, "task_moved");
  assert.equal(
    (await listTaskActivity(owner, blocker.id)).events.some((event) => event.eventType === "task_moved"),
    false,
  );
});

test("single Project move rejects an incident duplicate_of edge", async () => {
  const { owner, sourceProject, targetProject } = await ownerWithProjects("B");
  const source = await createTask(owner, { title: "Duplicate source", projectId: sourceProject.id });
  const duplicateTarget = await createTask(owner, {
    title: "Duplicate target",
    projectId: sourceProject.id,
  });
  await insertRelation(
    "move-single-duplicate",
    source.id,
    duplicateTarget.id,
    "duplicate_of",
    owner.id,
  );
  const currentSource = await getTask(owner, source.id);

  await assert.rejects(
    moveTask(owner, source.id, {
      version: currentSource.version,
      targetProjectId: targetProject.id,
    }),
    ValidationError,
  );
  assert.equal((await getTaskDetail(owner, source.id)).task.projectId, sourceProject.id);
});

test("bulk Project move keeps duplicate_of only when both endpoints move together", async () => {
  const { owner, sourceProject, targetProject } = await ownerWithProjects("C");
  const duplicateSource = await createTask(owner, {
    title: "Bulk duplicate source",
    projectId: sourceProject.id,
  });
  const duplicateTarget = await createTask(owner, {
    title: "Bulk duplicate target",
    projectId: sourceProject.id,
  });
  const relatedPeer = await createTask(owner, {
    title: "Bulk related peer",
    projectId: sourceProject.id,
  });
  await insertRelation(
    "move-bulk-duplicate",
    duplicateSource.id,
    duplicateTarget.id,
    "duplicate_of",
    owner.id,
  );
  await insertRelation(
    "move-bulk-related",
    duplicateSource.id,
    relatedPeer.id,
    "related",
    owner.id,
  );
  const currentDuplicateSource = await getTask(owner, duplicateSource.id);
  const currentDuplicateTarget = await getTask(owner, duplicateTarget.id);
  const initial = await getSnapshot(owner);

  const moved = await bulkMoveTasks(owner, {
    ids: [duplicateSource.id, duplicateTarget.id],
    versions: {
      [duplicateSource.id]: currentDuplicateSource.version,
      [duplicateTarget.id]: currentDuplicateTarget.version,
    },
    targetProjectId: targetProject.id,
  });
  assert.ok(moved.every((task) => task.projectId === targetProject.id));
  assert.equal(
    (await database.prepare("SELECT COUNT(*) AS count FROM task_relations WHERE id = ?")
      .bind("move-bulk-duplicate").first<{ count: number }>())?.count,
    1,
  );
  const sync = await getWorkspaceSync(owner, initial.syncCursor!);
  assert.deepEqual(
    new Set(sync.changes.invalidations.taskDetails),
    new Set([duplicateSource.id, duplicateTarget.id, relatedPeer.id]),
  );

  const strandedSource = await createTask(owner, {
    title: "Stranded duplicate source",
    projectId: sourceProject.id,
  });
  const strandedTarget = await createTask(owner, {
    title: "Stranded duplicate target",
    projectId: sourceProject.id,
  });
  await insertRelation(
    "move-bulk-stranded-duplicate",
    strandedSource.id,
    strandedTarget.id,
    "duplicate_of",
    owner.id,
  );
  const currentStrandedSource = await getTask(owner, strandedSource.id);
  await assert.rejects(
    bulkMoveTasks(owner, {
      ids: [strandedSource.id],
      versions: { [strandedSource.id]: currentStrandedSource.version },
      targetProjectId: targetProject.id,
    }),
    ValidationError,
  );
  assert.equal((await getTaskDetail(owner, strandedSource.id)).task.projectId, sourceProject.id);
});
