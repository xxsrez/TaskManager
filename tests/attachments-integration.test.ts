import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  GET as getAttachmentContentRoute,
} from "../app/api/tasks/[id]/attachments/[attachmentRef]/content/route";
import {
  GET as listAttachmentsRoute,
  POST as createAttachmentRoute,
} from "../app/api/tasks/[id]/attachments/route";
import {
  createAttachment,
  deleteAttachment,
  getAttachmentContent,
  listTaskAttachments,
  purgeAttachmentGarbage,
  restoreAttachment,
} from "../lib/attachments";
import { configureActorResolverForTests } from "../lib/auth";
import { ConflictError, NotFoundError, PermissionError, ValidationError } from "../lib/domain";
import {
  createProject,
  createTask,
  getOrCreateUser,
  getSnapshot,
  grantAccess,
  revokeAccess,
} from "../lib/repository";
import { exportProjectBackup } from "../lib/project-backup";
import { exportSystemBackup } from "../lib/system-backup";
import { getWorkspaceSync } from "../lib/workspace-sync";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "attachment-owner",
  displayName: "Attachment Owner",
  email: "attachment-owner@example.test",
};
const editorActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "attachment-editor",
  displayName: "Attachment Editor",
  email: "attachment-editor@example.test",
};
const viewerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "attachment-viewer",
  displayName: "Attachment Viewer",
  email: "attachment-viewer@example.test",
};
const outsiderActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "attachment-outsider",
  displayName: "Attachment Outsider",
  email: "attachment-outsider@example.test",
};

let dispose: (() => Promise<void>) | undefined;
let database: D1Database;
let bucket: R2Bucket;
let thumbnailTransforms = 0;
let thumbnailTransformFails = false;

before(async () => {
  const harness = await createD1TestHarness({
    TASK_MANAGER_ATTACHMENT_SCOPE: "test",
    TASK_MANAGER_ATTACHMENT_MAX_BYTES: "1024",
    TASK_MANAGER_ATTACHMENT_MAX_COUNT: "4",
    TASK_MANAGER_ATTACHMENT_MAX_IMAGE_PIXELS: "1000000",
    TASK_MANAGER_ATTACHMENT_DELETE_GRACE_SECONDS: "60",
    TASK_MANAGER_ADMIN_EMAILS: ownerActor.email,
  }, {
    r2: true,
    images: {
      input(stream) {
        return {
          transform() {
            return {
              async output() {
                thumbnailTransforms += 1;
                return {
                  response: () => thumbnailTransformFails
                    ? new Response(null, { status: 502 })
                    : new Response(stream, {
                        headers: { "content-type": "image/webp" },
                      }),
                };
              },
            };
          },
        };
      },
    },
  });
  database = harness.database;
  bucket = harness.attachmentBucket!;
  dispose = harness.dispose;
});

after(async () => {
  configureActorResolverForTests(null);
  await dispose?.();
});

async function setupSharedTask(name: string) {
  const owner = await getOrCreateUser(ownerActor);
  const editor = await getOrCreateUser(editorActor);
  const viewer = await getOrCreateUser(viewerActor);
  const outsider = await getOrCreateUser(outsiderActor);
  await createProject(owner, { name });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === name)!;
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
  const task = await createTask(owner, { title: `${name} task`, projectId: project.id });
  return { owner, editor, viewer, outsider, project, task };
}

test("native attachments use private opaque R2 keys, verified metadata, and scoped idempotency", async () => {
  const { owner, editor, task } = await setupSharedTask("Attachment lifecycle");
  const pdf = new TextEncoder().encode("%PDF-1.7\nhello\n%%EOF");
  const created = await createAttachment(owner, task.id, {
    body: pdf,
    filename: "customer/report.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "pdf-upload-1",
  });

  assert.equal(created.state, "ready");
  assert.equal(created.mediaType, "application/pdf");
  assert.equal(created.displayName, "report.pdf");
  assert.equal(created.byteSize, pdf.byteLength);
  assert.match(created.checksumSha256, /^[a-f0-9]{64}$/);
  assert.match(created.objectKey, /^test\/attachments\/[0-9a-f-]{36}$/);
  assert.ok(!created.objectKey.includes("report.pdf"));
  assert.ok(await bucket.head(created.objectKey));

  const duplicate = await createAttachment(owner, task.id, {
    body: pdf,
    filename: "retry.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "pdf-upload-1",
  });
  assert.equal(duplicate.id, created.id);
  await assert.rejects(
    createAttachment(owner, task.id, {
      body: new TextEncoder().encode("%PDF-1.7\ndifferent\n%%EOF"),
      filename: "different.pdf",
      claimedMediaType: "application/pdf",
      idempotencyKey: "pdf-upload-1",
    }),
    ConflictError,
  );

  const editorUpload = await createAttachment(editor, task.id, {
    body: pdf,
    filename: "editor.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "editor-pdf",
  });
  assert.equal(editorUpload.uploaderUserId, editor.id);
});

test("attachment reads follow current Task ACL and never leak existence", async () => {
  const { owner, viewer, outsider, project, task } = await setupSharedTask("Attachment ACL");
  const attachment = await createAttachment(owner, task.id, {
    body: new TextEncoder().encode("%PDF-1.7\nprivate\n%%EOF"),
    filename: "private\"\r\nX-Evil: yes.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "private-pdf",
  });

  assert.equal((await listTaskAttachments(viewer, task.id)).items[0]?.publicId, attachment.publicId);
  const response = await getAttachmentContent(viewer, task.id, attachment.publicId, {
    rangeHeader: "bytes=0-7",
    preview: true,
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.ok(!(response.headers.get("content-disposition") ?? "").includes("\r"));
  assert.equal(new TextDecoder().decode(await response.arrayBuffer()), "%PDF-1.7");

  await assert.rejects(listTaskAttachments(outsider, task.id), NotFoundError);
  await assert.rejects(
    createAttachment(viewer, task.id, {
      body: new TextEncoder().encode("%PDF-1.7\nnope\n%%EOF"),
      filename: "nope.pdf",
      claimedMediaType: "application/pdf",
      idempotencyKey: "viewer-nope",
    }),
    PermissionError,
  );

  const grant = (await getSnapshot(owner)).collaborators.find(
    (item) => item.resourceId === project.id && item.userId === viewer.id,
  )!;
  await revokeAccess(owner, grant.grantId);
  await assert.rejects(
    getAttachmentContent(viewer, task.id, attachment.publicId, { preview: false }),
    NotFoundError,
  );
});

test("content inspection rejects active, mismatched, corrupted, and oversized uploads", async () => {
  const { owner, task } = await setupSharedTask("Attachment validation");
  await assert.rejects(
    createAttachment(owner, task.id, {
      body: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>"),
      filename: "image.svg",
      claimedMediaType: "image/svg+xml",
      idempotencyKey: "active-svg",
    }),
    ValidationError,
  );
  await assert.rejects(
    createAttachment(owner, task.id, {
      body: new TextEncoder().encode("%PDF-1.7\nconfused\n%%EOF"),
      filename: "confused.png",
      claimedMediaType: "image/png",
      idempotencyKey: "mime-confusion",
    }),
    ValidationError,
  );
  await assert.rejects(
    createAttachment(owner, task.id, {
      body: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      filename: "corrupt.png",
      claimedMediaType: "image/png",
      idempotencyKey: "corrupt-png",
    }),
    ValidationError,
  );
  await assert.rejects(
    createAttachment(owner, task.id, {
      body: new Uint8Array(1025),
      filename: "large.bin",
      claimedMediaType: "application/octet-stream",
      idempotencyKey: "oversized",
    }),
    ValidationError,
  );
});

test("deletion is recoverable during grace and garbage collection removes objects without orphans", async () => {
  const { owner, viewer, task } = await setupSharedTask("Attachment cleanup");
  const attachment = await createAttachment(owner, task.id, {
    body: new TextEncoder().encode("%PDF-1.7\ncleanup\n%%EOF"),
    filename: "cleanup.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "cleanup-pdf",
  });
  const deleted = await deleteAttachment(owner, task.id, attachment.publicId, attachment.version);
  assert.equal(deleted.state, "deleted");
  assert.equal((await listTaskAttachments(owner, task.id, { includeDeleted: true })).items[0]?.state, "deleted");
  await assert.rejects(
    listTaskAttachments(viewer, task.id, { includeDeleted: true }),
    PermissionError,
  );
  assert.ok(await bucket.head(attachment.objectKey));
  const restored = await restoreAttachment(owner, task.id, attachment.publicId, deleted.version);
  assert.equal(restored.state, "ready");

  const deletedAgain = await deleteAttachment(owner, task.id, attachment.publicId, restored.version);
  await database
    .prepare("UPDATE attachments SET deleted_at = ?, updated_at = ? WHERE id = ?")
    .bind("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", attachment.id)
    .run();
  const cleanup = await purgeAttachmentGarbage(new Date("2026-01-01T00:02:00.000Z"));
  assert.equal(cleanup.purged, 1);
  assert.equal(await bucket.head(attachment.objectKey), null);
  assert.equal(
    await database.prepare("SELECT id FROM attachments WHERE id = ?").bind(deletedAgain.id).first(),
    null,
  );
});

test("attachment mutations emit a bounded lazy invalidation for other sessions", async () => {
  const { owner, viewer, task } = await setupSharedTask("Attachment sync");
  const baseline = await getSnapshot(viewer);
  await createAttachment(owner, task.id, {
    body: new TextEncoder().encode("%PDF-1.7\nsync\n%%EOF"),
    filename: "sync.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "sync-pdf",
  });

  const response = await getWorkspaceSync(viewer, baseline.syncCursor!);
  assert.equal(response.resetRequired, false);
  assert.deepEqual(response.changes.tasks.upsert, []);
  assert.deepEqual(response.changes.invalidations.taskAttachments, [task.id]);
  assert.deepEqual(response.changes.invalidations.taskDetails, []);
});

test("binary HTTP routes authenticate before bounded upload and preserve private range delivery", async () => {
  const { owner, viewer, outsider, task } = await setupSharedTask("Attachment routes");
  const routeContext = { params: Promise.resolve({ id: task.id }) };
  configureActorResolverForTests(async () => null);
  const unauthenticated = await createAttachmentRoute(
    new Request(`https://example.test/api/tasks/${task.id}/attachments`, {
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        "idempotency-key": "route-unauthenticated",
        "x-attachment-filename": "route.pdf",
      },
      body: "%PDF-1.7\nsecret\n%%EOF",
    }),
    routeContext,
  );
  assert.equal(unauthenticated.status, 401);

  configureActorResolverForTests(async () => ownerActor);
  const oversized = await createAttachmentRoute(
    new Request(`https://example.test/api/tasks/${task.id}/attachments`, {
      method: "POST",
      headers: {
        "content-length": "1025",
        "content-type": "application/octet-stream",
        "idempotency-key": "route-oversized",
        "x-attachment-filename": "large.bin",
      },
      body: "x",
    }),
    routeContext,
  );
  assert.equal(oversized.status, 400);

  const createdResponse = await createAttachmentRoute(
    new Request(`https://example.test/api/tasks/${task.id}/attachments`, {
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        "idempotency-key": "route-pdf",
        "x-attachment-filename": encodeURIComponent("Маршрут.pdf"),
      },
      body: "%PDF-1.7\nroute\n%%EOF",
    }),
    routeContext,
  );
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as {
    attachment: { ref: string; filename: string };
  };
  assert.equal(created.attachment.filename, "Маршрут.pdf");

  configureActorResolverForTests(async () => viewerActor);
  const listed = await listAttachmentsRoute(
    new Request(`https://example.test/api/tasks/${task.id}/attachments`),
    routeContext,
  );
  assert.equal(listed.status, 200);
  const content = await getAttachmentContentRoute(
    new Request(
      `https://example.test/api/tasks/${task.id}/attachments/${created.attachment.ref}/content`,
      { headers: { range: "bytes=-5" } },
    ),
    {
      params: Promise.resolve({
        id: task.id,
        attachmentRef: created.attachment.ref,
      }),
    },
  );
  assert.equal(content.status, 206);
  assert.equal(new TextDecoder().decode(await content.arrayBuffer()), "%%EOF");

  configureActorResolverForTests(async () => ownerActor);
  const image = await createAttachment(owner, task.id, {
    body: Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02,
    ]),
    filename: "preview.png",
    claimedMediaType: "image/png",
    idempotencyKey: "route-thumbnail",
  });
  configureActorResolverForTests(async () => viewerActor);
  const thumbnail = await getAttachmentContentRoute(
    new Request(
      `https://example.test/api/tasks/${task.id}/attachments/${image.publicId}/content?variant=thumbnail`,
    ),
    {
      params: Promise.resolve({
        id: task.id,
        attachmentRef: image.publicId,
      }),
    },
  );
  assert.equal(thumbnail.status, 200);
  assert.equal(thumbnail.headers.get("content-type"), "image/webp");
  assert.equal(thumbnail.headers.get("x-attachment-variant"), "thumbnail");
  assert.equal(thumbnailTransforms, 1);

  thumbnailTransformFails = true;
  const failedThumbnail = await getAttachmentContentRoute(
    new Request(
      `https://example.test/api/tasks/${task.id}/attachments/${image.publicId}/content?variant=thumbnail`,
    ),
    {
      params: Promise.resolve({ id: task.id, attachmentRef: image.publicId }),
    },
  );
  thumbnailTransformFails = false;
  assert.equal(failedThumbnail.status, 200);
  assert.equal(failedThumbnail.headers.get("content-type"), "image/png");
  assert.equal(
    failedThumbnail.headers.get("x-attachment-variant"),
    "original-fallback",
  );
  assert.deepEqual(
    new Uint8Array(await failedThumbnail.arrayBuffer()),
    Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02,
    ]),
  );
  const originalImage = await getAttachmentContentRoute(
    new Request(
      `https://example.test/api/tasks/${task.id}/attachments/${image.publicId}/content?disposition=inline`,
    ),
    {
      params: Promise.resolve({ id: task.id, attachmentRef: image.publicId }),
    },
  );
  assert.equal(originalImage.status, 200);
  assert.equal(originalImage.headers.get("content-type"), "image/png");

  configureActorResolverForTests(async () => outsiderActor);
  const hidden = await getAttachmentContentRoute(
    new Request(
      `https://example.test/api/tasks/${task.id}/attachments/${created.attachment.ref}/content`,
    ),
    {
      params: Promise.resolve({
        id: task.id,
        attachmentRef: created.attachment.ref,
      }),
    },
  );
  assert.equal(hidden.status, 404);
  assert.equal((await hidden.json() as { error: string }).error, "One or more tasks were not found");
  assert.ok(owner && viewer && outsider);
});

test("legacy logical backups fail closed instead of orphaning native attachment objects", async () => {
  const { owner, project, task } = await setupSharedTask("Attachment backup guard");
  await createAttachment(owner, task.id, {
    body: new TextEncoder().encode("%PDF-1.7\nbackup guard\n%%EOF"),
    filename: "guard.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "backup-guard",
  });
  await assert.rejects(
    exportProjectBackup(owner, project.id, "https://example.test"),
    /attachment-aware backup format/,
  );
  await assert.rejects(exportSystemBackup(owner), /attachment-aware backup format/);
});
