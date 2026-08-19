import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  GET as getAttachmentContentRoute,
} from "../app/api/tasks/[id]/attachments/[attachmentRef]/content/route";
import {
  GET as getAgentAttachmentContentRoute,
} from "../app/api/agent/v1/tasks/[ref]/attachments/[attachmentRef]/content/route";
import {
  DELETE as deleteAgentAttachmentRoute,
  GET as getAgentAttachmentRoute,
} from "../app/api/agent/v1/tasks/[ref]/attachments/[attachmentRef]/route";
import {
  GET as listAgentAttachmentsRoute,
  POST as createAgentAttachmentRoute,
} from "../app/api/agent/v1/tasks/[ref]/attachments/route";
import { POST as mcpPost } from "../app/api/mcp/route";
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
  getTask,
  grantAccess,
  revokeAccess,
  updateTask,
} from "../lib/repository";
import { buildTaskFileLink, buildTaskImageToken } from "../lib/task-description-format";
import { updateAgentTask } from "../lib/agent-api-repository";
import { getAgentTaskDetail } from "../lib/agent-api-repository";
import { issueApiCredential } from "../lib/api-credentials";
import {
  applyProjectBackup,
  exportProjectBackup,
  stageProjectBackup,
} from "../lib/project-backup";
import {
  applySystemBackup,
  exportSystemBackup,
  stageSystemBackup,
} from "../lib/system-backup";
import { reconcileAttachmentStorage } from "../lib/attachment-operations";
import { createSystemBackup } from "../lib/system-backup-format";
import { getRuntimeEnvironment } from "../lib/runtime-environment";
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
let attachmentProjectCodeIndex = 0;

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
  const taskCode = `A${String.fromCharCode(65 + attachmentProjectCodeIndex)}`;
  attachmentProjectCodeIndex += 1;
  await createProject(owner, { name, taskCode });
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

test("an unreferenced attachment can be deleted while the Task description is SQL NULL", async () => {
  const { owner, task } = await setupSharedTask("Null description delete guard");
  const attachment = await createAttachment(owner, task.id, {
    body: new TextEncoder().encode("%PDF-1.7\nnull description\n%%EOF"),
    filename: "null-description.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "null-description-delete",
  });
  const nullSnapshot = await database
    .prepare("SELECT COALESCE(CAST(NULL AS TEXT), '') = ? AS matches")
    .bind("")
    .first<{ matches: number }>();
  assert.equal(nullSnapshot?.matches, 1);
  assert.equal((await getTask(owner, task.id)).description, "");

  const deleted = await deleteAttachment(
    owner,
    task.id,
    attachment.publicId,
    attachment.version,
  );
  assert.equal(deleted.state, "deleted");
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

test("Task descriptions accept ready same-Task image embeds and file links and block deletion while referenced", async () => {
  const { owner, project, task } = await setupSharedTask("Description images");
  const imageBytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02,
  ]);
  const image = await createAttachment(owner, task.id, {
    body: imageBytes,
    filename: "diagram.png",
    claimedMediaType: "image/png",
    idempotencyKey: "description-image",
  });
  const token = buildTaskImageToken(image.publicId, "Architecture diagram", "Request flow");
  let detail = await getTask(owner, task.id);
  detail = await updateTask(owner, detail.id, {
    version: detail.version,
    description: `## Design\n\n${token}\n\nSafe [link](https://example.test).`,
  });
  assert.match(detail.description ?? "", /attachment:v1:/);
  await assert.rejects(
    deleteAttachment(owner, task.id, image.publicId, image.version),
    (error: unknown) => error instanceof ValidationError && /description/.test(error.message),
  );

  const otherTask = await createTask(owner, {
    title: "Other Task",
    projectId: project.id,
  });
  const otherDetail = await getTask(owner, otherTask.id);
  await assert.rejects(
    updateTask(owner, otherTask.id, {
      version: otherDetail.version,
      description: token,
    }),
    ValidationError,
  );
  await assert.rejects(
    updateTask(owner, detail.id, {
      version: detail.version,
      description: "![Missing](attachment:v1:guessed-reference)",
    }),
    ValidationError,
  );
  await assert.rejects(
    updateTask(owner, detail.id, {
      version: detail.version,
      description: `Broken ${"attachment:v1:"}${image.publicId}`,
    }),
    ValidationError,
  );

  const document = await createAttachment(owner, task.id, {
    body: new TextEncoder().encode("%PDF-1.7\nnot an image\n%%EOF"),
    filename: "notes.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "description-document",
  });
  await assert.rejects(
    updateTask(owner, detail.id, {
      version: detail.version,
      description: buildTaskImageToken(document.publicId, "Not raster"),
    }),
    ValidationError,
  );

  const fileLink = buildTaskFileLink(document.publicId, "Download design notes");
  detail = await updateTask(owner, detail.id, {
    version: detail.version,
    description: `The original is available as ${fileLink}.`,
  });
  assert.equal(detail.description, `The original is available as ${fileLink}.`);
  await assert.rejects(
    deleteAttachment(owner, task.id, document.publicId, document.version),
    (error: unknown) => error instanceof ValidationError && /description/.test(error.message),
  );
  await assert.rejects(
    updateTask(owner, otherTask.id, {
      version: otherDetail.version,
      description: fileLink,
    }),
    ValidationError,
  );
  await assert.rejects(
    updateTask(owner, detail.id, {
      version: detail.version,
      description: "[Missing](attachment:v1:guessed-reference)",
    }),
    ValidationError,
  );

  detail = await updateTask(owner, detail.id, {
    version: detail.version,
    description: [
      `Literal \`${fileLink}\` remains code.`,
      "```md",
      fileLink,
      "```",
    ].join("\n"),
  });
  const deletedLiteral = await deleteAttachment(
    owner,
    task.id,
    document.publicId,
    document.version,
  );
  assert.equal(deletedLiteral.state, "deleted");

  detail = await updateTask(owner, detail.id, {
    version: detail.version,
    description: "The binary remains attached after removing its embed.",
  });
  const agentDetail = await updateAgentTask(owner, detail.publicId, {
    version: detail.version,
    description: token,
  });
  assert.match(agentDetail.description ?? "", /attachment:v1:/);
  const agentRemoved = await updateAgentTask(owner, detail.publicId, {
    version: agentDetail.version,
    description: "The Agent path enforces the same repository invariant.",
  });
  const removed = await deleteAttachment(owner, detail.id, image.publicId, image.version);
  assert.equal(removed.state, "deleted");
  await assert.rejects(
    updateAgentTask(owner, detail.publicId, {
      version: agentRemoved.version,
      description: token,
    }),
    ValidationError,
  );
});

test("UI repository, Agent, and MCP preserve literal attachment examples without lookup", async () => {
  const { owner, task } = await setupSharedTask("Description code literals");
  const tailAttachment = await createAttachment(owner, task.id, {
    body: new TextEncoder().encode("%PDF-1.7\ntail\n%%EOF"),
    filename: "tail.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "description-escaped-backtick-tail",
  });
  const guessed = "guessed-reference";
  const fileToken = `[missing.pdf](attachment:v1:${guessed})`;
  const imageToken = `![missing](attachment:v1:${guessed})`;
  const description = [
    `Inline \`\`example with one \` inside: ${fileToken}\`\` remains code.`,
    "~~~markdown",
    imageToken,
    "~~~~",
    "   ```ts",
    fileToken,
    "   ```",
    `\\${fileToken}`,
    "```markdown",
    fileToken,
  ].join("\n");

  let detail = await getTask(owner, task.id);
  detail = await updateTask(owner, detail.id, {
    version: detail.version,
    description,
  });
  assert.equal(detail.description, description);
  const escapedBacktickBoundary = "`code \\` [mid](attachment:v1:mid-reference-123)` " +
    buildTaskFileLink(tailAttachment.publicId, "tail.pdf");
  await assert.rejects(
    updateTask(owner, detail.id, {
      version: detail.version,
      description: escapedBacktickBoundary,
    }),
    ValidationError,
  );

  const agentDetail = await updateAgentTask(owner, detail.publicId, {
    version: detail.version,
    description,
  });
  assert.equal(agentDetail.description, description);
  await assert.rejects(
    updateAgentTask(owner, detail.publicId, {
      version: agentDetail.version,
      description: escapedBacktickBoundary,
    }),
    ValidationError,
  );

  const credential = await issueApiCredential(owner, {
    name: "description-code-literals",
    scopes: ["api:write"],
    expiresInDays: 1,
  });
  const mcpHeaders = {
    authorization: `Bearer ${credential.token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const mcpUpdate = await mcpPost(new Request("https://example.test/api/mcp", {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 269,
      method: "tools/call",
      params: {
        name: "update_task",
        arguments: {
          taskRef: detail.publicId,
          version: agentDetail.version,
          description,
        },
      },
    }),
  }));
  const mcpUpdated = await mcpResult(mcpUpdate);
  assert.equal(
    (mcpUpdated.result.structuredContent.data as { description: string }).description,
    description,
  );

  const currentVersion = (mcpUpdated.result.structuredContent.data as { version: number }).version;
  const rejected = await mcpPost(new Request("https://example.test/api/mcp", {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 270,
      method: "tools/call",
      params: {
        name: "update_task",
        arguments: {
          taskRef: detail.publicId,
          version: currentVersion,
          description: escapedBacktickBoundary,
        },
      },
    }),
  }));
  const rejectedResult = await mcpResult(rejected);
  assert.equal(rejectedResult.result.isError, true);
  assert.doesNotMatch(JSON.stringify(rejectedResult), /mid-reference-123/);
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

test("Agent attachment routes and MCP tools preserve binary transport and bearer ACL", async (t) => {
  const { owner, viewer, outsider, task } = await setupSharedTask("Agent attachments");
  const ownerCredential = await issueApiCredential(owner, {
    name: "agent-attachment-owner",
    scopes: ["api:write"],
    expiresInDays: 1,
  });
  const viewerCredential = await issueApiCredential(viewer, {
    name: "agent-attachment-viewer",
    scopes: ["api:write"],
    expiresInDays: 1,
  });
  const outsiderCredential = await issueApiCredential(outsider, {
    name: "agent-attachment-outsider",
    scopes: ["api:read"],
    expiresInDays: 1,
  });
  const endpoint = `https://example.test/api/agent/v1/tasks/${task.publicId}/attachments`;
  const context = { params: Promise.resolve({ ref: task.publicId }) };

  const upload = (key: string, filename: string, body: string) =>
    createAgentAttachmentRoute(
      new Request(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerCredential.token}`,
          "content-type": "application/pdf",
          "idempotency-key": key,
          "x-attachment-filename": encodeURIComponent(filename),
        },
        body,
      }),
      context,
    );
  const firstResponse = await upload(
    "agent-route-one",
    "agent-one.pdf",
    "%PDF-1.7\none\n%%EOF",
  );
  assert.equal(firstResponse.status, 201);
  const first = (await firstResponse.json()) as {
    data: Record<string, unknown> & { ref: string; version: number; links: { original: string } };
  };
  assert.equal(first.data.filename, "agent-one.pdf");
  for (const privateField of ["id", "taskId", "uploaderUserId", "objectKey"]) {
    assert.equal(Object.hasOwn(first.data, privateField), false, privateField);
  }
  await upload("agent-route-two", "agent-two.pdf", "%PDF-1.7\ntwo\n%%EOF");

  const pageOneResponse = await listAgentAttachmentsRoute(
    new Request(`${endpoint}?limit=1`, {
      headers: { authorization: `Bearer ${viewerCredential.token}` },
    }),
    context,
  );
  assert.equal(pageOneResponse.status, 200);
  const pageOne = (await pageOneResponse.json()) as {
    data: Array<{ ref: string }>;
    page: { hasMore: boolean; nextCursor: string };
  };
  assert.equal(pageOne.data.length, 1);
  assert.equal(pageOne.page.hasMore, true);
  const pageTwoResponse = await listAgentAttachmentsRoute(
    new Request(`${endpoint}?limit=1&cursor=${pageOne.page.nextCursor}`, {
      headers: { authorization: `Bearer ${viewerCredential.token}` },
    }),
    context,
  );
  const pageTwo = (await pageTwoResponse.json()) as {
    data: Array<{ ref: string }>;
    page: { hasMore: boolean };
  };
  assert.equal(pageTwo.data.length, 1);
  assert.notEqual(pageTwo.data[0]?.ref, pageOne.data[0]?.ref);
  assert.equal(pageTwo.page.hasMore, false);

  const metadataContext = {
    params: Promise.resolve({
      ref: task.publicId,
      attachmentRef: first.data.ref,
    }),
  };
  const metadataResponse = await getAgentAttachmentRoute(
    new Request(`${endpoint}/${first.data.ref}`, {
      headers: { authorization: `Bearer ${viewerCredential.token}` },
    }),
    metadataContext,
  );
  assert.equal(metadataResponse.status, 200);
  const contentResponse = await getAgentAttachmentContentRoute(
    new Request(first.data.links.original, {
      headers: {
        authorization: `Bearer ${viewerCredential.token}`,
        range: "bytes=0-7",
      },
    }),
    metadataContext,
  );
  assert.equal(contentResponse.status, 206);
  assert.equal(new TextDecoder().decode(await contentResponse.arrayBuffer()), "%PDF-1.7");

  const hidden = await getAgentAttachmentRoute(
    new Request(`${endpoint}/${first.data.ref}`, {
      headers: { authorization: `Bearer ${outsiderCredential.token}` },
    }),
    metadataContext,
  );
  assert.equal(hidden.status, 404);
  const deleted = await deleteAgentAttachmentRoute(
    new Request(`${endpoint}/${first.data.ref}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${ownerCredential.token}`,
        "x-attachment-version": String(first.data.version),
      },
    }),
    metadataContext,
  );
  assert.equal(deleted.status, 200);
  const deletedBody = (await deleted.json()) as { data: { state: string } };
  assert.equal(deletedBody.data.state, "deleted");
  const viewerDeletedList = await listAgentAttachmentsRoute(
    new Request(`${endpoint}?include_deleted=true`, {
      headers: { authorization: `Bearer ${viewerCredential.token}` },
    }),
    context,
  );
  assert.equal(viewerDeletedList.status, 403);
  assert.equal((await getAgentTaskDetail(owner, task.publicId)).contextHints.attachmentCount, 1);

  let mcpDownloads = 0;
  t.mock.method(globalThis, "fetch", async (request: RequestInfo | URL) => {
    mcpDownloads += 1;
    assert.equal(
      request instanceof Request ? request.url : String(request),
      "https://files.openaiusercontent.com/uploads/mcp.pdf",
    );
    return new Response("%PDF-1.7\nmcp\n%%EOF", {
      headers: { "content-type": "application/pdf" },
    });
  });
  const mcpEndpoint = "https://example.test/api/mcp";
  const mcpHeaders = {
    authorization: `Bearer ${ownerCredential.token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const deniedUpload = await mcpPost(
    new Request(mcpEndpoint, {
      method: "POST",
      headers: {
        ...mcpHeaders,
        authorization: `Bearer ${viewerCredential.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "upload_task_attachment",
          arguments: {
            taskRef: task.publicId,
            file: {
              download_url:
                "https://files.openaiusercontent.com/uploads/mcp.pdf",
              file_id: "file_mcp_denied",
              mime_type: "application/pdf",
              file_name: "denied.pdf",
            },
            idempotencyKey: "mcp-viewer-denied",
          },
        },
      }),
    }),
  );
  const deniedResult = await mcpResult(deniedUpload);
  assert.equal(deniedResult.result.isError, true);
  assert.equal(mcpDownloads, 0);
  const mcpUpload = await mcpPost(
    new Request(mcpEndpoint, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "upload_task_attachment",
          arguments: {
            taskRef: task.publicId,
            file: {
              download_url:
                "https://files.openaiusercontent.com/uploads/mcp.pdf",
              file_id: "file_mcp_attachment",
              mime_type: "application/pdf",
              file_name: "mcp.pdf",
            },
            idempotencyKey: "mcp-agent-upload",
          },
        },
      }),
    }),
  );
  assert.equal(mcpUpload.status, 200);
  const uploadResult = await mcpResult(mcpUpload);
  const uploaded = uploadResult.result.structuredContent.data as {
    ref: string;
    filename: string;
  };
  assert.equal(uploaded.filename, "mcp.pdf");
  assert.equal(mcpDownloads, 1);

  const mcpList = await mcpPost(
    new Request(mcpEndpoint, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "list_task_attachments",
          arguments: { taskRef: task.publicId, limit: 10 },
        },
      }),
    }),
  );
  const listResult = await mcpResult(mcpList);
  const listedAttachments = listResult.result.structuredContent.data as Array<{
    ref: string;
  }>;
  assert.ok(listedAttachments.some((attachment) => attachment.ref === uploaded.ref));
});

async function mcpResult(response: Response) {
  const text = await response.text();
  const payload = text.startsWith("event:")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data:"))!
        .slice("data:".length)
        .trim()
    : text;
  return JSON.parse(payload) as {
    result: {
      isError?: boolean;
      structuredContent: { data: unknown };
    };
  };
}

test("attachment-aware logical backups include scoped metadata and verified originals", async () => {
  const { owner, project, task } = await setupSharedTask("Attachment backup guard");
  const attachment = await createAttachment(owner, task.id, {
    body: new TextEncoder().encode("%PDF-1.7\nbackup guard\n%%EOF"),
    filename: "guard.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "backup-guard",
  });
  const detail = await getTask(owner, task.id);
  await updateTask(owner, task.id, {
    version: detail.version,
    description: buildTaskFileLink(attachment.publicId, "Backup guard PDF"),
  });
  const projectBackup = await exportProjectBackup(
    owner,
    project.id,
    "https://example.test",
  );
  assert.equal(projectBackup.schemaVersion, 12);
  assert.equal(projectBackup.tables.attachments.length, 1);
  assert.equal(projectBackup.objects.length, 1);
  assert.match(String(projectBackup.tables.attachments[0]?.object_key), /^sha256:/);
  assert.match(String(projectBackup.tables.tasks[0]?.description), /\[Backup guard PDF\]\(attachment:v1:/);
  assert.equal(JSON.stringify(projectBackup).includes("uat/attachments/"), false);
  const validPreview = await stageProjectBackup(owner, projectBackup, "https://example.test");
  assert.equal(validPreview.counts.attachments, 1);
  const corrupted = structuredClone(projectBackup);
  corrupted.objects[0]!.data = `${corrupted.objects[0]!.data.slice(0, -4)}AAAA`;
  await assert.rejects(
    stageProjectBackup(owner, corrupted, "https://example.test"),
    /checksum|size/i,
  );

  const systemBackup = await exportSystemBackup(owner);
  assert.equal(systemBackup.schemaVersion, 12);
  assert.ok(systemBackup.tables.attachments.length >= 1);
  assert.ok(systemBackup.objects.length >= 1);
});

test("failed project cutover compensates new objects and keeps live originals", async () => {
  const { owner, project, task } = await setupSharedTask(
    "Attachment restore compensation",
  );
  const bytes = new TextEncoder().encode("%PDF-1.7\ncompensate\n%%EOF");
  const attachment = await createAttachment(owner, task.id, {
    body: bytes,
    filename: "compensate.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "compensate-pdf",
  });
  const backup = await exportProjectBackup(
    owner,
    project.id,
    "https://example.test",
  );
  const preview = await stageProjectBackup(
    owner,
    backup,
    "https://example.test",
  );
  const stagedProject = await database
    .prepare(`SELECT row_json FROM user_import_rows
      WHERE import_id = ? AND row_type = 'projects' LIMIT 1`)
    .bind(preview.importId)
    .first<{ row_json: string }>();
  const invalidProject = JSON.parse(stagedProject!.row_json) as Record<
    string,
    unknown
  >;
  invalidProject.name = null;
  await database
    .prepare(`UPDATE user_import_rows SET row_json = ?
      WHERE import_id = ? AND row_type = 'projects'`)
    .bind(JSON.stringify(invalidProject), preview.importId)
    .run();
  const beforeKeys = (
    await bucket.list({ prefix: "test/attachments/" })
  ).objects.map((item) => item.key).sort();

  await assert.rejects(
    applyProjectBackup(owner, {
      importId: preview.importId,
      sha256: preview.sha256,
      confirmation: project.name,
      currentBackupDownloaded: true,
      restoreSharing: true,
    }),
    /not null constraint/i,
  );
  const afterKeys = (
    await bucket.list({ prefix: "test/attachments/" })
  ).objects.map((item) => item.key).sort();
  assert.deepEqual(afterKeys, beforeKeys);
  assert.ok(await bucket.head(attachment.objectKey));
  assert.equal(
    await database
      .prepare("SELECT status FROM user_import_sessions WHERE id = ?")
      .bind(preview.importId)
      .first<{ status: string }>()
      .then((row) => row?.status),
    "staged",
  );
});

test("attachment quotas fail closed without exposing another owner's usage", async () => {
  const { owner, task } = await setupSharedTask("Attachment quota");
  const environment = getRuntimeEnvironment();
  const previousOwnerLimit = environment.TASK_MANAGER_ATTACHMENT_MAX_OWNER_BYTES;
  const previousProjectLimit = environment.TASK_MANAGER_ATTACHMENT_MAX_PROJECT_BYTES;
  try {
    environment.TASK_MANAGER_ATTACHMENT_MAX_OWNER_BYTES = "1";
    environment.TASK_MANAGER_ATTACHMENT_MAX_PROJECT_BYTES = "999999";
    await assert.rejects(
      createAttachment(owner, task.id, {
        body: new TextEncoder().encode("%PDF-1.7\nquota\n%%EOF"),
        filename: "quota.pdf",
        claimedMediaType: "application/pdf",
        idempotencyKey: "owner-quota",
      }),
      /storage quota/i,
    );

    environment.TASK_MANAGER_ATTACHMENT_MAX_OWNER_BYTES = "999999";
    environment.TASK_MANAGER_ATTACHMENT_MAX_PROJECT_BYTES = "1";
    await assert.rejects(
      createAttachment(owner, task.id, {
        body: new TextEncoder().encode("%PDF-1.7\nproject quota\n%%EOF"),
        filename: "project-quota.pdf",
        claimedMediaType: "application/pdf",
        idempotencyKey: "project-quota",
      }),
      /storage quota/i,
    );
  } finally {
    environment.TASK_MANAGER_ATTACHMENT_MAX_OWNER_BYTES = previousOwnerLimit;
    environment.TASK_MANAGER_ATTACHMENT_MAX_PROJECT_BYTES = previousProjectLimit;
  }
});

test("reconciliation reports missing, orphan, and broken refs without file content", async () => {
  const { owner, task } = await setupSharedTask("Attachment reconciliation");
  const bytes = new TextEncoder().encode("%PDF-1.7\nreconcile\n%%EOF");
  const attachment = await createAttachment(owner, task.id, {
    body: bytes,
    filename: "reconcile.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "reconcile-pdf",
  });
  await bucket.delete(attachment.objectKey);
  await bucket.put("test/attachments/orphan-smoke", bytes);
  await bucket.put("test/backup-staging/orphan-smoke/checksum", bytes);
  await database
    .prepare("UPDATE tasks SET description = ? WHERE id = ?")
    .bind("![Missing](attachment:v1:missing-ref)", task.id)
    .run();

  const report = await reconcileAttachmentStorage(owner, {
    verifyChecksums: true,
  });
  assert.ok(report.missingObjectRefs.includes(attachment.publicId));
  assert.ok(report.orphanObjectCount !== null);
  assert.ok(report.orphanObjectCount >= 2);
  assert.ok(
    report.brokenDescriptionRefs.some(
      (item) => item.taskRef === task.publicId && item.attachmentRef === "missing-ref",
    ),
  );
  assert.equal(JSON.stringify(report).includes("reconcile.pdf"), false);
  assert.equal(JSON.stringify(report).includes("%PDF"), false);

  await bucket.put(attachment.objectKey, bytes);
  await bucket.delete("test/attachments/orphan-smoke");
  await bucket.delete("test/backup-staging/orphan-smoke/checksum");
  await database.prepare("UPDATE tasks SET description = '' WHERE id = ?")
    .bind(task.id).run();
});

test("system backup rejects another Site or attachment environment before staging", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const backup = await exportSystemBackup(owner);
  const foreignSite = await createSystemBackup(
    backup.tables,
    backup.exportedAt,
    backup.objects,
    "https://foreign.example.test",
    backup.environmentScope ?? "test",
  );
  await assert.rejects(
    stageSystemBackup(owner, foreignSite),
    /another Task Manager Site/i,
  );
  const foreignEnvironment = await createSystemBackup(
    backup.tables,
    backup.exportedAt,
    backup.objects,
    backup.siteOrigin ?? "https://local.task-manager.invalid",
    "production",
  );
  await assert.rejects(
    stageSystemBackup(owner, foreignEnvironment),
    /another attachment environment/i,
  );
});

test("project and system restore stage attachment objects before exact D1 cutover", async () => {
  const { owner, viewer, outsider, project, task } = await setupSharedTask("Attachment restore");
  const bytes = new TextEncoder().encode("%PDF-1.7\nrestore bytes\n%%EOF");
  const attachment = await createAttachment(owner, task.id, {
    body: bytes,
    filename: "restore.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "restore-pdf",
  });

  const projectBackup = await exportProjectBackup(
    owner,
    project.id,
    "https://example.test",
  );
  const projectPreview = await stageProjectBackup(
    owner,
    projectBackup,
    "https://example.test",
  );
  await bucket.put(attachment.objectKey, new TextEncoder().encode("corrupted"));
  await applyProjectBackup(owner, {
    importId: projectPreview.importId,
    sha256: projectPreview.sha256,
    confirmation: project.name,
    currentBackupDownloaded: true,
    restoreSharing: true,
  });
  const restoredProjectAttachment = (
    await listTaskAttachments(owner, task.id)
  ).items.find((item) => item.publicId === attachment.publicId)!;
  const projectContent = await getAttachmentContent(
    owner,
    task.id,
    restoredProjectAttachment.publicId,
    { preview: false },
  );
  assert.deepEqual(
    new Uint8Array(await projectContent.arrayBuffer()),
    bytes,
  );
  assert.notEqual(restoredProjectAttachment.objectKey, attachment.objectKey);
  assert.equal(
    (await getAttachmentContent(viewer, task.id, attachment.publicId, {
      preview: false,
    })).status,
    200,
  );
  await assert.rejects(
    getAttachmentContent(outsider, task.id, attachment.publicId, {
      preview: false,
    }),
    NotFoundError,
  );

  const systemBackup = await exportSystemBackup(owner);
  const systemPreview = await stageSystemBackup(owner, systemBackup);
  await bucket.put(
    restoredProjectAttachment.objectKey,
    new TextEncoder().encode("corrupted again"),
  );
  const stagedProject = await database.prepare(`SELECT ordinal, row_json
    FROM admin_import_rows WHERE import_id = ? AND table_name = 'projects'
    ORDER BY ordinal LIMIT 1`).bind(systemPreview.importId)
    .first<{ ordinal: number; row_json: string }>();
  const invalidProject = JSON.parse(stagedProject!.row_json) as Record<string, unknown>;
  invalidProject.name = null;
  await database.prepare(`UPDATE admin_import_rows SET row_json = ?
    WHERE import_id = ? AND table_name = 'projects' AND ordinal = ?`)
    .bind(JSON.stringify(invalidProject), systemPreview.importId, stagedProject!.ordinal)
    .run();
  const beforeFailedApply = (
    await bucket.list({ prefix: "test/attachments/" })
  ).objects.map((item) => item.key).sort();
  await assert.rejects(
    applySystemBackup(owner, {
      importId: systemPreview.importId,
      sha256: systemPreview.sha256,
      confirmation: "RESTORE",
    }),
    /not null constraint/i,
  );
  assert.deepEqual(
    (await bucket.list({ prefix: "test/attachments/" })).objects
      .map((item) => item.key).sort(),
    beforeFailedApply,
  );
  assert.equal(
    await database.prepare("SELECT status FROM admin_import_sessions WHERE id = ?")
      .bind(systemPreview.importId).first<{ status: string }>()
      .then((row) => row?.status),
    "staged",
  );
  await database.prepare(`UPDATE admin_import_rows SET row_json = ?
    WHERE import_id = ? AND table_name = 'projects' AND ordinal = ?`)
    .bind(stagedProject!.row_json, systemPreview.importId, stagedProject!.ordinal)
    .run();
  await applySystemBackup(owner, {
    importId: systemPreview.importId,
    sha256: systemPreview.sha256,
    confirmation: "RESTORE",
  });
  const restoredSystemAttachment = (
    await listTaskAttachments(owner, task.id)
  ).items.find((item) => item.publicId === attachment.publicId)!;
  const systemContent = await getAttachmentContent(
    owner,
    task.id,
    restoredSystemAttachment.publicId,
    { preview: false },
  );
  assert.deepEqual(new Uint8Array(await systemContent.arrayBuffer()), bytes);
  assert.notEqual(
    restoredSystemAttachment.objectKey,
    restoredProjectAttachment.objectKey,
  );
  assert.equal(
    (await getAttachmentContent(viewer, task.id, attachment.publicId, {
      preview: false,
    })).status,
    200,
  );
  await assert.rejects(
    getAttachmentContent(outsider, task.id, attachment.publicId, {
      preview: false,
    }),
    NotFoundError,
  );
});
