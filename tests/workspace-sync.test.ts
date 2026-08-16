import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { GET as syncRoute } from "../app/api/sync/route";
import { configureActorResolverForTests } from "../lib/auth";
import {
  applyWorkspaceSync,
  workspaceSyncRetryDelay,
} from "../lib/workspace-sync-contract";
import {
  createProject,
  createRelease,
  createSavedView,
  createTask,
  getOrCreateUser,
  getSnapshot,
  grantAccess,
  revokeAccess,
  transferProjectOwnership,
  updateTask,
} from "../lib/repository";
import { getWorkspaceSync } from "../lib/workspace-sync";
import type { AppSnapshot, WorkspaceSyncResponse } from "../lib/types";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "sync-owner-account",
  displayName: "Sync Owner",
  email: "sync-owner@example.test",
};
const collaboratorActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "sync-collaborator-account",
  displayName: "Sync Collaborator",
  email: "sync-collaborator@example.test",
};
const outsiderActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "sync-outsider-account",
  displayName: "Sync Outsider",
  email: "sync-outsider@example.test",
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

test("the authenticated sync route returns the principal-scoped contract", async () => {
  configureActorResolverForTests(async () => ownerActor);
  const owner = await getOrCreateUser(ownerActor);
  const initial = await getSnapshot(owner);
  await createTask(owner, { title: "Created through another request" });

  const response = await syncRoute(new Request(
    `https://task-manager.test/api/sync?cursor=${encodeURIComponent(initial.syncCursor!)}`,
  ));
  const value = (await response.json()) as WorkspaceSyncResponse;

  assert.equal(response.status, 200);
  assert.equal(value.resetRequired, false);
  assert.equal(
    value.changes.tasks.upsert.some(
      (task) => task.title === "Created through another request",
    ),
    true,
  );
  configureActorResolverForTests(null);
});

test("incremental sync coalesces ordered task changes and applies them idempotently", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const initial = await getSnapshot(owner);
  assert.ok(initial.syncCursor);

  await createTask(owner, { title: "Created elsewhere" });
  let task = (await getSnapshot(owner)).tasks.find(
    (item) => item.title === "Created elsewhere",
  )!;
  task = await updateTask(owner, task.id, {
    version: task.version,
    title: "Updated elsewhere",
  });

  const response = await getWorkspaceSync(owner, initial.syncCursor!);
  assert.equal(response.resetRequired, false);
  assert.equal(response.hasMore, false);
  assert.deepEqual(response.changes.tasks.remove, []);
  assert.deepEqual(
    response.changes.tasks.upsert.map((item) => [item.id, item.title, item.version]),
    [[task.id, "Updated elsewhere", task.version]],
  );

  const once = applyWorkspaceSync(initial, response);
  const twice = applyWorkspaceSync(once, response);
  assert.deepEqual(twice, once);
  assert.equal(once.tasks.find((item) => item.id === task.id)?.title, "Updated elsewhere");
  assert.equal(once.syncCursor, response.cursor);
});

test("incremental sync removes deleted records and dependent client context", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "sync-delete-owner",
    email: "sync-delete-owner@example.test",
  });
  await createTask(owner, { title: "Delete elsewhere" });
  const initial = await getSnapshot(owner);
  const task = initial.tasks.find((item) => item.title === "Delete elsewhere")!;

  await database.prepare("DELETE FROM tasks WHERE id = ?").bind(task.id).run();
  const response = await getWorkspaceSync(owner, initial.syncCursor!);
  assert.deepEqual(response.changes.tasks.remove, [task.id]);

  const current: AppSnapshot = {
    ...initial,
    taskLabels: [{ taskId: task.id, labelId: "label-stale" }],
    relations: [{ sourceTaskId: task.id, targetTaskId: "other", type: "related" }],
  };
  const next = applyWorkspaceSync(current, response);
  assert.equal(next.tasks.some((item) => item.id === task.id), false);
  assert.equal(next.taskLabels.some((item) => item.taskId === task.id), false);
  assert.equal(
    next.relations.some(
      (item) => item.sourceTaskId === task.id || item.targetTaskId === task.id,
    ),
    false,
  );
});

test("projects, releases, and saved views share the same create and delete feed", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "sync-collections-owner",
    email: "sync-collections-owner@example.test",
  });
  const initial = await getSnapshot(owner);
  await createProject(owner, { name: "Synchronized project" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Synchronized project",
  )!;
  await createRelease(owner, { projectId: project.id, name: "Synchronized release" });
  await createSavedView(owner, {
    name: "Synchronized view",
    scopeProjectId: project.id,
    query: {},
    display: {
      layout: "list",
      groupBy: "status",
      orderBy: "manual",
      direction: "asc",
      showEmptyGroups: true,
      visibleFields: ["priority"],
    },
  });

  const created = await getWorkspaceSync(owner, initial.syncCursor!);
  assert.equal(created.changes.projects.upsert.some((item) => item.id === project.id), true);
  assert.equal(
    created.changes.releases.upsert.some((item) => item.name === "Synchronized release"),
    true,
  );
  assert.equal(
    created.changes.views.upsert.some((item) => item.name === "Synchronized view"),
    true,
  );
  const release = created.changes.releases.upsert.find(
    (item) => item.name === "Synchronized release",
  )!;
  const view = created.changes.views.upsert.find(
    (item) => item.name === "Synchronized view",
  )!;

  await database.prepare("DELETE FROM saved_views WHERE id = ?").bind(view.id).run();
  await database.prepare("DELETE FROM releases WHERE id = ?").bind(release.id).run();
  await database.prepare("DELETE FROM projects WHERE id = ?").bind(project.id).run();
  const removed = await getWorkspaceSync(owner, created.cursor);
  assert.deepEqual(removed.changes.views.remove, [view.id]);
  assert.deepEqual(removed.changes.releases.remove, [release.id]);
  assert.deepEqual(removed.changes.projects.remove, [project.id]);
});

test("task label and relation updates ride on the touched task feed", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "sync-join-owner",
    email: "sync-join-owner@example.test",
  });
  await createTask(owner, { title: "Join source" });
  await createTask(owner, { title: "Join target" });
  const seeded = await getSnapshot(owner);
  const source = seeded.tasks.find((item) => item.title === "Join source")!;
  const target = seeded.tasks.find((item) => item.title === "Join target")!;
  const initial = await getSnapshot(owner);

  await database.batch([
    database
      .prepare(
        `INSERT INTO labels (id, owner_user_id, name, color, created_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      )
      .bind("label-sync", owner.id, "Sync label", "#55aa55"),
    database
      .prepare("INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)")
      .bind(source.id, "label-sync"),
    database
      .prepare(
        `INSERT INTO task_relations
          (source_task_id, target_task_id, type, creator_user_id, created_at)
         VALUES (?, ?, 'related', ?, CURRENT_TIMESTAMP)`,
      )
      .bind(source.id, target.id, owner.id),
  ]);

  const response = await getWorkspaceSync(owner, initial.syncCursor!);
  assert.equal(
    response.changes.tasks.upsert.some((task) => task.id === source.id),
    true,
  );
  assert.equal(
    response.changes.tasks.upsert.some((task) => task.id === target.id),
    true,
  );
  assert.deepEqual(response.changes.taskLabels, [{
    taskId: source.id,
    labelId: "label-sync",
  }]);
  assert.equal(response.changes.labels[0]?.name, "Sync label");
  assert.deepEqual(response.changes.relations, [{
    sourceTaskId: source.id,
    targetTaskId: target.id,
    type: "related",
  }]);
  const after = await getSnapshot(owner);
  assert.equal(after.tasks.find((task) => task.id === source.id)?.updatedAt, source.updatedAt);
  assert.equal(after.tasks.find((task) => task.id === target.id)?.updatedAt, target.updatedAt);
  assert.equal(after.tasks.find((task) => task.id === source.id)?.version, source.version);
});

test("sync fan-out follows current project ACL without exposing unrelated changes", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "sync-acl-owner",
    email: "sync-acl-owner@example.test",
  });
  const collaborator = await getOrCreateUser(collaboratorActor);
  const outsider = await getOrCreateUser(outsiderActor);
  await createProject(owner, { name: "Sync shared project" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Sync shared project",
  )!;
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: collaborator.email,
    permission: "editor",
  });
  const collaboratorInitial = await getSnapshot(collaborator);
  const outsiderInitial = await getSnapshot(outsider);

  await createTask(owner, {
    title: "Visible shared change",
    projectId: project.id,
  });

  const collaboratorResponse = await getWorkspaceSync(
    collaborator,
    collaboratorInitial.syncCursor!,
  );
  assert.equal(collaboratorResponse.resetRequired, false);
  assert.equal(
    collaboratorResponse.changes.tasks.upsert.some(
      (task) => task.title === "Visible shared change",
    ),
    true,
  );

  const outsiderResponse = await getWorkspaceSync(
    outsider,
    outsiderInitial.syncCursor!,
  );
  assert.equal(outsiderResponse.resetRequired, false);
  assert.deepEqual(outsiderResponse.changes.tasks, { upsert: [], remove: [] });
  assert.equal(outsiderResponse.cursor, outsiderInitial.syncCursor);

  const grant = (await getSnapshot(owner)).collaborators.find(
    (item) => item.resourceId === project.id && item.userId === collaborator.id,
  )!;
  const beforeRevoke = collaboratorResponse.cursor;
  await revokeAccess(owner, grant.grantId);
  const revoked = await getWorkspaceSync(collaborator, beforeRevoke);
  assert.equal(revoked.resetRequired, true);
});

test("moving a scoped view removes it from the previous project audience", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "sync-view-move-owner",
    email: "sync-view-move-owner@example.test",
  });
  const collaborator = await getOrCreateUser({
    ...collaboratorActor,
    providerAccountKey: "sync-view-move-collaborator",
    email: "sync-view-move-collaborator@example.test",
  });
  await createProject(owner, { name: "View move project" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "View move project",
  )!;
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: collaborator.email,
    permission: "viewer",
  });
  await createSavedView(owner, {
    name: "View leaving project",
    scopeProjectId: project.id,
    query: {},
    display: {
      layout: "list",
      groupBy: "status",
      orderBy: "manual",
      direction: "asc",
      showEmptyGroups: true,
      visibleFields: [],
    },
  });
  const initial = await getSnapshot(collaborator);
  const view = initial.views.find((item) => item.name === "View leaving project")!;

  await database
    .prepare(
      `UPDATE saved_views
       SET scope_project_id = NULL, version = version + 1
       WHERE id = ?`,
    )
    .bind(view.id)
    .run();
  const response = await getWorkspaceSync(collaborator, initial.syncCursor!);

  assert.deepEqual(response.changes.views.upsert, []);
  assert.deepEqual(response.changes.views.remove, [view.id]);
});

test("release events follow the current project owner after ownership transfer", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "sync-transfer-owner",
    email: "sync-transfer-owner@example.test",
  });
  const successor = await getOrCreateUser({
    ...collaboratorActor,
    providerAccountKey: "sync-transfer-successor",
    email: "sync-transfer-successor@example.test",
  });
  await createProject(owner, { name: "Transferred release project" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Transferred release project",
  )!;
  await createRelease(owner, { projectId: project.id, name: "Historical owner release" });
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: successor.email,
    permission: "editor",
  });
  await transferProjectOwnership(owner, project.id, successor.id);
  const initial = await getSnapshot(successor);
  const release = initial.releases.find((item) => item.name === "Historical owner release")!;
  assert.equal(release.ownerUserId, owner.id);
  assert.equal(
    initial.projects.find((item) => item.id === project.id)?.ownerUserId,
    successor.id,
  );

  await database
    .prepare(
      `UPDATE releases
       SET name = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .bind("Updated by current project owner", release.id)
    .run();
  const response = await getWorkspaceSync(successor, initial.syncCursor!);

  assert.equal(
    response.changes.releases.upsert.find((item) => item.id === release.id)?.name,
    "Updated by current project owner",
  );
});

test("invalid or pruned cursors request a safe full reset", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "sync-gap-owner",
    email: "sync-gap-owner@example.test",
  });
  const initial = await getSnapshot(owner);
  await createTask(owner, { title: "Gap one" });
  await createTask(owner, { title: "Gap two" });
  await database
    .prepare(
      "DELETE FROM workspace_change_events WHERE audience_user_id = ? AND sequence = 1",
    )
    .bind(owner.id)
    .run();

  const gap = await getWorkspaceSync(owner, initial.syncCursor!);
  assert.equal(gap.resetRequired, true);
  const incompatible = await getWorkspaceSync(owner, "not-a-sync-cursor");
  assert.equal(incompatible.resetRequired, true);
  const oversized = await getWorkspaceSync(owner, "x".repeat(257));
  assert.equal(oversized.resetRequired, true);

  await database
    .prepare("DELETE FROM workspace_change_events WHERE audience_user_id = ?")
    .bind(owner.id)
    .run();
  const fullyPruned = await getWorkspaceSync(owner, initial.syncCursor!);
  assert.equal(fullyPruned.resetRequired, true);
});

test("an internal cursor gap cannot be skipped by a later event", async () => {
  const owner = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "sync-internal-gap-owner",
    email: "sync-internal-gap-owner@example.test",
  });
  const initial = await getSnapshot(owner);
  await createTask(owner, { title: "Internal gap one" });
  await createTask(owner, { title: "Internal gap two" });
  await createTask(owner, { title: "Internal gap three" });
  await database
    .prepare(
      "DELETE FROM workspace_change_events WHERE audience_user_id = ? AND sequence = 2",
    )
    .bind(owner.id)
    .run();

  const response = await getWorkspaceSync(owner, initial.syncCursor!);
  assert.equal(response.resetRequired, true);
});

test("sync retry backoff is bounded and starts at the polling interval", () => {
  assert.equal(workspaceSyncRetryDelay(0), 60_000);
  assert.equal(workspaceSyncRetryDelay(1), 120_000);
  assert.equal(workspaceSyncRetryDelay(20), 300_000);
});

test("task patches preserve loaded detail while accepting a newer summary timestamp", () => {
  const task = baseSnapshot().tasks[0]!;
  const current: AppSnapshot = {
    ...baseSnapshot(),
    tasks: [{ ...task, description: "Loaded body", commentCount: 0 }],
  };
  const response = emptySyncResponse({
    tasks: {
      upsert: [{
        ...task,
        description: null,
        commentCount: 1,
        updatedAt: "2026-08-16T09:31:00.000Z",
      }],
      remove: [],
    },
  });

  const next = applyWorkspaceSync(current, response);
  assert.equal(next.tasks[0]?.description, "Loaded body");
  assert.equal(next.tasks[0]?.commentCount, 1);
});

function emptySyncResponse(
  changes: Partial<WorkspaceSyncResponse["changes"]> = {},
): WorkspaceSyncResponse {
  return {
    cursor: "sync-v1:test",
    resetRequired: false,
    hasMore: false,
    changes: {
      tasks: { upsert: [], remove: [] },
      projects: { upsert: [], remove: [] },
      releases: { upsert: [], remove: [] },
      views: { upsert: [], remove: [] },
      labels: [],
      taskLabels: [],
      relations: [],
      ...changes,
    },
  };
}

function baseSnapshot(): AppSnapshot {
  const now = "2026-08-16T09:30:00.000Z";
  return {
    user: {
      id: "user-1",
      displayName: "Test User",
      email: "test@example.test",
      timezone: "UTC",
    },
    isAdmin: false,
    admin: null,
    users: [],
    statuses: [{
      id: "todo",
      ownerUserId: "user-1",
      name: "Todo",
      category: "unstarted",
      color: "#888888",
      position: 0,
      isDefault: true,
    }],
    projects: [],
    releases: [],
    tasks: [{
      id: "task-1",
      publicId: "33333333-3333-4333-8333-333333333333",
      ownerUserId: "user-1",
      creatorUserId: "user-1",
      identifier: "TM-1",
      sequenceNumber: 1,
      title: "Direct task",
      description: null,
      statusId: "todo",
      priority: "none",
      assigneeUserId: null,
      projectId: null,
      releaseId: null,
      estimate: null,
      dueDate: null,
      parentTaskId: null,
      rank: 1_000,
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
    }],
    labels: [],
    taskLabels: [],
    relations: [],
    views: [],
    collaborators: [],
    syncCursor: "sync-v1:initial",
  };
}
