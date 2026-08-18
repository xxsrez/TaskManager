import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { getAgentWorkspace } from "../lib/agent-api-repository";
import { ConflictError, NotFoundError, ValidationError } from "../lib/domain";
import {
  createProject,
  createSavedView,
  createTask,
  getOrCreateUser,
  getSnapshot,
  grantAccess,
} from "../lib/repository";
import { getWorkspaceSync } from "../lib/workspace-sync";
import {
  archiveWorkflowStatus,
  createWorkflowStatus,
  listWorkflowStatuses,
  moveWorkflowStatus,
  restoreWorkflowStatus,
  updateWorkflowStatus,
} from "../lib/workflow-statuses";
import { createD1TestHarness } from "./helpers/d1";

let dispose: (() => Promise<void>) | undefined;

before(async () => {
  const harness = await createD1TestHarness();
  dispose = harness.dispose;
});

after(async () => {
  await dispose?.();
});

test("workflow migration preserves existing catalogs and backfills one reserved Duplicate per user", () => {
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "0000_chilly_malice.sql", "0001_wide_skreet.sql", "0002_stiff_madame_hydra.sql",
    "0003_green_white_queen.sql", "0004_large_rocket_racer.sql", "0005_mixed_bruce_banner.sql",
    "0006_complex_reavers.sql", "0007_curious_sharon_carter.sql", "0008_loose_the_fallen.sql",
    "0009_talented_otto_octavius.sql", "0010_crazy_puma.sql", "0011_conscious_paibok.sql",
    "0012_empty_saracen.sql", "0013_rapid_gravity.sql", "0014_puzzling_tana_nile.sql",
    "0015_attachments_sync.sql",
  ]) database.exec(readFileSync(join(process.cwd(), "drizzle", migration), "utf8"));
  database.exec(`
    INSERT INTO users (id, display_name, email) VALUES
      ('existing-owner', 'Existing Owner', 'existing@example.test'),
      ('owner-without-duplicate', 'Other Owner', 'other@example.test');
    INSERT INTO workflow_statuses
      (id, owner_user_id, name, category, color, position, is_default)
    VALUES
      ('existing-todo', 'existing-owner', 'Todo', 'unstarted', '#94a3b8', 0, 1),
      ('existing-duplicate', 'existing-owner', 'Duplicate', 'canceled', '#aaaaaa', 1, 0),
      ('other-todo', 'owner-without-duplicate', 'Todo', 'unstarted', '#94a3b8', 0, 1);
  `);
  database.exec(readFileSync(join(process.cwd(), "drizzle", "0016_abandoned_stellaris.sql"), "utf8"));

  const reserved = database.prepare(
    `SELECT owner_user_id, name, category, system_role, archived_at, version
     FROM workflow_statuses WHERE system_role = 'duplicate' ORDER BY owner_user_id`,
  ).all();
  assert.equal(reserved.length, 2);
  assert.deepEqual(reserved.map((row) => [row.owner_user_id, row.name, row.category]), [
    ["existing-owner", "Duplicate", "canceled"],
    ["owner-without-duplicate", "Duplicate", "canceled"],
  ]);
  assert.equal(database.prepare("SELECT version FROM workflow_statuses WHERE id = 'existing-todo'").get()!.version, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'workspace_sync_statuses_%'").get()!.count, 3);
  database.close();
});

test("owner workflow catalog preserves defaults, ordering, optimistic versions, and reserved semantics", async () => {
  const owner = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "workflow-owner",
    displayName: "Workflow Owner",
    email: "workflow-owner@example.test",
  });
  const initial = await listWorkflowStatuses(owner);
  assert.equal(initial.length, 6);
  assert.equal(initial.filter((status) => status.isDefault).length, 1);
  const duplicate = initial.find((status) => status.systemRole === "duplicate")!;
  assert.equal(duplicate.name, "Duplicate");
  assert.equal(duplicate.category, "canceled");

  let statuses = await createWorkflowStatus(owner, {
    name: "Ready",
    category: "unstarted",
    color: "#123abc",
    isDefault: true,
  });
  let ready = statuses.find((status) => status.name === "Ready")!;
  assert.equal(ready.isDefault, true);
  assert.equal(statuses.filter((status) => status.isDefault).length, 1);

  await createProject(owner, { name: "Workflow Tasks", taskCode: "WF" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Workflow Tasks")!;
  const taskIdentity = await createTask(owner, {
    title: "Uses the configured default",
    projectId: project.id,
  });
  await createSavedView(owner, {
    name: "Ready work",
    query: { statusIds: [ready.id] },
    display: {},
  });
  let snapshot = await getSnapshot(owner);
  const createdTask = snapshot.tasks.find((task) => task.id === taskIdentity.id)!;
  assert.equal(createdTask.statusId, ready.id);
  assert.equal(createdTask.startedAt, null);

  await assert.rejects(
    updateWorkflowStatus(owner, ready.id, {
      version: ready.version,
      category: "started",
    }),
    (error: unknown) => error instanceof ValidationError && /cannot be changed/i.test(error.message),
  );
  statuses = await updateWorkflowStatus(owner, ready.id, {
    version: ready.version,
    name: "Ready next",
    color: "#abcdef",
  });
  ready = statuses.find((status) => status.id === ready.id)!;
  assert.equal(ready.name, "Ready next");
  assert.equal(ready.color, "#abcdef");
  await assert.rejects(
    updateWorkflowStatus(owner, ready.id, { version: ready.version - 1, name: "Stale" }),
    (error: unknown) => error instanceof ConflictError,
  );

  const todo = statuses.find((status) => status.name === "Todo")!;
  const orderedUnstarted = statuses.filter((status) => status.category === "unstarted" && !status.archivedAt)
    .sort((left, right) => left.position - right.position);
  const readyIndex = orderedUnstarted.findIndex((status) => status.id === ready.id);
  const peer = orderedUnstarted[readyIndex - 1]!;
  statuses = await moveWorkflowStatus(owner, ready.id, {
    direction: "up",
    version: ready.version,
    peerVersion: peer.version,
  });
  ready = statuses.find((status) => status.id === ready.id)!;
  assert.equal(ready.position, peer.position);

  statuses = await archiveWorkflowStatus(owner, ready.id, {
    version: ready.version,
    replacementStatusId: todo.id,
  });
  ready = statuses.find((status) => status.id === ready.id)!;
  const currentTodo = statuses.find((status) => status.id === todo.id)!;
  assert.ok(ready.archivedAt);
  assert.equal(currentTodo.isDefault, true);
  snapshot = await getSnapshot(owner);
  const migratedTask = snapshot.tasks.find((task) => task.id === taskIdentity.id)!;
  assert.equal(migratedTask.statusId, todo.id);
  assert.equal(migratedTask.startedAt, null);
  assert.deepEqual(snapshot.views[0]?.query.statusIds, [todo.id]);

  const agentWorkspace = await getAgentWorkspace({
    authorizationId: "workflow-test",
    authorizationType: "personal_token",
    clientId: "workflow-test",
    scopes: ["api:read", "api:write"],
    user: owner,
    expiresAt: null,
    resource: null,
  });
  assert.equal(agentWorkspace.statuses.some((status) => status.name === "Ready next"), false);

  statuses = await restoreWorkflowStatus(owner, ready.id, { version: ready.version });
  assert.equal(statuses.find((status) => status.id === ready.id)?.archivedAt, null);
  await assert.rejects(
    archiveWorkflowStatus(owner, duplicate.id, { version: duplicate.version }),
    (error: unknown) => error instanceof ValidationError && /reserved Duplicate/i.test(error.message),
  );
  await assert.rejects(
    createWorkflowStatus(owner, { name: "duplicate", category: "canceled", color: "#111111" }),
    (error: unknown) => error instanceof ValidationError && /unique/i.test(error.message),
  );
});

test("catalog management is owner-only and resets every current project audience", async () => {
  const owner = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "workflow-shared-owner",
    displayName: "Shared Workflow Owner",
    email: "workflow-shared-owner@example.test",
  });
  const collaborator = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "workflow-collaborator",
    displayName: "Workflow Collaborator",
    email: "workflow-collaborator@example.test",
  });
  const outsider = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "workflow-outsider",
    displayName: "Workflow Outsider",
    email: "workflow-outsider@example.test",
  });
  await createProject(owner, { name: "Shared workflow project", taskCode: "SW" });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === "Shared workflow project")!;
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: collaborator.email,
    permission: "editor",
  });
  const ownerBefore = await getSnapshot(owner);
  const collaboratorBefore = await getSnapshot(collaborator);
  const outsiderBefore = await getSnapshot(outsider);
  const ownerTodo = ownerBefore.statuses.find((status) => status.ownerUserId === owner.id && status.name === "Todo")!;

  await assert.rejects(
    updateWorkflowStatus(collaborator, ownerTodo.id, {
      version: ownerTodo.version,
      name: "Collaborator edit",
    }),
    (error: unknown) => error instanceof NotFoundError,
  );
  await createWorkflowStatus(owner, {
    name: "Waiting",
    category: "unstarted",
    color: "#654321",
  });

  const ownerSync = await getWorkspaceSync(owner, ownerBefore.syncCursor!);
  const collaboratorSync = await getWorkspaceSync(collaborator, collaboratorBefore.syncCursor!);
  const outsiderSync = await getWorkspaceSync(outsider, outsiderBefore.syncCursor!);
  assert.equal(ownerSync.resetRequired, true);
  assert.equal(collaboratorSync.resetRequired, true);
  assert.equal(outsiderSync.resetRequired, false);
});
