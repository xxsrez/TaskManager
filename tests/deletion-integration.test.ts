import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createAttachment,
  listTaskAttachments,
} from "../lib/attachments";
import { listTaskActivity } from "../lib/activity";
import { configureActorResolverForTests } from "../lib/auth";
import { createComment, listTaskComments } from "../lib/comments";
import {
  deleteEntity,
  getDeletionPreview,
  getProjectDeletionPreview,
  getReleaseDeletionPreview,
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
  bulkMoveTasks,
  bulkUpdateTasks,
  getAdminOverview,
  getOrCreateUser,
  getSnapshot,
  getTask,
  getTaskDetail,
  grantAccess,
  moveTask,
  queryTaskSummaries,
  reorderTask,
  revokeAccess,
  setTaskParent,
  updateRelease,
  updateSavedView,
  updateTask,
} from "../lib/repository";
import { configureRuntimeEnvironment } from "../lib/runtime-environment";
import { getWorkspaceSync } from "../lib/workspace-sync";
import type { UserRecord } from "../lib/types";
import { createD1TestHarness } from "./helpers/d1";
import { GET as recentlyDeletedRoute } from "../app/api/recently-deleted/route";
import { GET as deletionPreviewRoute } from "../app/api/recently-deleted/[type]/[id]/preview/route";
import { GET as releaseDeletionPreviewRoute } from "../app/api/releases/[id]/deletion-preview/route";
import { GET as projectDeletionPreviewRoute } from "../app/api/projects/[id]/deletion-preview/route";
import { DELETE as deleteReleaseRoute } from "../app/api/releases/[id]/route";
import { DELETE as deleteTaskRoute } from "../app/api/tasks/[id]/route";
import { POST as purgeTaskRoute } from "../app/api/tasks/[id]/purge/route";
import { POST as restoreTaskRoute } from "../app/api/tasks/[id]/restore/route";
import { createTaskRelation } from "../lib/task-relations";

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
    getDeletionPreview(editor, "task", task.id, deleted.version),
    PermissionError,
  );
  await assert.rejects(
    getDeletionPreview(viewer, "task", task.id, deleted.version),
    PermissionError,
  );
  await assert.rejects(
    getDeletionPreview(owner, "task", task.id, deleted.version + 1),
    ConflictError,
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

test("owner-only permanent preview returns authoritative cascade and membership counts", async () => {
  const { project, release, task, view } = await fixture("preview");
  await createComment(owner, task.id, {
    body: "Preview comment",
    idempotencyKey: `preview-comment-${unique}`,
  });
  await createAttachment(owner, task.id, {
    body: new TextEncoder().encode("%PDF-1.7\npreview\n%%EOF"),
    filename: "preview.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: `preview-file-${unique}`,
  });
  const deletedProject = await deleteEntity(owner, "project", project.id, project.version);
  const projectPreview = await getDeletionPreview(
    owner,
    "project",
    project.id,
    deletedProject.version,
  );
  assert.deepEqual(projectPreview.impact, {
    tasks: 1,
    releases: 1,
    savedViews: 1,
    comments: 1,
    attachments: 1,
    releaseMemberships: 0,
  });
  assert.equal(projectPreview.displayName, project.name);
  assert.equal(projectPreview.confirmation, PERMANENT_DELETE_CONFIRMATION);

  configureActorResolverForTests(async () => ownerActor);
  const response = await deletionPreviewRoute(new Request(
    `https://task-manager.test/api/recently-deleted/project/${project.publicId}/preview?version=${deletedProject.version}`,
  ), { params: Promise.resolve({ type: "project", id: project.publicId }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { impact: unknown }).impact, projectPreview.impact);
  const staleResponse = await deletionPreviewRoute(new Request(
    `https://task-manager.test/api/recently-deleted/project/${project.publicId}/preview?version=${deletedProject.version + 1}`,
  ), { params: Promise.resolve({ type: "project", id: project.publicId }) });
  assert.equal(staleResponse.status, 409);
  const invalidTypeResponse = await deletionPreviewRoute(new Request(
    `https://task-manager.test/api/recently-deleted/unknown/${project.publicId}/preview?version=${deletedProject.version}`,
  ), { params: Promise.resolve({ type: "unknown", id: project.publicId }) });
  assert.equal(invalidTypeResponse.status, 400);
  const invalidVersionResponse = await deletionPreviewRoute(new Request(
    `https://task-manager.test/api/recently-deleted/project/${project.publicId}/preview?version=0`,
  ), { params: Promise.resolve({ type: "project", id: project.publicId }) });
  assert.equal(invalidVersionResponse.status, 400);
  configureActorResolverForTests(null);

  await restoreEntity(owner, "project", project.id, deletedProject.version);
  const currentRelease = (await getSnapshot(owner)).releases.find((item) => item.id === release.id)!;
  const deletedRelease = await deleteEntity(owner, "release", release.id, currentRelease.version);
  const releasePreview = await getDeletionPreview(
    owner,
    "release",
    release.id,
    deletedRelease.version,
  );
  assert.equal(releasePreview.impact.releaseMemberships, 1);
  assert.equal(releasePreview.context, project.name);
  assert.equal(view.scopeProjectId, project.id);
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
  const searched = await listRecentlyDeleted(owner, {
    type: "task",
    search: second.task.title,
  });
  assert.deepEqual(searched.items.map((item) => item.id), [second.task.id]);
  await assert.rejects(
    listRecentlyDeleted(owner, {
      type: "task",
      search: "different search",
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
  const secondAttachment = await createAttachment(owner, task.id, {
    body: new TextEncoder().encode("%PDF-1.7\nsecond recoverable purge\n%%EOF"),
    filename: "purge-second.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: `purge-second-${unique}`,
  });
  const deleted = await deleteEntity(owner, "task", task.id, task.version);
  let deleteCalls = 0;
  const failingBucket = new Proxy(bucket, {
    get(target, property) {
      if (property === "delete") {
        return async (keys: string | string[]) => {
          deleteCalls += 1;
          if (deleteCalls === 1) {
            await target.delete(keys);
            return;
          }
          throw new Error("synthetic R2 delete failure after one object");
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  configureRuntimeEnvironment({ DB: database, ATTACHMENTS: failingBucket });
  await assert.rejects(
    purgeEntity(owner, "task", task.id, deleted.version, PERMANENT_DELETE_CONFIRMATION),
    /synthetic R2 delete failure after one object/,
  );
  assert.ok(await database.prepare("SELECT id FROM tasks WHERE id = ?").bind(task.id).first());
  const firstObjectAfterFailure = await bucket.head(attachment.objectKey);
  const secondObjectAfterFailure = await bucket.head(secondAttachment.objectKey);
  assert.notEqual(Boolean(firstObjectAfterFailure), Boolean(secondObjectAfterFailure));
  assert.equal((await database.prepare(
    `SELECT attempt_count FROM entity_purge_jobs
     WHERE entity_type = 'task' AND entity_id = ?`,
  ).bind(task.id).first<{ attempt_count: number }>())!.attempt_count, 1);
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
  assert.ok(await database.prepare("SELECT id FROM attachments WHERE id = ?").bind(secondAttachment.id).first());
  await database.prepare("DROP TRIGGER synthetic_task_purge_failure").run();
  await purgeEntity(owner, "task", task.id, deleted.version, PERMANENT_DELETE_CONFIRMATION);
  assert.equal(await database.prepare("SELECT id FROM tasks WHERE id = ?").bind(task.id).first(), null);
  assert.equal(await bucket.head(attachment.objectKey), null);
  assert.equal(await bucket.head(secondAttachment.objectKey), null);
  const receipt = await database.prepare(
    `SELECT completed_at, receipt_expires_at FROM entity_purge_jobs
     WHERE entity_type = 'task' AND entity_id = ?`,
  ).bind(task.id).first<{ completed_at: string; receipt_expires_at: string }>();
  assert.ok(receipt?.completed_at);
  assert.ok(receipt?.receipt_expires_at);
});

test("Task delete and restore preserve content while child hierarchy and relation caches converge", async () => {
  const { project, task: originalTask } = await fixture("task-lossless");
  const peerIdentity = await createTask(owner, {
    title: `Peer ${unique}`,
    projectId: project.id,
  });
  const replacementIdentity = await createTask(owner, {
    title: `Replacement parent ${unique}`,
    projectId: project.id,
  });
  const firstChildIdentity = await createTask(owner, {
    title: `Detach child ${unique}`,
    projectId: project.id,
  });
  const secondChildIdentity = await createTask(owner, {
    title: `Reparent child ${unique}`,
    projectId: project.id,
  });
  const retainedChildIdentity = await createTask(owner, {
    title: `Retained child ${unique}`,
    projectId: project.id,
  });
  const task = await updateTask(owner, originalTask.id, {
    version: originalTask.version,
    title: `Lossless parent ${unique}`,
    description: "Description retained across recoverable deletion",
  });
  const firstChild = await setTaskParent(owner, firstChildIdentity.id, {
    version: (await getTask(owner, firstChildIdentity.id)).version,
    parentTaskId: task.id,
  });
  const secondChild = await setTaskParent(owner, secondChildIdentity.id, {
    version: (await getTask(owner, secondChildIdentity.id)).version,
    parentTaskId: task.id,
  });
  const retainedChild = await setTaskParent(owner, retainedChildIdentity.id, {
    version: (await getTask(owner, retainedChildIdentity.id)).version,
    parentTaskId: task.id,
  });
  const peer = await getTask(owner, peerIdentity.id);
  await createTaskRelation(owner, task.id, {
    targetTaskId: peer.id,
    type: "related",
    direction: "outgoing",
    idempotencyKey: `delete-relation-${unique}`,
  });
  await createComment(owner, task.id, {
    body: "Comment retained across recoverable deletion",
    idempotencyKey: `delete-comment-${unique}`,
  });
  const firstAttachment = await createAttachment(owner, task.id, {
    body: new TextEncoder().encode("%PDF-1.7\nfirst retained file\n%%EOF"),
    filename: "first-retained.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: `delete-attachment-a-${unique}`,
  });
  const secondAttachment = await createAttachment(owner, task.id, {
    body: new TextEncoder().encode("second retained file"),
    filename: "second-retained.txt",
    claimedMediaType: "text/plain",
    idempotencyKey: `delete-attachment-b-${unique}`,
  });
  const beforeDelete = await getSnapshot(owner);
  const currentTask = await getTask(owner, task.id);
  const deleted = await deleteEntity(owner, "task", task.id, currentTask.version);

  const firstHiddenParent = await getTask(owner, firstChild.id);
  const secondHiddenParent = await getTask(owner, secondChild.id);
  const retainedHiddenParent = await getTask(owner, retainedChild.id);
  assert.equal(firstHiddenParent.parentTaskId, null);
  assert.equal(secondHiddenParent.parentTaskId, null);
  assert.equal(retainedHiddenParent.parentTaskId, null);
  assert.equal(firstHiddenParent.version, firstChild.version);
  assert.equal(secondHiddenParent.version, secondChild.version);
  assert.equal(retainedHiddenParent.version, retainedChild.version);
  const deleteSync = await getWorkspaceSync(owner, beforeDelete.syncCursor!);
  assert.equal(deleteSync.changes.tasks.remove.includes(task.id), true);
  assert.deepEqual(
    new Set(deleteSync.changes.tasks.upsert.map((item) => item.id)),
    new Set([firstChild.id, secondChild.id, retainedChild.id]),
  );
  assert.equal(deleteSync.changes.invalidations.taskDetails.includes(firstChild.id), true);
  assert.equal(deleteSync.changes.invalidations.taskDetails.includes(secondChild.id), true);
  assert.equal(deleteSync.changes.invalidations.taskDetails.includes(retainedChild.id), true);
  assert.equal(deleteSync.changes.invalidations.taskDetails.includes(peer.id), true);

  const detached = await setTaskParent(owner, firstChild.id, {
    version: firstHiddenParent.version,
    parentTaskId: null,
  });
  const reparented = await setTaskParent(owner, secondChild.id, {
    version: secondHiddenParent.version,
    parentTaskId: replacementIdentity.id,
  });
  assert.equal(detached.parentTaskId, null);
  assert.equal(reparented.parentTaskId, replacementIdentity.id);
  const detachedHierarchyEvent = (await listTaskActivity(owner, firstChild.id, { limit: 20 }))
    .events.find((event) => {
      if (event.eventType !== "hierarchy_changed") return false;
      const changes = event.payload.changes as Record<string, unknown> | undefined;
      const parentChange = changes?.parentTaskId as Record<string, unknown> | undefined;
      return parentChange?.after === null;
    });
  const detachedChanges = detachedHierarchyEvent?.payload.changes as
    | Record<string, unknown>
    | undefined;
  const detachedParentChange = detachedChanges?.parentTaskId as
    | Record<string, unknown>
    | undefined;
  assert.equal(detachedParentChange?.before, null);

  const beforeRestore = await getSnapshot(owner);
  await restoreEntity(owner, "task", task.id, deleted.version);
  const restoreSync = await getWorkspaceSync(owner, beforeRestore.syncCursor!);
  assert.equal(
    restoreSync.changes.tasks.upsert.some((item) =>
      item.id === retainedChild.id && item.parentTaskId === task.id
    ),
    true,
  );
  assert.equal(restoreSync.changes.invalidations.taskDetails.includes(retainedChild.id), true);
  assert.equal(restoreSync.changes.invalidations.taskDetails.includes(peer.id), true);
  const restored = await getTask(owner, task.id);
  assert.equal(restored.identifier, task.identifier);
  assert.equal(restored.title, task.title);
  assert.equal(restored.description, task.description);
  assert.equal((await getTask(owner, firstChild.id)).parentTaskId, null);
  assert.equal((await getTask(owner, secondChild.id)).parentTaskId, replacementIdentity.id);
  assert.equal((await getTask(owner, retainedChild.id)).parentTaskId, task.id);
  assert.equal((await listTaskComments(owner, task.id)).totalCount, 1);
  assert.equal((await listTaskAttachments(owner, task.id)).totalCount, 2);
  assert.ok(await bucket.head(firstAttachment.objectKey));
  assert.ok(await bucket.head(secondAttachment.objectKey));
  const detail = await getTaskDetail(owner, task.id);
  assert.equal(detail.relations.length, 1);
  assert.equal(detail.relatedTasks.some((item) => item.id === peer.id), true);
  const eventTypes = new Set(
    (await listTaskActivity(owner, task.id, { limit: 50 })).events.map((event) => event.eventType),
  );
  assert.equal(eventTypes.has("task_deleted"), true);
  assert.equal(eventTypes.has("task_delete_restored"), true);
  assert.equal(eventTypes.has("relation_created"), true);
});

test("released Release delete is previewed and confirmed with CAS while membership stays lossless", async () => {
  const { project, release, task, view } = await fixture("released-delete");
  const archivedIdentity = await createTask(owner, {
    title: `Archived release member ${unique}`,
    projectId: project.id,
    releaseId: release.id,
  });
  const archivedTask = await updateTask(owner, archivedIdentity.id, {
    version: (await getTask(owner, archivedIdentity.id)).version,
    archived: true,
  });
  const comment = await createComment(owner, task.id, {
    body: "Release purge must not delete this comment",
    idempotencyKey: `release-comment-${unique}`,
  });
  const attachment = await createAttachment(owner, task.id, {
    body: new TextEncoder().encode("release attachment retained"),
    filename: "release-retained.txt",
    claimedMediaType: "text/plain",
    idempotencyKey: `release-attachment-${unique}`,
  });
  const released = await updateRelease(owner, release.id, {
    version: release.version,
    status: "released",
    confirmOpenTasks: true,
  });
  const releaseEditor = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: `release-preview-editor-${unique}`,
    displayName: "Release Preview Editor",
    email: `release-preview-editor-${unique}@example.test`,
  });
  const releaseViewer = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: `release-preview-viewer-${unique}`,
    displayName: "Release Preview Viewer",
    email: `release-preview-viewer-${unique}@example.test`,
  });
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: releaseEditor.email,
    permission: "editor",
  });
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: releaseViewer.email,
    permission: "viewer",
  });
  const preview = await getReleaseDeletionPreview(owner, release.publicId, released.version);
  assert.deepEqual(preview, {
    type: "release",
    id: release.id,
    publicId: release.publicId,
    displayName: release.name,
    context: project.name,
    version: released.version,
    status: "released",
    taskMemberships: 2,
    requiresReleasedCompositionConfirmation: true,
  });
  assert.equal(
    (await getReleaseDeletionPreview(releaseEditor, release.id, released.version)).taskMemberships,
    2,
  );
  await assert.rejects(
    getReleaseDeletionPreview(releaseViewer, release.id, released.version),
    PermissionError,
  );

  configureActorResolverForTests(async () => ownerActor);
  const previewResponse = await releaseDeletionPreviewRoute(new Request(
    `https://task-manager.test/api/releases/${release.publicId}/deletion-preview?version=${released.version}`,
  ), { params: Promise.resolve({ id: release.publicId }) });
  assert.equal(previewResponse.status, 200);
  assert.equal(
    (await previewResponse.json() as { taskMemberships: number }).taskMemberships,
    2,
  );
  const renamed = await updateRelease(owner, release.id, {
    version: released.version,
    name: `${release.name} authoritative`,
  });
  const staleDelete = await deleteReleaseRoute(new Request(
    "https://task-manager.test/api/releases/x",
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: released.version,
        confirmReleasedComposition: true,
      }),
    },
  ), { params: Promise.resolve({ id: release.publicId }) });
  assert.equal(staleDelete.status, 409);
  const unconfirmedDelete = await deleteReleaseRoute(new Request(
    "https://task-manager.test/api/releases/x",
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: renamed.version }),
    },
  ), { params: Promise.resolve({ id: release.publicId }) });
  assert.equal(unconfirmedDelete.status, 400);
  const deletedResponse = await deleteReleaseRoute(new Request(
    "https://task-manager.test/api/releases/x",
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: renamed.version,
        confirmReleasedComposition: true,
      }),
    },
  ), { params: Promise.resolve({ id: release.publicId }) });
  assert.equal(deletedResponse.status, 200);
  const deleted = await deletedResponse.json() as { entity: { version: number } };
  configureActorResolverForTests(null);

  const renamedView = await updateSavedView(owner, view.id, {
    version: view.version,
    name: `${view.name} renamed while Release deleted`,
  });
  assert.match(JSON.stringify(renamedView.query), new RegExp(release.id));
  const failingDatabase = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          if (
            query.includes("FROM releases r JOIN projects p ON p.id = r.project_id") &&
            query.includes("(r.id = ? OR r.public_id = ?)")
          ) {
            throw new Error("synthetic release lookup infrastructure failure");
          }
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as D1Database;
  configureRuntimeEnvironment({ DB: failingDatabase, ATTACHMENTS: bucket });
  await assert.rejects(
    updateSavedView(owner, view.id, {
      version: renamedView.version,
      name: `${renamedView.name} unavailable lookup`,
    }),
    /synthetic release lookup infrastructure failure/,
  );
  configureRuntimeEnvironment({ DB: database, ATTACHMENTS: bucket });
  await assert.rejects(
    updateSavedView(owner, view.id, {
      version: renamedView.version,
      query: { releaseId: "release-never-known" },
    }),
    ValidationError,
  );
  await createProject(owner, {
    name: `Release move target ${unique}`,
    taskCode: `RM${unique}`,
  });
  const targetProject = (await getSnapshot(owner)).projects.find(
    (item) => item.name === `Release move target ${unique}`,
  )!;
  await assert.rejects(
    updateSavedView(owner, view.id, {
      version: renamedView.version,
      scopeProjectId: targetProject.id,
    }),
    ValidationError,
  );
  await assert.rejects(
    createTask(owner, {
      title: "Cannot assign a deleted Release",
      projectId: project.id,
      releaseId: release.id,
    }),
    NotFoundError,
  );
  const unassignedIdentity = await createTask(owner, {
    title: `Unassigned while Release deleted ${unique}`,
    projectId: project.id,
  });
  const unassigned = await getTask(owner, unassignedIdentity.id);
  await assert.rejects(
    updateTask(owner, unassigned.id, {
      version: unassigned.version,
      releaseId: release.id,
    }),
    NotFoundError,
  );
  await assert.rejects(
    bulkUpdateTasks(owner, {
      ids: [unassigned.id],
      versions: { [unassigned.id]: unassigned.version },
      field: "releaseId",
      value: release.id,
    }),
    NotFoundError,
  );
  await assert.rejects(
    moveTask(owner, task.id, {
      version: (await getTask(owner, task.id)).version,
      targetProjectId: targetProject.id,
    }),
    /explicitly clear the current Release/,
  );

  await restoreEntity(owner, "release", release.id, deleted.entity.version);
  assert.equal((await getTask(owner, task.id)).releaseId, release.id);
  assert.equal((await getTask(owner, archivedTask.id)).releaseId, release.id);
  const liveRelease = (await getSnapshot(owner)).releases.find(
    (item) => item.id === release.id,
  )!;
  const deletedAgain = await deleteEntity(
    owner,
    "release",
    release.id,
    liveRelease.version,
    new Date(),
    { confirmReleasedComposition: true },
  );
  const taskVersionBeforePurge = (await database.prepare(
    "SELECT version FROM tasks WHERE id = ?",
  ).bind(task.id).first<{ version: number }>())!.version;
  await purgeEntity(
    owner,
    "release",
    release.id,
    deletedAgain.version,
    PERMANENT_DELETE_CONFIRMATION,
  );
  const taskAfterPurge = await getTask(owner, task.id);
  assert.equal(taskAfterPurge.releaseId, null);
  assert.equal(taskAfterPurge.version, taskVersionBeforePurge + 1);
  assert.ok(await database.prepare("SELECT id FROM comments WHERE id = ?").bind(comment.id).first());
  assert.ok(await database.prepare("SELECT id FROM attachments WHERE id = ?").bind(attachment.id).first());
  assert.ok(await bucket.head(attachment.objectKey));
  const storedQuery = await database.prepare(
    "SELECT query_json FROM saved_views WHERE id = ?",
  ).bind(view.id).first<{ query_json: string }>();
  assert.match(storedQuery!.query_json, new RegExp(release.id));
  const afterPurgeRename = await updateSavedView(owner, view.id, {
    version: renamedView.version,
    name: `${renamedView.name} after purge`,
  });
  assert.match(JSON.stringify(afterPurgeRename.query), new RegExp(release.id));
  const predicateRemoved = await updateSavedView(owner, view.id, {
    version: afterPurgeRename.version,
    query: {},
  });
  assert.equal(predicateRemoved.query.releaseId, undefined);
});

test("hidden released membership stays confirmation-protected and reorder preserves its stored ref", async () => {
  const { project, release, task } = await fixture("hidden-released-membership");
  const alternateRelease = await createRelease(owner, {
    name: `Alternate Release ${unique}`,
    projectId: project.id,
  });
  const members = new Map<string, Awaited<ReturnType<typeof getTask>>>();
  for (const title of [
    "Hidden update clear",
    "Hidden bulk clear",
    "Hidden move",
    "Hidden bulk move",
    "Hidden reorder preserve",
    "Hidden reorder change",
  ]) {
    const identity = await createTask(owner, {
      title: `${title} ${unique}`,
      projectId: project.id,
      releaseId: release.id,
    });
    members.set(title, await getTask(owner, identity.id));
  }
  const unassignedNeighborIdentity = await createTask(owner, {
    title: `Visible no-release neighbor ${unique}`,
    projectId: project.id,
  });
  const alternateNeighborIdentity = await createTask(owner, {
    title: `Alternate Release neighbor ${unique}`,
    projectId: project.id,
    releaseId: alternateRelease.id,
  });
  const unassignedNeighbor = await getTask(owner, unassignedNeighborIdentity.id);
  const alternateNeighbor = await getTask(owner, alternateNeighborIdentity.id);
  await createProject(owner, {
    name: `Hidden membership move target ${unique}`,
    taskCode: `HM${unique}`,
  });
  const targetProject = (await getSnapshot(owner)).projects.find(
    (item) => item.name === `Hidden membership move target ${unique}`,
  )!;

  const released = await updateRelease(owner, release.id, {
    version: release.version,
    status: "released",
    confirmOpenTasks: true,
  });
  const deleted = await deleteEntity(
    owner,
    "release",
    release.id,
    released.version,
    new Date(),
    { confirmReleasedComposition: true },
  );
  for (const member of [task, ...members.values()]) {
    assert.equal((await getTask(owner, member.id)).releaseId, null);
  }

  const updateMember = await getTask(owner, task.id);
  await assert.rejects(
    updateTask(owner, updateMember.id, {
      version: updateMember.version,
      releaseId: alternateRelease.id,
    }),
    /Confirm changing the composition of a released Release/,
  );
  const reassigned = await updateTask(owner, updateMember.id, {
    version: updateMember.version,
    releaseId: alternateRelease.id,
    confirmReleasedComposition: true,
  });
  assert.equal(reassigned.releaseId, alternateRelease.id);

  const updateClear = await getTask(owner, members.get("Hidden update clear")!.id);
  await assert.rejects(
    updateTask(owner, updateClear.id, {
      version: updateClear.version,
      releaseId: null,
    }),
    /Confirm changing the composition of a released Release/,
  );
  const updateCleared = await updateTask(owner, updateClear.id, {
    version: updateClear.version,
    releaseId: null,
    confirmReleasedComposition: true,
  });
  assert.equal(updateCleared.releaseId, null);
  assert.equal(
    (await database.prepare("SELECT release_id FROM tasks WHERE id = ?")
      .bind(updateCleared.id).first<{ release_id: string | null }>())!.release_id,
    null,
  );

  const bulkClear = await getTask(owner, members.get("Hidden bulk clear")!.id);
  const bulkClearInput = {
    ids: [bulkClear.id],
    versions: { [bulkClear.id]: bulkClear.version },
    field: "releaseId",
    value: null,
  };
  await assert.rejects(
    bulkUpdateTasks(owner, bulkClearInput),
    /Confirm changing the composition of a released Release/,
  );
  const [cleared] = await bulkUpdateTasks(owner, {
    ...bulkClearInput,
    confirmReleasedComposition: true,
  });
  assert.equal(cleared!.releaseId, null);
  assert.equal(
    (await database.prepare("SELECT release_id FROM tasks WHERE id = ?")
      .bind(cleared!.id).first<{ release_id: string | null }>())!.release_id,
    null,
  );

  const moveMember = await getTask(owner, members.get("Hidden move")!.id);
  const moveInput = {
    version: moveMember.version,
    targetProjectId: targetProject.id,
    releaseId: null,
  };
  await assert.rejects(
    moveTask(owner, moveMember.id, moveInput),
    /Confirm changing the composition of a released Release/,
  );
  const moved = await moveTask(owner, moveMember.id, {
    ...moveInput,
    confirmReleasedComposition: true,
  });
  assert.equal(moved.projectId, targetProject.id);
  assert.equal(moved.releaseId, null);

  const bulkMoveMember = await getTask(owner, members.get("Hidden bulk move")!.id);
  const bulkMoveInput = {
    ids: [bulkMoveMember.id],
    versions: { [bulkMoveMember.id]: bulkMoveMember.version },
    targetProjectId: targetProject.id,
    clearRelease: true,
  };
  await assert.rejects(
    bulkMoveTasks(owner, bulkMoveInput),
    /Confirm changing the composition of a released Release/,
  );
  const [bulkMoved] = await bulkMoveTasks(owner, {
    ...bulkMoveInput,
    confirmReleasedComposition: true,
  });
  assert.equal(bulkMoved!.projectId, targetProject.id);
  assert.equal(bulkMoved!.releaseId, null);

  const reorderChange = await getTask(owner, members.get("Hidden reorder change")!.id);
  const reorderChangeInput = {
    version: reorderChange.version,
    groupBy: "release",
    expectedGroupValue: null,
    targetGroupValue: alternateRelease.id,
    previousTaskId: alternateNeighbor.id,
    nextTaskId: null,
  };
  await assert.rejects(
    reorderTask(owner, reorderChange.id, reorderChangeInput),
    /Confirm changing the composition of a released Release/,
  );
  const reorderedToAlternate = await reorderTask(owner, reorderChange.id, {
    ...reorderChangeInput,
    confirmReleasedComposition: true,
  });
  assert.equal(reorderedToAlternate.releaseId, alternateRelease.id);

  const reorderPreserve = await getTask(
    owner,
    members.get("Hidden reorder preserve")!.id,
  );
  const reorderedWithinVisibleGroup = await reorderTask(owner, reorderPreserve.id, {
    version: reorderPreserve.version,
    groupBy: "release",
    expectedGroupValue: null,
    targetGroupValue: null,
    previousTaskId: unassignedNeighbor.id,
    nextTaskId: null,
  });
  assert.equal(reorderedWithinVisibleGroup.releaseId, null);
  assert.equal(reorderedWithinVisibleGroup.version, reorderPreserve.version + 1);
  assert.equal(
    (await database.prepare("SELECT release_id FROM tasks WHERE id = ?")
      .bind(reorderPreserve.id).first<{ release_id: string | null }>())!.release_id,
    release.id,
  );

  const updateActivity = (await listTaskActivity(owner, reassigned.id, { limit: 5 }))
    .events.find((event) => event.eventType === "task_updated");
  const reorderActivity = (
    await listTaskActivity(owner, reorderedToAlternate.id, { limit: 5 })
  ).events.find((event) => event.eventType === "task_updated");
  assert.equal(JSON.stringify(updateActivity?.payload).includes(release.id), false);
  assert.equal(JSON.stringify(reorderActivity?.payload).includes(release.id), false);

  await restoreEntity(owner, "release", release.id, deleted.version);
  assert.equal((await getTask(owner, reorderPreserve.id)).releaseId, release.id);
});

test("Project shadow restore preserves its whole subtree and purge removes R2 plus legacy grants", async () => {
  const editorActor = {
    ...ownerActor,
    providerAccountKey: `project-delete-editor-${unique}`,
    displayName: "Project Delete Editor",
    email: `project-delete-editor-${unique}@example.test`,
  };
  const managerActor = {
    ...ownerActor,
    providerAccountKey: `project-delete-manager-${unique}`,
    displayName: "Project Delete Manager",
    email: `project-delete-manager-${unique}@example.test`,
  };
  const viewerActor = {
    ...ownerActor,
    providerAccountKey: `project-delete-viewer-${unique}`,
    displayName: "Project Delete Viewer",
    email: `project-delete-viewer-${unique}@example.test`,
  };
  const revokedActor = {
    ...ownerActor,
    providerAccountKey: `project-delete-revoked-${unique}`,
    displayName: "Project Delete Revoked Editor",
    email: `project-delete-revoked-${unique}@example.test`,
  };
  const editor = await getOrCreateUser(editorActor);
  const manager = await getOrCreateUser(managerActor);
  const viewer = await getOrCreateUser(viewerActor);
  const revoked = await getOrCreateUser(revokedActor);
  const { project, release, task, view } = await fixture("project-complete");
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: manager.email,
    permission: "manager",
  });
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
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: revoked.email,
    permission: "editor",
  });
  const archivedIdentity = await createTask(owner, {
    title: `Archived project child ${unique}`,
    projectId: project.id,
  });
  const archivedTask = await updateTask(owner, archivedIdentity.id, {
    version: (await getTask(owner, archivedIdentity.id)).version,
    archived: true,
  });
  const deletedIdentity = await createTask(owner, {
    title: `Separately deleted project child ${unique}`,
    projectId: project.id,
  });
  const deletedChild = await getTask(owner, deletedIdentity.id);
  await createComment(owner, task.id, {
    body: "Project comment one",
    idempotencyKey: `project-comment-a-${unique}`,
  });
  await createComment(owner, deletedChild.id, {
    body: "Project comment two on separately deleted Task",
    idempotencyKey: `project-comment-b-${unique}`,
  });
  const firstAttachment = await createAttachment(owner, task.id, {
    body: new TextEncoder().encode("project object one"),
    filename: "project-one.txt",
    claimedMediaType: "text/plain",
    idempotencyKey: `project-object-a-${unique}`,
  });
  const secondAttachment = await createAttachment(owner, deletedChild.id, {
    body: new TextEncoder().encode("project object two"),
    filename: "project-two.txt",
    claimedMediaType: "text/plain",
    idempotencyKey: `project-object-b-${unique}`,
  });
  const deletedTask = await deleteEntity(
    owner,
    "task",
    deletedChild.id,
    (await getTask(owner, deletedChild.id)).version,
  );
  const secondRelease = await createRelease(owner, {
    name: `Separately deleted Release ${unique}`,
    projectId: project.id,
  });
  const deletedRelease = await deleteEntity(
    owner,
    "release",
    secondRelease.id,
    secondRelease.version,
  );
  const secondView = await createSavedView(owner, {
    name: `Separately deleted View ${unique}`,
    scopeProjectId: project.id,
    query: { projectId: project.id },
  });
  const deletedView = await deleteEntity(
    owner,
    "saved_view",
    secondView.id,
    secondView.version,
  );
  const archivedView = await createSavedView(owner, {
    name: `Archived View ${unique}`,
    scopeProjectId: project.id,
    query: { projectId: project.id },
  });
  await updateSavedView(owner, archivedView.id, {
    version: archivedView.version,
    archived: true,
  });
  const globalView = await createSavedView(owner, {
    name: `Global project reference ${unique}`,
    query: { projectId: project.id },
  });
  const revokedGrant = (await getSnapshot(owner)).collaborators.find(
    (grant) => grant.resourceId === project.id && grant.userId === revoked.id,
  )!;
  await revokeAccess(owner, revokedGrant.grantId);
  const liveBeforeDelete = await getSnapshot(owner);
  const projectBeforeDelete = liveBeforeDelete.projects.find((item) => item.id === project.id)!;
  const activePreview = await getProjectDeletionPreview(
    owner,
    project.publicId,
    projectBeforeDelete.version,
  );
  assert.deepEqual(activePreview, {
    type: "project",
    id: project.id,
    publicId: project.publicId,
    displayName: project.name,
    context: project.taskCode,
    version: projectBeforeDelete.version,
    impact: {
      tasks: 3,
      releases: 2,
      savedViews: 3,
      comments: 2,
      attachments: 2,
    },
    activeNavigation: {
      releases: 1,
      savedViews: 1,
    },
  });
  assert.deepEqual(
    await getProjectDeletionPreview(editor, project.id, projectBeforeDelete.version),
    activePreview,
  );
  assert.deepEqual(
    await getProjectDeletionPreview(manager, project.id, projectBeforeDelete.version),
    activePreview,
  );
  await assert.rejects(
    getProjectDeletionPreview(viewer, project.id, projectBeforeDelete.version),
    PermissionError,
  );
  await assert.rejects(
    getProjectDeletionPreview(revoked, project.id, projectBeforeDelete.version),
    NotFoundError,
  );
  await assert.rejects(
    getProjectDeletionPreview(owner, "project-never-existed", projectBeforeDelete.version),
    NotFoundError,
  );
  await assert.rejects(
    getProjectDeletionPreview(owner, project.id, projectBeforeDelete.version + 1),
    ConflictError,
  );

  configureActorResolverForTests(async () => ownerActor);
  const activePreviewResponse = await projectDeletionPreviewRoute(new Request(
    `https://task-manager.test/api/projects/${project.publicId}/deletion-preview?version=${projectBeforeDelete.version}`,
  ), { params: Promise.resolve({ id: project.publicId }) });
  assert.equal(activePreviewResponse.status, 200);
  assert.deepEqual(await activePreviewResponse.json(), activePreview);
  const stalePreviewResponse = await projectDeletionPreviewRoute(new Request(
    `https://task-manager.test/api/projects/${project.publicId}/deletion-preview?version=${projectBeforeDelete.version + 1}`,
  ), { params: Promise.resolve({ id: project.publicId }) });
  assert.equal(stalePreviewResponse.status, 409);
  const invalidPreviewResponse = await projectDeletionPreviewRoute(new Request(
    `https://task-manager.test/api/projects/${project.publicId}/deletion-preview?version=0`,
  ), { params: Promise.resolve({ id: project.publicId }) });
  assert.equal(invalidPreviewResponse.status, 400);
  configureActorResolverForTests(async () => viewerActor);
  const viewerPreviewResponse = await projectDeletionPreviewRoute(new Request(
    `https://task-manager.test/api/projects/${project.publicId}/deletion-preview?version=${projectBeforeDelete.version}`,
  ), { params: Promise.resolve({ id: project.publicId }) });
  assert.equal(viewerPreviewResponse.status, 403);
  configureActorResolverForTests(async () => revokedActor);
  const revokedPreviewResponse = await projectDeletionPreviewRoute(new Request(
    `https://task-manager.test/api/projects/${project.publicId}/deletion-preview?version=${projectBeforeDelete.version}`,
  ), { params: Promise.resolve({ id: project.publicId }) });
  assert.equal(revokedPreviewResponse.status, 404);
  configureActorResolverForTests(null);
  const rankBeforeDelete = (await database.prepare(
    "SELECT rank FROM tasks WHERE id = ?",
  ).bind(archivedTask.id).first<{ rank: number }>())!.rank;
  const statusDefinitionsBefore = await database.prepare(
    "SELECT COUNT(*) AS count FROM workflow_statuses WHERE owner_user_id = ?",
  ).bind(owner.id).first<{ count: number }>();
  const deletedProject = await deleteEntity(
    owner,
    "project",
    project.id,
    projectBeforeDelete.version,
  );
  await assert.rejects(
    getProjectDeletionPreview(owner, project.id, deletedProject.version),
    NotFoundError,
  );
  const preview = await getDeletionPreview(
    owner,
    "project",
    project.id,
    deletedProject.version,
  );
  assert.deepEqual(preview.impact, {
    tasks: 3,
    releases: 2,
    savedViews: 3,
    comments: 2,
    attachments: 2,
    releaseMemberships: 0,
  });
  assert.deepEqual((await queryTaskSummaries(owner, {
    surface: `view:${globalView.id}`,
    query: globalView.query,
  })).taskIds, []);
  await restoreEntity(owner, "project", project.id, deletedProject.version);
  const restoredSnapshot = await getSnapshot(owner);
  const restoredProject = restoredSnapshot.projects.find((item) => item.id === project.id)!;
  assert.equal(restoredProject.taskCode, projectBeforeDelete.taskCode);
  assert.equal(restoredProject.taskSequence, projectBeforeDelete.taskSequence);
  assert.equal(
    (await database.prepare("SELECT rank FROM tasks WHERE id = ?").bind(archivedTask.id)
      .first<{ rank: number }>())!.rank,
    rankBeforeDelete,
  );
  assert.equal(
    (await database.prepare(
      "SELECT COUNT(*) AS count FROM workflow_statuses WHERE owner_user_id = ?",
    ).bind(owner.id).first<{ count: number }>())!.count,
    statusDefinitionsBefore!.count,
  );
  assert.equal(
    (await getSnapshot(editor)).projects.find((item) => item.id === project.id)?.accessRole,
    "editor",
  );
  assert.equal(
    (await getSnapshot(viewer)).projects.find((item) => item.id === project.id)?.accessRole,
    "viewer",
  );
  assert.equal((await listRecentlyDeleted(owner)).items.some(
    (item) => item.id === deletedTask.id,
  ), true);
  assert.equal((await listRecentlyDeleted(owner)).items.some(
    (item) => item.id === deletedRelease.id,
  ), true);
  assert.equal((await listRecentlyDeleted(owner)).items.some(
    (item) => item.id === deletedView.id,
  ), true);
  assert.deepEqual(new Set((await queryTaskSummaries(owner, {
    surface: `view:${globalView.id}`,
    query: globalView.query,
  })).taskIds), new Set([task.id]));

  await database.batch([
    database.prepare(
      `INSERT INTO access_grants
       (id, resource_type, resource_id, owner_user_id, grantee_user_id,
        granted_by_user_id, permission)
       VALUES (?, 'task', ?, ?, ?, ?, 'editor')`,
    ).bind(`legacy-task-grant-${unique}`, task.id, owner.id, editor.id, owner.id),
    database.prepare(
      `INSERT INTO access_grants
       (id, resource_type, resource_id, owner_user_id, grantee_user_id,
        granted_by_user_id, permission)
       VALUES (?, 'saved_view', ?, ?, ?, ?, 'editor')`,
    ).bind(`legacy-view-grant-${unique}`, view.id, owner.id, editor.id, owner.id),
  ]);
  const ownerBeforeSecondDelete = await getSnapshot(owner);
  const editorBeforeSecondDelete = await getSnapshot(editor);
  const viewerBeforeSecondDelete = await getSnapshot(viewer);
  const deletedAgain = await deleteEntity(
    owner,
    "project",
    project.id,
    restoredProject.version,
  );
  assert.equal(
    (await getWorkspaceSync(owner, ownerBeforeSecondDelete.syncCursor!)).resetRequired,
    true,
  );
  assert.equal(
    (await getWorkspaceSync(editor, editorBeforeSecondDelete.syncCursor!)).resetRequired,
    true,
  );
  assert.equal(
    (await getWorkspaceSync(viewer, viewerBeforeSecondDelete.syncCursor!)).resetRequired,
    true,
  );
  const failingBucket = new Proxy(bucket, {
    get(target, property) {
      if (property === "delete") {
        return async () => { throw new Error("synthetic Project R2 delete failure"); };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  configureRuntimeEnvironment({ DB: database, ATTACHMENTS: failingBucket });
  await assert.rejects(
    purgeEntity(
      owner,
      "project",
      project.id,
      deletedAgain.version,
      PERMANENT_DELETE_CONFIRMATION,
    ),
    /synthetic Project R2 delete failure/,
  );
  assert.ok(await database.prepare("SELECT id FROM projects WHERE id = ?").bind(project.id).first());
  await assert.rejects(
    restoreEntity(owner, "project", project.id, deletedAgain.version),
    /permanent deletion has started/,
  );
  configureRuntimeEnvironment({ DB: database, ATTACHMENTS: bucket });
  await purgeEntity(
    owner,
    "project",
    project.id,
    deletedAgain.version,
    PERMANENT_DELETE_CONFIRMATION,
  );
  assert.equal(await database.prepare("SELECT id FROM projects WHERE id = ?").bind(project.id).first(), null);
  assert.equal(await database.prepare("SELECT id FROM tasks WHERE project_id = ?").bind(project.id).first(), null);
  assert.equal(await database.prepare("SELECT id FROM releases WHERE project_id = ?").bind(project.id).first(), null);
  assert.equal(await database.prepare("SELECT id FROM saved_views WHERE scope_project_id = ?").bind(project.id).first(), null);
  assert.equal((await database.prepare(
    `SELECT COUNT(*) AS count FROM access_grants
     WHERE (resource_type = 'project' AND resource_id = ?)
        OR (resource_type = 'task' AND resource_id IN (?, ?))
        OR (resource_type = 'saved_view' AND resource_id IN (?, ?))`,
  ).bind(project.id, task.id, deletedChild.id, view.id, secondView.id)
    .first<{ count: number }>())!.count, 0);
  assert.equal(await bucket.head(firstAttachment.objectKey), null);
  assert.equal(await bucket.head(secondAttachment.objectKey), null);
  assert.deepEqual((await queryTaskSummaries(owner, {
    surface: `view:${globalView.id}`,
    query: globalView.query,
  })).taskIds, []);
  assert.equal((await getSnapshot(editor)).projects.some((item) => item.id === project.id), false);
  assert.equal((await getSnapshot(viewer)).projects.some((item) => item.id === project.id), false);
  assert.ok(release.id);
});

test("Saved View lifecycle preserves formula, display, scope, identity, and ACL without touching Tasks", async () => {
  const editor = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: `view-delete-editor-${unique}`,
    displayName: "View Delete Editor",
    email: `view-delete-editor-${unique}@example.test`,
  });
  const viewer = await getOrCreateUser({
    ...ownerActor,
    providerAccountKey: `view-delete-viewer-${unique}`,
    displayName: "View Delete Viewer",
    email: `view-delete-viewer-${unique}@example.test`,
  });
  const { task } = await fixture("view-lifecycle");
  const globalView = await createSavedView(owner, {
    name: `Global deletion view ${unique}`,
    query: { priorities: ["high", "urgent"] },
    display: { layout: "board", groupBy: "priority", orderBy: "updated" },
  });
  await grantAccess(owner, {
    resourceType: "saved_view",
    resourceId: globalView.id,
    email: editor.email,
    permission: "editor",
  });
  await grantAccess(owner, {
    resourceType: "saved_view",
    resourceId: globalView.id,
    email: viewer.email,
    permission: "viewer",
  });
  const baselineTaskCount = (await getSnapshot(owner)).tasks.length;
  const editorView = (await getSnapshot(editor)).views.find((item) => item.id === globalView.id)!;
  const deleted = await deleteEntity(
    editor,
    "saved_view",
    globalView.publicId,
    editorView.version,
  );
  await assert.rejects(
    restoreEntity(viewer, "saved_view", globalView.id, deleted.version),
    PermissionError,
  );
  await restoreEntity(editor, "saved_view", globalView.id, deleted.version);
  const restored = (await getSnapshot(owner)).views.find((item) => item.id === globalView.id)!;
  assert.equal(restored.publicId, globalView.publicId);
  assert.equal(restored.ownerUserId, globalView.ownerUserId);
  assert.equal(restored.name, globalView.name);
  assert.equal(restored.scopeProjectId, null);
  assert.deepEqual(restored.query, globalView.query);
  assert.deepEqual(restored.display, globalView.display);
  assert.equal((await getSnapshot(owner)).tasks.length, baselineTaskCount);
  assert.equal((await getTask(owner, task.id)).id, task.id);

  const deletedAgain = await deleteEntity(
    editor,
    "saved_view",
    globalView.id,
    restored.version,
  );
  await assert.rejects(
    purgeEntity(
      editor,
      "saved_view",
      globalView.id,
      deletedAgain.version,
      PERMANENT_DELETE_CONFIRMATION,
    ),
    PermissionError,
  );
  await purgeEntity(
    owner,
    "saved_view",
    globalView.id,
    deletedAgain.version,
    PERMANENT_DELETE_CONFIRMATION,
  );
  assert.equal(await database.prepare(
    "SELECT id FROM saved_views WHERE id = ?",
  ).bind(globalView.id).first(), null);
  assert.equal((await database.prepare(
    `SELECT COUNT(*) AS count FROM access_grants
     WHERE resource_type = 'saved_view' AND resource_id = ?`,
  ).bind(globalView.id).first<{ count: number }>())!.count, 0);
  assert.equal((await getSnapshot(owner)).tasks.length, baselineTaskCount);
});

test("Task purge detaches children, removes owned data, and never reuses its identifier sequence", async () => {
  const { project, task } = await fixture("task-purge-complete");
  const childIdentity = await createTask(owner, {
    title: `Purge child ${unique}`,
    projectId: project.id,
  });
  const child = await setTaskParent(owner, childIdentity.id, {
    version: (await getTask(owner, childIdentity.id)).version,
    parentTaskId: task.id,
  });
  const relatedIdentity = await createTask(owner, {
    title: `Purge relation peer ${unique}`,
    projectId: project.id,
  });
  const related = await getTask(owner, relatedIdentity.id);
  await createTaskRelation(owner, task.id, {
    targetTaskId: related.id,
    type: "blocks",
    direction: "outgoing",
    idempotencyKey: `purge-relation-${unique}`,
  });
  await createComment(owner, task.id, {
    body: "Purged Task comment",
    idempotencyKey: `purge-comment-${unique}`,
  });
  const attachment = await createAttachment(owner, task.id, {
    body: new TextEncoder().encode("purged Task object"),
    filename: "purged-task.txt",
    claimedMediaType: "text/plain",
    idempotencyKey: `purge-object-${unique}`,
  });
  const current = await getTask(owner, task.id);
  const deleted = await deleteEntity(owner, "task", task.id, current.version);
  await purgeEntity(
    owner,
    "task",
    task.id,
    deleted.version,
    PERMANENT_DELETE_CONFIRMATION,
  );
  const detachedChild = await getTask(owner, child.id);
  assert.equal(detachedChild.parentTaskId, null);
  assert.equal(detachedChild.version, child.version + 1);
  assert.equal((await getTaskDetail(owner, related.id)).relations.length, 0);
  assert.equal(await database.prepare("SELECT id FROM comments WHERE task_id = ?").bind(task.id).first(), null);
  assert.equal(await database.prepare("SELECT id FROM activity_events WHERE task_id = ?").bind(task.id).first(), null);
  assert.equal(await database.prepare("SELECT id FROM attachments WHERE task_id = ?").bind(task.id).first(), null);
  assert.equal(await bucket.head(attachment.objectKey), null);
  const replacementIdentity = await createTask(owner, {
    title: `After purge sequence ${unique}`,
    projectId: project.id,
  });
  const replacement = await getTask(owner, replacementIdentity.id);
  assert.equal(replacement.sequenceNumber > task.sequenceNumber, true);
  assert.notEqual(replacement.identifier, task.identifier);
});
