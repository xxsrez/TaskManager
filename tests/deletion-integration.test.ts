import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createAttachment } from "../lib/attachments";
import { configureActorResolverForTests } from "../lib/auth";
import {
  deleteEntity,
  listRecentlyDeleted,
  PERMANENT_DELETE_CONFIRMATION,
  purgeEntity,
  purgeExpiredDeletedEntities,
  restoreEntity,
} from "../lib/deletion";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from "../lib/domain";
import {
  createProject,
  createRelease,
  createSavedView,
  createTask,
  getAdminOverview,
  getOrCreateUser,
  getSnapshot,
  getTask,
  grantAccess,
  queryTaskSummaries,
  updateTask,
} from "../lib/repository";
import { configureRuntimeEnvironment } from "../lib/runtime-environment";
import { getWorkspaceSync } from "../lib/workspace-sync";
import type { UserRecord } from "../lib/types";
import { createD1TestHarness } from "./helpers/d1";
import { GET as recentlyDeletedRoute } from "../app/api/recently-deleted/route";
import { DELETE as deleteTaskRoute } from "../app/api/tasks/[id]/route";
import { POST as purgeTaskRoute } from "../app/api/tasks/[id]/purge/route";
import { POST as restoreTaskRoute } from "../app/api/tasks/[id]/restore/route";

const ownerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "deletion-owner",
  displayName: "Deletion Owner",
  email: "deletion-owner@example.test",
};

let database: D1Database;
let bucket: R2Bucket;
let dispose: (() => Promise<void>) | undefined;
let owner: UserRecord;
let unique = 0;

before(async () => {
  const harness = await createD1TestHarness({
    TASK_MANAGER_ATTACHMENT_SCOPE: "deletion-test",
    TASK_MANAGER_ATTACHMENT_MAX_BYTES: "4096",
    TASK_MANAGER_ATTACHMENT_MAX_COUNT: "10",
  }, { r2: true });
  database = harness.database;
  bucket = harness.attachmentBucket!;
  dispose = harness.dispose;
  owner = await getOrCreateUser(ownerActor);
});

after(async () => {
  configureActorResolverForTests(null);
  await dispose?.();
});

async function fixture(label: string) {
  unique += 1;
  const suffix = `${label}-${unique}`;
  await createProject(owner, {
    name: `Deletion ${suffix}`,
    taskCode: `D${unique}`,
  });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === `Deletion ${suffix}`,
  )!;
  const release = await createRelease(owner, {
    name: `Release ${suffix}`,
    projectId: project.id,
  });
  const taskIdentity = await createTask(owner, {
    title: `Task ${suffix}`,
    projectId: project.id,
    releaseId: release.id,
  });
  const task = await getTask(owner, taskIdentity.id);
  const view = await createSavedView(owner, {
    name: `View ${suffix}`,
    scopeProjectId: project.id,
    query: { releaseId: release.id },
  });
  return { project, release, task, view };
}

test("all four entities delete, disappear, enter Recently Deleted, and restore losslessly", async () => {
  const { project, release, task, view } = await fixture("lifecycle");
  const baseline = await getSnapshot(owner);

  const deletedTask = await deleteEntity(owner, "task", task.id, task.version);
  assert.equal((await getSnapshot(owner)).tasks.some((item) => item.id === task.id), false);
  assert.equal((await listRecentlyDeleted(owner)).items.some(
    (item) => item.type === "task" && item.id === task.id,
  ), true);
  await assert.rejects(getTask(owner, task.id), NotFoundError);
  assert.deepEqual(
    await deleteEntity(owner, "task", task.publicId, task.version),
    deletedTask,
  );
  const taskDeleteSync = await getWorkspaceSync(owner, baseline.syncCursor!);
  assert.equal(taskDeleteSync.resetRequired, false);
  assert.equal(taskDeleteSync.changes.tasks.remove.includes(task.id), true);
  const restoredTask = await restoreEntity(
    owner,
    "task",
    task.publicId,
    deletedTask.version,
  );
  assert.deepEqual(
    await restoreEntity(owner, "task", task.id, deletedTask.version),
    restoredTask,
  );
  const taskRestoreSync = await getWorkspaceSync(owner, taskDeleteSync.cursor);
  assert.equal(taskRestoreSync.changes.tasks.upsert.some((item) => item.id === task.id), true);
  assert.equal((await getTask(owner, task.id)).releaseId, release.id);

  const deletedRelease = await deleteEntity(owner, "release", release.id, release.version);
  assert.equal((await getSnapshot(owner)).releases.some((item) => item.id === release.id), false);
  assert.equal((await getTask(owner, task.id)).releaseId, null);
  assert.equal((await database.prepare(
    "SELECT release_id FROM tasks WHERE id = ?",
  ).bind(task.id).first<{ release_id: string }>())?.release_id, release.id);
  await restoreEntity(owner, "release", release.id, deletedRelease.version);
  assert.equal((await getTask(owner, task.id)).releaseId, release.id);

  const taskCount = (await getSnapshot(owner)).tasks.length;
  const deletedView = await deleteEntity(owner, "saved_view", view.id, view.version);
  assert.equal((await getSnapshot(owner)).views.some((item) => item.id === view.id), false);
  assert.equal((await getSnapshot(owner)).tasks.length, taskCount);
  await restoreEntity(owner, "saved_view", view.id, deletedView.version);

  const projectCollaborator = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "deletion-project-sync-collaborator",
    displayName: "Deletion Project Sync Collaborator",
    email: "deletion-project-sync-collaborator@example.test",
  });
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: projectCollaborator.email,
    permission: "viewer",
  });
  const beforeProjectDelete = await getSnapshot(owner);
  const collaboratorBeforeProjectDelete = await getSnapshot(projectCollaborator);
  const deletedProject = await deleteEntity(owner, "project", project.id, project.version);
  const shadowed = await getSnapshot(owner);
  assert.equal(shadowed.projects.some((item) => item.id === project.id), false);
  assert.equal(shadowed.tasks.some((item) => item.id === task.id), false);
  assert.equal(shadowed.releases.some((item) => item.id === release.id), false);
  assert.equal(shadowed.views.some((item) => item.id === view.id), false);
  const recent = await listRecentlyDeleted(owner);
  assert.equal(recent.items.some((item) => item.id === project.id), true);
  assert.equal(recent.items.some((item) => item.id === task.id), false);
  assert.equal((await getWorkspaceSync(owner, beforeProjectDelete.syncCursor!)).resetRequired, true);
  assert.equal(
    (await getWorkspaceSync(
      projectCollaborator,
      collaboratorBeforeProjectDelete.syncCursor!,
    )).resetRequired,
    true,
  );
  await restoreEntity(owner, "project", project.publicId, deletedProject.version);
  const restored = await getSnapshot(owner);
  assert.equal(restored.tasks.some((item) => item.id === task.id), true);
  assert.equal(restored.releases.some((item) => item.id === release.id), true);
  assert.equal(restored.views.some((item) => item.id === view.id), true);

  const restoredView = restored.views.find((item) => item.id === view.id)!;
  const deletedRestoredView = await deleteEntity(
    owner,
    "saved_view",
    view.id,
    restoredView.version,
  );
  await purgeEntity(
    owner,
    "saved_view",
    view.id,
    deletedRestoredView.version,
    PERMANENT_DELETE_CONFIRMATION,
  );
  assert.equal(await database.prepare(
    "SELECT id FROM saved_views WHERE id = ?",
  ).bind(view.id).first(), null);
  assert.equal((await getTask(owner, task.id)).id, task.id);

  const activity = await database.prepare(
    `SELECT event_type FROM activity_events WHERE task_id = ?
     AND event_type IN ('task_deleted', 'task_delete_restored')
     ORDER BY created_at, id`,
  ).bind(task.id).all<{ event_type: string }>();
  assert.deepEqual(new Set(activity.results.map((row) => row.event_type)), new Set([
    "task_deleted",
    "task_delete_restored",
  ]));
});

test("ACL hides existence, Editors recover, and only the Owner can confirm idempotent purge", async () => {
  const editor = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "deletion-editor",
    displayName: "Deletion Editor",
    email: "deletion-editor@example.test",
  });
  const viewer = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "deletion-viewer",
    displayName: "Deletion Viewer",
    email: "deletion-viewer@example.test",
  });
  const outsider = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: "deletion-outsider",
    displayName: "Deletion Outsider",
    email: "deletion-outsider@example.test",
  });
  const { project, task } = await fixture("acl");
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: editor.email,
    permission: "editor",
  });
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: viewer.email,
    permission: "viewer",
  });

  const deleted = await deleteEntity(editor, "task", task.id, task.version);
  assert.equal((await listRecentlyDeleted(editor)).items[0]?.actions.canRestore, true);
  assert.equal((await listRecentlyDeleted(viewer)).items[0]?.actions.canRestore, false);
  assert.equal((await listRecentlyDeleted(outsider)).items.some((item) => item.id === task.id), false);
  await assert.rejects(
    restoreEntity(viewer, "task", task.id, deleted.version),
    PermissionError,
  );
  await assert.rejects(
    restoreEntity(outsider, "task", task.id, deleted.version),
    NotFoundError,
  );
  await assert.rejects(
    purgeEntity(editor, "task", task.id, deleted.version, PERMANENT_DELETE_CONFIRMATION),
    PermissionError,
  );
  await assert.rejects(
    purgeEntity(owner, "task", task.id, deleted.version, "delete"),
    ValidationError,
  );
  const purged = await purgeEntity(
    owner,
    "task",
    task.id,
    deleted.version,
    PERMANENT_DELETE_CONFIRMATION,
  );
  assert.deepEqual(
    await purgeEntity(
      owner,
      "task",
      task.publicId,
      deleted.version,
      PERMANENT_DELETE_CONFIRMATION,
    ),
    purged,
  );
  await assert.rejects(
    purgeEntity(
      outsider,
      "task",
      task.publicId,
      deleted.version,
      PERMANENT_DELETE_CONFIRMATION,
    ),
    NotFoundError,
  );
});

test("deleted Release references are neutral and inert until restore, then cleared only by purge", async () => {
  const { release, task, view } = await fixture("release-ref");
  const deleted = await deleteEntity(owner, "release", release.id, release.version);
  const queryWhileDeleted = await queryTaskSummaries(owner, {
    surface: `view:${view.id}`,
    query: view.query,
  });
  assert.deepEqual(queryWhileDeleted.taskIds, []);
  const storedView = await database.prepare(
    "SELECT query_json FROM saved_views WHERE id = ?",
  ).bind(view.id).first<{ query_json: string }>();
  assert.match(storedView!.query_json, new RegExp(release.id));
  assert.equal(JSON.stringify(queryWhileDeleted).includes(release.name), false);
  const editedWhileReleaseDeleted = await updateTask(owner, task.id, {
    version: (await getTask(owner, task.id)).version,
    title: `${task.title} edited while Release is deleted`,
  });
  assert.equal(editedWhileReleaseDeleted.releaseId, null);
  assert.equal((await database.prepare(
    "SELECT release_id FROM tasks WHERE id = ?",
  ).bind(task.id).first<{ release_id: string }>())?.release_id, release.id);

  await restoreEntity(owner, "release", release.id, deleted.version);
  assert.deepEqual((await queryTaskSummaries(owner, {
    surface: `view:${view.id}`,
    query: view.query,
  })).taskIds, [task.id]);
  const liveRelease = (await getSnapshot(owner)).releases.find((item) => item.id === release.id)!;
  const deletedAgain = await deleteEntity(owner, "release", release.id, liveRelease.version);
  await purgeEntity(
    owner,
    "release",
    release.id,
    deletedAgain.version,
    PERMANENT_DELETE_CONFIRMATION,
  );
  assert.equal((await database.prepare(
    "SELECT release_id FROM tasks WHERE id = ?",
  ).bind(task.id).first<{ release_id: string | null }>())?.release_id, null);
  assert.match((await database.prepare(
    "SELECT query_json FROM saved_views WHERE id = ?",
  ).bind(view.id).first<{ query_json: string }>())!.query_json, new RegExp(release.id));
  assert.equal((await getTask(owner, task.id)).id, task.id);
});

test("retention boundary is exact and admin metrics exclude a deleted Project subtree", async () => {
  const { project, task } = await fixture("retention");
  const before = (await getAdminOverview(owner, owner.email)).users.find(
    (item) => item.id === owner.id,
  )!;
  const deletedAt = new Date("2026-08-01T12:00:00.000Z");
  const deletedTask = await deleteEntity(owner, "task", task.id, task.version, deletedAt);
  const justBeforeBoundary = new Date("2026-08-31T11:59:59.999Z");
  const beforeBoundaryMaintenance = await purgeExpiredDeletedEntities(justBeforeBoundary);
  assert.equal(beforeBoundaryMaintenance.purged, 0);
  assert.ok(await database.prepare("SELECT id FROM tasks WHERE id = ?").bind(task.id).first());
  const boundary = new Date("2026-08-31T12:00:00.000Z");
  await assert.rejects(
    restoreEntity(owner, "task", task.id, deletedTask.version, boundary),
    ConflictError,
  );
  const maintenance = await purgeExpiredDeletedEntities(boundary);
  assert.equal(maintenance.purged >= 1, true);
  assert.equal(await database.prepare("SELECT id FROM tasks WHERE id = ?").bind(task.id).first(), null);

  const currentProject = (await getSnapshot(owner)).projects.find((item) => item.id === project.id)!;
  await deleteEntity(owner, "project", project.id, currentProject.version);
  const after = (await getAdminOverview(owner, owner.email)).users.find(
    (item) => item.id === owner.id,
  )!;
  assert.equal(after.projectCount, before.projectCount - 1);
  assert.equal(after.releaseCount <= before.releaseCount - 1, true);
  assert.equal(after.viewCount <= before.viewCount - 1, true);
});

test("HTTP lifecycle routes enforce CAS and Recently Deleted type pagination", async () => {
  const { task } = await fixture("routes");
  const second = await fixture("routes-page");
  configureActorResolverForTests(async () => ownerActor);
  const context = { params: Promise.resolve({ id: task.publicId }) };
  const stale = await deleteTaskRoute(new Request("https://task-manager.test/api/tasks/x", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: task.version + 1 }),
  }), context);
  assert.equal(stale.status, 409);

  const deletedResponse = await deleteTaskRoute(new Request("https://task-manager.test/api/tasks/x", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: task.version }),
  }), context);
  assert.equal(deletedResponse.status, 200);
  const deleted = (await deletedResponse.json()) as { entity: { version: number } };
  await deleteEntity(owner, "task", second.task.id, second.task.version);

  const firstPageResponse = await recentlyDeletedRoute(new Request(
    "https://task-manager.test/api/recently-deleted?type=task&limit=1",
  ));
  assert.equal(firstPageResponse.status, 200);
  const firstPage = (await firstPageResponse.json()) as Awaited<ReturnType<typeof listRecentlyDeleted>>;
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.items[0]?.type, "task");
  assert.ok(firstPage.page.nextCursor);
  const secondPage = await listRecentlyDeleted(owner, {
    type: "task",
    limit: 1,
    cursor: firstPage.page.nextCursor,
  });
  assert.equal(secondPage.items[0]?.type, "task");
  await assert.rejects(
    listRecentlyDeleted(owner, {
      type: "project",
      cursor: firstPage.page.nextCursor,
    }),
    ValidationError,
  );

  const restoredResponse = await restoreTaskRoute(new Request(
    "https://task-manager.test/api/tasks/x/restore",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: deleted.entity.version }),
    },
  ), context);
  assert.equal(restoredResponse.status, 200);
  const restored = (await restoredResponse.json()) as { entity: { version: number } };
  const deletedAgain = await deleteEntity(owner, "task", task.id, restored.entity.version);
  const purgeResponse = await purgeTaskRoute(new Request(
    "https://task-manager.test/api/tasks/x/purge",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: deletedAgain.version,
        confirmation: PERMANENT_DELETE_CONFIRMATION,
      }),
    },
  ), context);
  assert.equal(purgeResponse.status, 200);
  assert.deepEqual(await purgeResponse.json(), {
    type: "task",
    id: task.id,
    purged: true,
  });
  configureActorResolverForTests(null);
});

test("R2 cleanup failure and D1 rollback leave an irreversible retryable purge claim", async () => {
  const { task } = await fixture("r2-retry");
  const attachment = await createAttachment(owner, task.id, {
    body: new TextEncoder().encode("%PDF-1.7\nrecoverable purge\n%%EOF"),
    filename: "purge.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: `purge-${unique}`,
  });
  const deleted = await deleteEntity(owner, "task", task.id, task.version);
  const failingBucket = new Proxy(bucket, {
    get(target, property) {
      if (property === "delete") {
        return async () => { throw new Error("synthetic R2 delete failure"); };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  configureRuntimeEnvironment({ DB: database, ATTACHMENTS: failingBucket });
  await assert.rejects(
    purgeEntity(owner, "task", task.id, deleted.version, PERMANENT_DELETE_CONFIRMATION),
    /synthetic R2 delete failure/,
  );
  assert.ok(await database.prepare("SELECT id FROM tasks WHERE id = ?").bind(task.id).first());
  await assert.rejects(
    restoreEntity(owner, "task", task.id, deleted.version),
    /permanent deletion has started/,
  );

  configureRuntimeEnvironment({ DB: database, ATTACHMENTS: bucket });
  await database.prepare(
    `CREATE TRIGGER synthetic_task_purge_failure BEFORE DELETE ON tasks
     WHEN OLD.id = '${task.id}' BEGIN SELECT RAISE(ABORT, 'synthetic D1 rollback'); END`,
  ).run();
  await assert.rejects(
    purgeEntity(owner, "task", task.id, deleted.version, PERMANENT_DELETE_CONFIRMATION),
    /synthetic D1 rollback/,
  );
  assert.ok(await database.prepare("SELECT id FROM tasks WHERE id = ?").bind(task.id).first());
  assert.ok(await database.prepare("SELECT id FROM attachments WHERE id = ?").bind(attachment.id).first());
  await database.prepare("DROP TRIGGER synthetic_task_purge_failure").run();
  await purgeEntity(owner, "task", task.id, deleted.version, PERMANENT_DELETE_CONFIRMATION);
  assert.equal(await database.prepare("SELECT id FROM tasks WHERE id = ?").bind(task.id).first(), null);
  assert.equal(await bucket.head(attachment.objectKey), null);
  const receipt = await database.prepare(
    `SELECT completed_at, receipt_expires_at FROM entity_purge_jobs
     WHERE entity_type = 'task' AND entity_id = ?`,
  ).bind(task.id).first<{ completed_at: string; receipt_expires_at: string }>();
  assert.ok(receipt?.completed_at);
  assert.ok(receipt?.receipt_expires_at);
});
