import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  bindStoredFileToTask,
  createStoredFile,
  deleteStoredFile,
  getStoredFile,
  purgeStoredFileGarbage,
} from "../lib/attachments";
import { ConflictError, NotFoundError, ValidationError } from "../lib/domain";
import {
  createProject,
  createTask,
  getOrCreateUser,
  getSnapshot,
  getTask,
  grantAccess,
} from "../lib/repository";
import { getRuntimeEnvironment } from "../lib/runtime-environment";
import { scanAttachmentStorageOwnership } from "../lib/attachment-storage-audit";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "stored-file-owner",
  displayName: "Stored File Owner",
  email: "stored-file-owner@example.test",
};
const editorActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "stored-file-editor",
  displayName: "Stored File Editor",
  email: "stored-file-editor@example.test",
};
const outsiderActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "stored-file-outsider",
  displayName: "Stored File Outsider",
  email: "stored-file-outsider@example.test",
};

let dispose: (() => Promise<void>) | undefined;
let database: D1Database;
let bucket: R2Bucket;

before(async () => {
  const harness = await createD1TestHarness({
    TASK_MANAGER_ATTACHMENT_SCOPE: "stored-file-test",
    TASK_MANAGER_ATTACHMENT_MAX_BYTES: "4096",
    TASK_MANAGER_ATTACHMENT_MAX_COUNT: "4",
    TASK_MANAGER_STORED_FILE_MAX_COUNT: "20",
    TASK_MANAGER_STORED_FILE_MAX_BYTES: "8192",
    TASK_MANAGER_STORED_FILE_READY_TTL_SECONDS: "60",
    TASK_MANAGER_ATTACHMENT_DELETE_GRACE_SECONDS: "1",
    TASK_MANAGER_ATTACHMENT_FAILED_RETENTION_SECONDS: "1",
  }, { r2: true });
  database = harness.database;
  bucket = harness.attachmentBucket!;
  dispose = harness.dispose;
});

after(async () => dispose?.());

async function setupProject(name: string, code: string) {
  const owner = await getOrCreateUser(ownerActor);
  const editor = await getOrCreateUser(editorActor);
  const outsider = await getOrCreateUser(outsiderActor);
  await createProject(owner, { name, taskCode: code });
  const project = (await getSnapshot(owner)).projects.find((item) => item.name === name)!;
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: editor.email,
    permission: "editor",
  });
  const first = await createTask(owner, { title: `${name} first`, projectId: project.id });
  const second = await createTask(owner, { title: `${name} second`, projectId: project.id });
  return { owner, editor, outsider, project, first, second };
}

const pdf = (label: string) => new TextEncoder().encode(`%PDF-1.7\n${label}\n%%EOF`);

test("StoredFile upload is uploader-scoped, byte-idempotent, and uses opaque storage", async () => {
  const { owner, outsider } = await setupProject("Stored upload", "SFU");
  const created = await createStoredFile(owner, {
    body: pdf("foundation"),
    filename: "private/foundation.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "stored-upload-foundation",
  });

  assert.equal(created.state, "ready");
  assert.equal(created.displayName, "foundation.pdf");
  assert.equal(created.mediaType, "application/pdf");
  assert.match(created.publicId, /^[0-9a-f-]{36}$/);
  assert.match(created.objectKey, /^stored-file-test\/stored-files\/[0-9a-f-]{36}$/);
  assert.ok(await bucket.head(created.objectKey));
  assert.equal((await scanAttachmentStorageOwnership(database)).orphanObjectCount, 0);

  const retry = await createStoredFile(owner, {
    body: pdf("foundation"),
    filename: "private/foundation.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "stored-upload-foundation",
  });
  assert.equal(retry.publicId, created.publicId);

  await assert.rejects(
    createStoredFile(owner, {
      body: pdf("changed"),
      filename: "private/foundation.pdf",
      claimedMediaType: "application/pdf",
      idempotencyKey: "stored-upload-foundation",
    }),
    ConflictError,
  );
  await assert.rejects(getStoredFile(outsider, created.publicId), NotFoundError);
});

test("binding transfers StoredFile to Task ACL and enforces one v1 binding", async () => {
  const { owner, editor, outsider, first, second } = await setupProject("Stored bind", "SFB");
  const stored = await createStoredFile(owner, {
    body: pdf("bind"),
    filename: "bind.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "stored-bind-upload",
  });
  const attachment = await bindStoredFileToTask(owner, first.id, stored.publicId, {
    idempotencyKey: "stored-bind-first",
  });

  assert.equal(attachment.storedFileId, stored.id);
  assert.equal(attachment.publicId.length, 36);
  assert.equal((await getStoredFile(editor, stored.publicId)).publicId, stored.publicId);
  await assert.rejects(getStoredFile(outsider, stored.publicId), NotFoundError);

  const retry = await bindStoredFileToTask(owner, first.id, stored.publicId, {
    idempotencyKey: "stored-bind-first",
  });
  assert.equal(retry.publicId, attachment.publicId);
  await assert.rejects(
    bindStoredFileToTask(owner, second.id, stored.publicId, {
      idempotencyKey: "stored-bind-second",
    }),
    ConflictError,
  );
  await assert.rejects(deleteStoredFile(owner, stored.publicId, stored.version), ConflictError);

  const task = await getTask(editor, first.id);
  assert.equal(task.id, first.id);
});

test("bind-time quotas fail closed and leave the staged StoredFile reusable", async () => {
  const { owner, first } = await setupProject("Stored quota", "SFQ");
  const stored = await createStoredFile(owner, {
    body: pdf("quota"),
    filename: "quota.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "stored-quota-upload",
  });
  const env = getRuntimeEnvironment();
  const previous = env.TASK_MANAGER_ATTACHMENT_MAX_PROJECT_BYTES;
  env.TASK_MANAGER_ATTACHMENT_MAX_PROJECT_BYTES = "1";
  try {
    await assert.rejects(
      bindStoredFileToTask(owner, first.id, stored.publicId, {
        idempotencyKey: "stored-quota-bind",
      }),
      ValidationError,
    );
  } finally {
    env.TASK_MANAGER_ATTACHMENT_MAX_PROJECT_BYTES = previous;
  }
  assert.equal((await getStoredFile(owner, stored.publicId)).state, "ready");
});

test("concurrent binds commit one TaskAttachment without a dangling object", async () => {
  const { owner, first, second } = await setupProject("Stored bind race", "SFR");
  const stored = await createStoredFile(owner, {
    body: pdf("race"),
    filename: "race.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "stored-race-upload",
  });
  const outcomes = await Promise.allSettled([
    bindStoredFileToTask(owner, first.id, stored.publicId, {
      idempotencyKey: "stored-race-first",
    }),
    bindStoredFileToTask(owner, second.id, stored.publicId, {
      idempotencyKey: "stored-race-second",
    }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal(
    await database.prepare("SELECT COUNT(*) AS count FROM attachments WHERE stored_file_id = ?")
      .bind(stored.id).first<{ count: number }>().then((row) => Number(row?.count ?? 0)),
    1,
  );
  assert.ok(await bucket.head(stored.objectKey));
});

test("concurrent bind and recoverable delete choose one lifecycle owner", async () => {
  const { owner, first } = await setupProject("Stored delete race", "SFD");
  const stored = await createStoredFile(owner, {
    body: pdf("delete-race"),
    filename: "delete-race.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "stored-delete-race-upload",
  });
  const outcomes = await Promise.allSettled([
    bindStoredFileToTask(owner, first.id, stored.publicId, {
      idempotencyKey: "stored-delete-race-bind",
    }),
    deleteStoredFile(owner, stored.publicId, stored.version),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const row = await database.prepare(
    `SELECT sf.state, COUNT(a.id) AS bindings
     FROM stored_files sf LEFT JOIN attachments a ON a.stored_file_id = sf.id
     WHERE sf.id = ? GROUP BY sf.id`,
  ).bind(stored.id).first<{ state: string; bindings: number }>();
  assert.ok(row);
  assert.ok(
    (row!.state === "ready" && Number(row!.bindings) === 1) ||
      (row!.state === "deleted" && Number(row!.bindings) === 0),
  );
  assert.ok(await bucket.head(stored.objectKey));
});

test("unbound ready files expire without touching bound attachments", async () => {
  const { owner, first } = await setupProject("Stored cleanup", "SFC");
  const expired = await createStoredFile(owner, {
    body: pdf("expire"),
    filename: "expire.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "stored-expire-upload",
  });
  const bound = await createStoredFile(owner, {
    body: pdf("bound"),
    filename: "bound.pdf",
    claimedMediaType: "application/pdf",
    idempotencyKey: "stored-bound-upload",
  });
  await bindStoredFileToTask(owner, first.id, bound.publicId, {
    idempotencyKey: "stored-bound-bind",
  });
  await database.prepare(
    "UPDATE stored_files SET ready_expires_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
  ).bind(expired.id).run();

  const cleanup = await purgeStoredFileGarbage(new Date("2026-01-01T00:01:01.000Z"));
  assert.equal(cleanup.expired, 1);
  assert.equal(await bucket.head(expired.objectKey), null);
  assert.ok(await bucket.head(bound.objectKey));
  await assert.rejects(getStoredFile(owner, expired.publicId), NotFoundError);
  assert.equal((await getStoredFile(owner, bound.publicId)).state, "ready");
});
