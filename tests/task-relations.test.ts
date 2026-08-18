import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, test } from "node:test";
import { POST as createRelationRoute } from "../app/api/tasks/[id]/relations/route";
import {
  DELETE as deleteRelationRoute,
  PATCH as updateRelationRoute,
} from "../app/api/tasks/[id]/relations/[relationId]/route";
import { configureActorResolverForTests } from "../lib/auth";
import {
  ConflictError,
  PermissionError,
  ValidationError,
} from "../lib/domain";
import {
  createProject,
  createTask,
  getOrCreateUser,
  getSnapshot,
  getTask,
  getTaskDetail,
  grantAccess,
} from "../lib/repository";
import {
  createTaskRelation,
  deleteTaskRelation,
  updateTaskRelation,
} from "../lib/task-relations";
import {
  createAgentTaskRelation,
  deleteAgentTaskRelation,
  getAgentTaskDetail,
  updateAgentTaskRelation,
} from "../lib/agent-api-repository";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "relations-owner",
  displayName: "Relations owner",
  email: "relations-owner@example.test",
};
const collaboratorActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "relations-collaborator",
  displayName: "Relations collaborator",
  email: "relations-collaborator@example.test",
};
const viewerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "relations-viewer",
  displayName: "Relations viewer",
  email: "relations-viewer@example.test",
};

let dispose: (() => Promise<void>) | undefined;

before(async () => {
  const harness = await createD1TestHarness();
  dispose = harness.dispose;
});

after(async () => dispose?.());
afterEach(() => configureActorResolverForTests(null));

test("relation migration preserves imported rows and adds stable write metadata", () => {
  const database = new DatabaseSync(":memory:");
  const migrations = readdirSync(join(process.cwd(), "drizzle"))
    .filter((name) => name.endsWith(".sql") && name < "0017_")
    .sort();
  for (const migration of migrations) {
    database.exec(readFileSync(join(process.cwd(), "drizzle", migration), "utf8"));
  }
  database.exec(`
    INSERT INTO users (id, display_name, email)
    VALUES ('relation-owner', 'Relation Owner', 'relation-migration@example.test');
    INSERT INTO task_relations
      (source_task_id, target_task_id, type, creator_user_id, created_at)
    VALUES
      ('legacy-source', 'legacy-target', 'blocks', 'relation-owner',
       '2026-08-17T00:00:00.000Z');
  `);
  database.exec(
    readFileSync(join(process.cwd(), "drizzle", "0017_complex_epoch.sql"), "utf8"),
  );
  const relation = database.prepare(
    `SELECT id, idempotency_key, version, created_at, updated_at
     FROM task_relations`,
  ).get()!;
  assert.equal(
    relation.id,
    "relation_legacy:legacy-source:legacy-target:blocks",
  );
  assert.equal(
    relation.idempotency_key,
    "legacy:legacy-source:legacy-target:blocks",
  );
  assert.equal(relation.version, 1);
  assert.equal(relation.updated_at, relation.created_at);
  assert.equal(
    database.prepare(
      `SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'trigger' AND name LIKE 'workspace_sync_task_relations_%'`,
    ).get()!.count,
    3,
  );
  database.close();
});

test("native relation commands preserve identity, direction, idempotency, and duplicate outcome", async () => {
  const owner = await getOrCreateUser(ownerActor);
  await createProject(owner, { name: "Relations project" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Relations project",
  )!;
  await createTask(owner, { title: "Relation source", projectId: project.id });
  await createTask(owner, { title: "Relation target", projectId: project.id });
  await createTask(owner, { title: "Second canonical", projectId: project.id });
  const tasks = (await getSnapshot(owner)).tasks;
  const source = tasks.find((item) => item.title === "Relation source")!;
  const target = tasks.find((item) => item.title === "Relation target")!;
  const secondCanonical = tasks.find(
    (item) => item.title === "Second canonical",
  )!;

  const related = await createTaskRelation(owner, source.id, {
    targetTaskId: target.id,
    type: "related",
    direction: "incoming",
    idempotencyKey: "relations-related-1",
  });
  assert.equal(related.version, 1);
  assert.deepEqual(
    [related.sourceTaskId, related.targetTaskId],
    [source.id, target.id].sort(),
  );
  assert.equal(
    (await createTaskRelation(owner, source.id, {
      targetTaskId: target.id,
      type: "related",
      direction: "incoming",
      idempotencyKey: "relations-related-1",
    })).id,
    related.id,
  );
  await assert.rejects(
    createTaskRelation(owner, source.id, {
      targetTaskId: target.id,
      type: "related",
      direction: "outgoing",
      idempotencyKey: "relations-related-2",
    }),
    ConflictError,
  );

  const blocks = await createTaskRelation(owner, source.id, {
    targetTaskId: secondCanonical.id,
    type: "blocks",
    direction: "outgoing",
    idempotencyKey: "relations-blocks-1",
  });
  const reversed = await updateTaskRelation(owner, source.id, blocks.id, {
    version: blocks.version,
    type: "blocks",
    direction: "incoming",
  });
  assert.equal(reversed.sourceTaskId, secondCanonical.id);
  assert.equal(reversed.targetTaskId, source.id);
  assert.equal(reversed.version, 2);
  await assert.rejects(
    deleteTaskRelation(owner, source.id, reversed.id, { version: 1 }),
    ConflictError,
  );
  assert.equal(
    (await deleteTaskRelation(owner, source.id, reversed.id, {
      version: reversed.version,
    })).deleted,
    true,
  );

  const sourceBeforeDuplicate = await getTask(owner, source.id);
  const duplicate = await createTaskRelation(owner, source.id, {
    targetTaskId: target.id,
    type: "duplicate_of",
    direction: "outgoing",
    idempotencyKey: "relations-duplicate-1",
    taskVersion: sourceBeforeDuplicate.version,
  });
  const sourceAfterDuplicate = await getTask(owner, source.id);
  const duplicateStatus = (await getSnapshot(owner)).statuses.find(
    (status) => status.systemRole === "duplicate",
  )!;
  assert.equal(sourceAfterDuplicate.statusId, duplicateStatus.id);
  assert.ok(sourceAfterDuplicate.canceledAt);
  await assert.rejects(
    createTaskRelation(owner, source.id, {
      targetTaskId: secondCanonical.id,
      type: "duplicate_of",
      direction: "outgoing",
      idempotencyKey: "relations-duplicate-2",
      taskVersion: sourceAfterDuplicate.version,
    }),
    ConflictError,
  );
  await deleteTaskRelation(owner, source.id, duplicate.id, {
    version: duplicate.version,
  });
  assert.equal((await getTask(owner, source.id)).statusId, duplicateStatus.id);

  const detail = await getTaskDetail(owner, source.id);
  assert.equal(detail.relations.length, 1);
  assert.equal(detail.relations[0]?.id, related.id);
});

test("relation commands require two editable project tasks and reject unsafe shapes", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const collaborator = await getOrCreateUser(collaboratorActor);
  const viewer = await getOrCreateUser(viewerActor);
  await createProject(owner, { name: "Relations ACL project" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Relations ACL project",
  )!;
  await createTask(owner, { title: "ACL source", projectId: project.id });
  await createTask(owner, { title: "ACL target", projectId: project.id });
  await createTask(owner, { title: "Standalone relation peer" });
  const tasks = (await getSnapshot(owner)).tasks;
  const source = tasks.find((item) => item.title === "ACL source")!;
  const target = tasks.find((item) => item.title === "ACL target")!;
  const standalone = tasks.find(
    (item) => item.title === "Standalone relation peer",
  )!;

  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: collaborator.email,
    permission: "editor",
  });
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: viewer.email,
    permission: "viewer",
  });
  const created = await createTaskRelation(collaborator, source.id, {
    targetTaskId: target.id,
    type: "blocks",
    direction: "outgoing",
    idempotencyKey: "relations-editor-1",
  });
  assert.equal(created.type, "blocks");
  await assert.rejects(
    createTaskRelation(viewer, source.id, {
      targetTaskId: target.id,
      type: "related",
      direction: "outgoing",
      idempotencyKey: "relations-viewer-1",
    }),
    PermissionError,
  );
  await assert.rejects(
    createTaskRelation(owner, source.id, {
      targetTaskId: source.id,
      type: "related",
      direction: "outgoing",
      idempotencyKey: "relations-self-1",
    }),
    ValidationError,
  );
  await assert.rejects(
    createTaskRelation(owner, source.id, {
      targetTaskId: standalone.id,
      type: "related",
      direction: "outgoing",
      idempotencyKey: "relations-standalone-1",
    }),
    ValidationError,
  );
  await assert.rejects(
    createTaskRelation(owner, source.id, {
      targetTaskId: target.id,
      type: "duplicate_of",
      direction: "incoming",
      idempotencyKey: "relations-incoming-duplicate-1",
      taskVersion: source.version,
    }),
    ValidationError,
  );
});

test("Agent relation commands use public Task refs and stable relation refs", async () => {
  const owner = await getOrCreateUser(ownerActor);
  await createProject(owner, { name: "Agent relations project" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Agent relations project",
  )!;
  await createTask(owner, { title: "Agent relation source", projectId: project.id });
  await createTask(owner, { title: "Agent relation target", projectId: project.id });
  const tasks = (await getSnapshot(owner)).tasks;
  const source = tasks.find((item) => item.title === "Agent relation source")!;
  const target = tasks.find((item) => item.title === "Agent relation target")!;

  const created = await createAgentTaskRelation(owner, source.publicId, {
    targetTaskRef: target.publicId,
    type: "blocks",
    direction: "outgoing",
    idempotencyKey: "agent-relation-1",
  });
  assert.equal(created.relation.type, "blocks");
  assert.equal(created.relation.direction, "outgoing");
  assert.equal(created.relation.presentation, "blocks");
  assert.equal(created.relation.task.ref, target.publicId);
  assert.match(created.relation.ref, /^relation_/);

  const updated = await updateAgentTaskRelation(
    owner,
    source.identifier,
    created.relation.ref,
    { version: created.relation.version, type: "related", direction: "incoming" },
  );
  assert.equal(updated.relation.ref, created.relation.ref);
  assert.equal(updated.relation.type, "related");
  assert.equal(updated.relation.presentation, "related");
  assert.equal(updated.relation.version, 2);

  const removed = await deleteAgentTaskRelation(
    owner,
    source.publicId,
    created.relation.ref,
    { version: updated.relation.version },
  );
  assert.equal(removed.deleted, true);
  assert.equal(removed.relationRef, created.relation.ref);
  assert.deepEqual((await getAgentTaskDetail(owner, source.publicId)).relations, []);
});

test("browser relation routes expose create, update, and delete without a workspace snapshot", async () => {
  const owner = await getOrCreateUser(ownerActor);
  await createProject(owner, { name: "Route relations project" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Route relations project",
  )!;
  await createTask(owner, { title: "Route relation source", projectId: project.id });
  await createTask(owner, { title: "Route relation target", projectId: project.id });
  const tasks = (await getSnapshot(owner)).tasks;
  const source = tasks.find((item) => item.title === "Route relation source")!;
  const target = tasks.find((item) => item.title === "Route relation target")!;
  configureActorResolverForTests(async () => ownerActor);

  const createdResponse = await createRelationRoute(
    new Request(`https://example.test/api/tasks/${source.id}/relations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetTaskId: target.id,
        type: "blocks",
        direction: "outgoing",
        idempotencyKey: "route-relation-1",
      }),
    }),
    { params: Promise.resolve({ id: source.id }) },
  );
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json() as { relation: { id: string; version: number } };
  assert.deepEqual(Object.keys(created), ["relation"]);

  const updatedResponse = await updateRelationRoute(
    new Request(`https://example.test/api/tasks/${source.id}/relations/${created.relation.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: created.relation.version,
        type: "related",
        direction: "outgoing",
      }),
    }),
    { params: Promise.resolve({ id: source.id, relationId: created.relation.id }) },
  );
  assert.equal(updatedResponse.status, 200);
  const updated = await updatedResponse.json() as { relation: { version: number; type: string } };
  assert.equal(updated.relation.type, "related");
  assert.equal(updated.relation.version, 2);

  const deletedResponse = await deleteRelationRoute(
    new Request(`https://example.test/api/tasks/${source.id}/relations/${created.relation.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: updated.relation.version }),
    }),
    { params: Promise.resolve({ id: source.id, relationId: created.relation.id }) },
  );
  assert.equal(deletedResponse.status, 200);
  assert.equal((await deletedResponse.json() as { deleted: boolean }).deleted, true);
});
