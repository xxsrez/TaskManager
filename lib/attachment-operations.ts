import { getAttachmentBucket, getD1 } from "@/db";
import { assertAdmin } from "./admin";
import { attachmentLimits } from "./attachments";
import { scanAttachmentStorageOwnership } from "./attachment-storage-audit";
import { getRuntimeEnvironment } from "./runtime-environment";
import { parseTaskAttachmentReferences } from "./task-description-format";
import type { UserRecord } from "./types";

type DbRow = Record<string, unknown>;

export type AttachmentIntegrityReport = {
  generatedAt: string;
  truncated: boolean;
  metadataCount: number;
  objectCount: number;
  totalBytes: number;
  missingObjectRefs: string[];
  orphanObjectCount: number | null;
  sizeMismatchRefs: string[];
  checksumMismatchRefs: string[];
  stalePendingRefs: string[];
  staleUploadingRefs: string[];
  staleFailedRefs: string[];
  expiredDeletedRefs: string[];
  brokenDescriptionRefs: Array<{ taskRef: string; attachmentRef: string }>;
  ownerUsage: Array<{
    ownerUserId: string;
    attachmentCount: number;
    totalBytes: number;
  }>;
  projectUsage: Array<{
    projectRef: string;
    attachmentCount: number;
    totalBytes: number;
  }>;
};

export async function reconcileAttachmentStorage(
  currentUser: UserRecord,
  options: { verifyChecksums?: boolean; maxObjects?: number } = {},
): Promise<AttachmentIntegrityReport> {
  assertConfiguredAdmin(currentUser);
  const maxObjects = Math.min(
    10_000,
    Math.max(1, Math.trunc(options.maxObjects ?? 2_000)),
  );
  const now = new Date();
  const limits = attachmentLimits();
  const deletedCutoff = new Date(
    now.getTime() - limits.deleteGraceSeconds * 1_000,
  ).toISOString();
  const failedCutoff = new Date(
    now.getTime() - limits.failedRetentionSeconds * 1_000,
  ).toISOString();
  const db = getD1();
  const [results, storage] = await Promise.all([
    db.batch([
    db.prepare(`SELECT id, public_id, task_id, object_key, byte_size,
      checksum_sha256, kind, state, upload_expires_at, updated_at, deleted_at
      FROM attachments ORDER BY id LIMIT ?`).bind(maxObjects + 1),
    db.prepare(`SELECT id, public_id, description FROM tasks
      WHERE instr(description, 'attachment:v1:') > 0 ORDER BY id LIMIT ?`)
      .bind(maxObjects + 1),
    db.prepare(`SELECT COALESCE(p.owner_user_id, t.owner_user_id) AS owner_user_id,
      COUNT(*) AS attachment_count, COALESCE(SUM(a.byte_size), 0) AS total_bytes
      FROM attachments a JOIN tasks t ON t.id = a.task_id
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE a.state IN ('pending', 'uploading', 'ready')
      GROUP BY COALESCE(p.owner_user_id, t.owner_user_id)
      ORDER BY owner_user_id LIMIT ?`).bind(maxObjects + 1),
    db.prepare(`SELECT p.public_id AS project_ref,
      COUNT(*) AS attachment_count, COALESCE(SUM(a.byte_size), 0) AS total_bytes
      FROM attachments a JOIN tasks t ON t.id = a.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE a.state IN ('pending', 'uploading', 'ready')
      GROUP BY p.id, p.public_id ORDER BY p.id LIMIT ?`).bind(maxObjects + 1),
    ]),
    scanAttachmentStorageOwnership(db, maxObjects),
  ]);
  const [attachments, tasks, ownerUsageRows, projectUsageRows] = results;

  const metadataRows = (attachments.results as DbRow[]).slice(0, maxObjects);
  const missingObjectRefs: string[] = [];
  const sizeMismatchRefs: string[] = [];
  const checksumMismatchRefs: string[] = [];
  for (const row of metadataRows) {
    if (row.state !== "ready" && row.state !== "deleted") continue;
    const object = await getAttachmentBucket().head(String(row.object_key));
    if (!object) {
      missingObjectRefs.push(String(row.public_id));
      continue;
    }
    if (object.size !== Number(row.byte_size)) {
      sizeMismatchRefs.push(String(row.public_id));
    }
    if (options.verifyChecksums) {
      const body = await getAttachmentBucket().get(object.key);
      if (
        !body ||
        (await sha256Hex(new Uint8Array(await body.arrayBuffer()))) !==
          String(row.checksum_sha256)
      ) {
        checksumMismatchRefs.push(String(row.public_id));
      }
    }
  }

  const attachmentsByTask = new Map<string, Map<string, DbRow>>();
  for (const row of metadataRows) {
    const taskId = String(row.task_id);
    const index = attachmentsByTask.get(taskId) ?? new Map<string, DbRow>();
    index.set(String(row.public_id), row);
    attachmentsByTask.set(taskId, index);
  }
  const brokenDescriptionRefs: Array<{
    taskRef: string;
    attachmentRef: string;
  }> = [];
  for (const task of (tasks.results as DbRow[]).slice(0, maxObjects)) {
    for (const reference of parseTaskAttachmentReferences(String(task.description))) {
      const attachment = attachmentsByTask
        .get(String(task.id))
        ?.get(reference.ref);
      if (
        !attachment ||
        attachment.state !== "ready" ||
        (reference.kind === "image" && attachment.kind !== "image")
      ) {
        brokenDescriptionRefs.push({
          taskRef: String(task.public_id),
          attachmentRef: reference.ref,
        });
      }
    }
  }

  return {
    generatedAt: now.toISOString(),
    truncated:
      attachments.results.length > maxObjects ||
      tasks.results.length > maxObjects ||
      ownerUsageRows.results.length > maxObjects ||
      projectUsageRows.results.length > maxObjects ||
      storage.truncated,
    metadataCount: metadataRows.length,
    objectCount: storage.objectCount,
    totalBytes: storage.objectBytes,
    missingObjectRefs,
    orphanObjectCount: storage.orphanObjectCount,
    sizeMismatchRefs,
    checksumMismatchRefs,
    stalePendingRefs: metadataRows
      .filter(
        (row) =>
          row.state === "pending" &&
          typeof row.upload_expires_at === "string" &&
          row.upload_expires_at <= now.toISOString(),
      )
      .map((row) => String(row.public_id)),
    staleUploadingRefs: metadataRows
      .filter(
        (row) =>
          row.state === "uploading" &&
          typeof row.upload_expires_at === "string" &&
          row.upload_expires_at <= now.toISOString(),
      )
      .map((row) => String(row.public_id)),
    staleFailedRefs: metadataRows
      .filter(
        (row) => row.state === "failed" && String(row.updated_at) <= failedCutoff,
      )
      .map((row) => String(row.public_id)),
    expiredDeletedRefs: metadataRows
      .filter(
        (row) =>
          row.state === "deleted" &&
          typeof row.deleted_at === "string" &&
          row.deleted_at <= deletedCutoff,
      )
      .map((row) => String(row.public_id)),
    brokenDescriptionRefs,
    ownerUsage: (ownerUsageRows.results as DbRow[])
      .slice(0, maxObjects)
      .map((row) => ({
        ownerUserId: String(row.owner_user_id),
        attachmentCount: Number(row.attachment_count),
        totalBytes: Number(row.total_bytes),
      })),
    projectUsage: (projectUsageRows.results as DbRow[])
      .slice(0, maxObjects)
      .map((row) => ({
        projectRef: String(row.project_ref),
        attachmentCount: Number(row.attachment_count),
        totalBytes: Number(row.total_bytes),
      })),
  };
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function assertConfiguredAdmin(user: UserRecord) {
  assertAdmin(
    user,
    getRuntimeEnvironment().TASK_MANAGER_ADMIN_EMAILS ?? "",
  );
}
