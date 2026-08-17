import { canEditContent } from "./access";
import { getAttachmentBucket, getD1 } from "@/db";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from "./domain";
import { getTask } from "./repository";
import { getRuntimeEnvironment } from "./runtime-environment";
import type {
  AttachmentKind,
  AttachmentRecord,
  AttachmentState,
  UserRecord,
} from "./types";

type DbRow = Record<string, unknown>;

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_COUNT = 50;
const DEFAULT_MAX_IMAGE_PIXELS = 40_000_000;
const DEFAULT_UPLOAD_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_DELETE_GRACE_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_FAILED_RETENTION_SECONDS = 24 * 60 * 60;
const CLEANUP_BATCH_SIZE = 100;

export type CreateAttachmentInput = {
  body: ArrayBuffer | Uint8Array;
  filename: string;
  claimedMediaType?: string | null;
  idempotencyKey: string;
};

export type AttachmentContentOptions = {
  rangeHeader?: string | null;
  preview: boolean;
  variant?: "original" | "thumbnail";
};

export function publicAttachment(record: AttachmentRecord) {
  return {
    ref: record.publicId,
    taskId: record.taskId,
    uploaderUserId: record.uploaderUserId,
    filename: record.displayName,
    mediaType: record.mediaType,
    byteSize: record.byteSize,
    checksumSha256: record.checksumSha256,
    kind: record.kind,
    state: record.state,
    imageWidth: record.imageWidth,
    imageHeight: record.imageHeight,
    variants: record.variants,
    failureCode: record.failureCode,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deletedAt: record.deletedAt,
  };
}

export async function readBoundedAttachmentBody(
  request: Request,
  maxBytes = attachmentLimits().maxBytes,
) {
  const declared = request.headers.get("content-length");
  if (declared) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw new ValidationError(`File exceeds the ${maxBytes} byte limit`);
    }
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("Attachment size limit exceeded");
      throw new ValidationError(`File exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

type InspectedContent = {
  mediaType: string;
  kind: AttachmentKind;
  width: number | null;
  height: number | null;
};

export function attachmentLimits() {
  const env = getRuntimeEnvironment();
  return {
    maxBytes: configuredPositiveInteger(
      env.TASK_MANAGER_ATTACHMENT_MAX_BYTES,
      DEFAULT_MAX_BYTES,
    ),
    maxCount: configuredPositiveInteger(
      env.TASK_MANAGER_ATTACHMENT_MAX_COUNT,
      DEFAULT_MAX_COUNT,
    ),
    maxImagePixels: configuredPositiveInteger(
      env.TASK_MANAGER_ATTACHMENT_MAX_IMAGE_PIXELS,
      DEFAULT_MAX_IMAGE_PIXELS,
    ),
    uploadTimeoutSeconds: configuredPositiveInteger(
      env.TASK_MANAGER_ATTACHMENT_UPLOAD_TIMEOUT_SECONDS,
      DEFAULT_UPLOAD_TIMEOUT_SECONDS,
    ),
    deleteGraceSeconds: configuredPositiveInteger(
      env.TASK_MANAGER_ATTACHMENT_DELETE_GRACE_SECONDS,
      DEFAULT_DELETE_GRACE_SECONDS,
    ),
    failedRetentionSeconds: configuredPositiveInteger(
      env.TASK_MANAGER_ATTACHMENT_FAILED_RETENTION_SECONDS,
      DEFAULT_FAILED_RETENTION_SECONDS,
    ),
  };
}

export async function createAttachment(
  currentUser: UserRecord,
  taskId: string,
  input: CreateAttachmentInput,
): Promise<AttachmentRecord> {
  const task = await getTask(currentUser, taskId);
  if (!canEditContent(task.accessRole)) {
    throw new PermissionError("Editor access is required");
  }

  const limits = attachmentLimits();
  const bytes = new Uint8Array(input.body);
  if (bytes.byteLength === 0) throw new ValidationError("File is empty");
  if (bytes.byteLength > limits.maxBytes) {
    throw new ValidationError(`File exceeds the ${limits.maxBytes} byte limit`);
  }
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const names = normalizeFilenames(input.filename);
  const inspected = inspectContent(
    bytes,
    input.claimedMediaType,
    limits.maxImagePixels,
  );
  const checksumSha256 = await sha256Hex(bytes);
  const duplicate = await findIdempotentAttachment(
    task.id,
    currentUser.id,
    idempotencyKey,
  );
  if (duplicate) {
    if (duplicate.checksumSha256 !== checksumSha256) {
      throw new ConflictError("Idempotency key was already used for another file");
    }
    return duplicate;
  }

  const bucket = getAttachmentBucket();
  const now = new Date();
  const attachmentId = `attachment_${crypto.randomUUID()}`;
  const publicId = crypto.randomUUID();
  const objectKey = `${attachmentScope()}/attachments/${crypto.randomUUID()}`;
  const createdAt = now.toISOString();
  const uploadExpiresAt = new Date(
    now.getTime() + limits.uploadTimeoutSeconds * 1_000,
  ).toISOString();
  const db = getD1();

  try {
    const inserted = await db
      .prepare(
        `INSERT INTO attachments (
           id, public_id, task_id, uploader_user_id,
           original_filename, display_name, media_type, byte_size,
           checksum_sha256, object_key, kind, state,
           image_width, image_height, variant_metadata_json,
           idempotency_key, upload_expires_at, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, '{}', ?, ?, ?, ?
         WHERE (
           SELECT COUNT(*) FROM attachments
           WHERE task_id = ? AND state IN ('pending', 'uploading', 'ready')
         ) < ?
         RETURNING id`,
      )
      .bind(
        attachmentId,
        publicId,
        task.id,
        currentUser.id,
        names.originalFilename,
        names.displayName,
        inspected.mediaType,
        bytes.byteLength,
        checksumSha256,
        objectKey,
        inspected.kind,
        inspected.width,
        inspected.height,
        idempotencyKey,
        uploadExpiresAt,
        createdAt,
        createdAt,
        task.id,
        limits.maxCount,
      )
      .first<{ id: string }>();
    if (!inserted) {
      throw new ValidationError(
        `Task already has the maximum of ${limits.maxCount} attachments`,
      );
    }
  } catch (error) {
    const raced = await findIdempotentAttachment(
      task.id,
      currentUser.id,
      idempotencyKey,
    );
    if (raced) {
      if (raced.checksumSha256 !== checksumSha256) {
        throw new ConflictError("Idempotency key was already used for another file");
      }
      return raced;
    }
    throw error;
  }

  try {
    await bucket.put(objectKey, bytes.buffer as ArrayBuffer, {
      httpMetadata: { contentType: inspected.mediaType },
      customMetadata: {
        attachmentId,
        checksumSha256,
      },
    });
    const readyAt = new Date().toISOString();
    const ready = await db
      .prepare(
        `UPDATE attachments
         SET state = 'ready', upload_expires_at = NULL,
             version = version + 1, updated_at = ?
         WHERE id = ? AND state = 'uploading'
         RETURNING *`,
      )
      .bind(readyAt, attachmentId)
      .first<DbRow>();
    if (!ready) throw new Error("Attachment metadata changed during upload");
    return mapAttachment(ready);
  } catch (error) {
    await bucket.delete(objectKey).catch(() => undefined);
    await db
      .prepare(
        `UPDATE attachments
         SET state = 'failed', failure_code = 'storage_write_failed',
             upload_expires_at = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND state = 'uploading'`,
      )
      .bind(new Date().toISOString(), attachmentId)
      .run()
      .catch(() => undefined);
    throw error;
  }
}

export async function listTaskAttachments(
  currentUser: UserRecord,
  taskId: string,
  options: { includeDeleted?: boolean; limit?: number } = {},
) {
  const task = await getTask(currentUser, taskId);
  if (options.includeDeleted && !canEditContent(task.accessRole)) {
    throw new PermissionError("Editor access is required to list deleted attachments");
  }
  const requestedLimit = Number(options.limit ?? 50);
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.min(100, Math.max(1, requestedLimit))
    : 50;
  const statePredicate = options.includeDeleted ? "" : "AND state <> 'deleted'";
  const [rows, count] = await getD1().batch<DbRow>([
    getD1()
      .prepare(
        `SELECT * FROM attachments
         WHERE task_id = ? ${statePredicate}
         ORDER BY created_at, id LIMIT ?`,
      )
      .bind(task.id, limit),
    getD1()
      .prepare(
        `SELECT COUNT(*) AS count FROM attachments
         WHERE task_id = ? ${statePredicate}`,
      )
      .bind(task.id),
  ]);
  return {
    items: (rows.results as DbRow[]).map(mapAttachment),
    totalCount: Number((count.results[0] as DbRow | undefined)?.count ?? 0),
  };
}

export async function getAttachmentContent(
  currentUser: UserRecord,
  taskId: string,
  attachmentRef: string,
  options: AttachmentContentOptions,
): Promise<Response> {
  const task = await getTask(currentUser, taskId);
  const attachment = await loadTaskAttachment(task.id, attachmentRef);
  if (attachment.state !== "ready") {
    throw new NotFoundError("Attachment not found");
  }

  if (options.variant === "thumbnail") {
    if (attachment.kind !== "image") {
      throw new NotFoundError("Attachment thumbnail not found");
    }
    const object = await getAttachmentBucket().get(attachment.objectKey);
    if (!object) throw new NotFoundError("Attachment not found");
    const images = getRuntimeEnvironment().IMAGES;
    if (!images) throw new Error("Cloudflare Images binding `IMAGES` is unavailable.");
    const transformed = await images
      .input(object.body)
      .transform({ width: 480, height: 360, fit: "scale-down" })
      .output({ format: "image/webp", quality: 78 });
    const response = await transformed.response();
    if (!response.ok || !response.body) {
      throw new Error("Attachment thumbnail generation failed");
    }
    return new Response(response.body, {
      headers: privateContentHeaders(attachment, true, {
        "accept-ranges": "none",
        "content-type": "image/webp",
        "x-attachment-variant": "thumbnail",
      }),
    });
  }

  const range = parseRange(options.rangeHeader, attachment.byteSize);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: privateContentHeaders(attachment, options.preview, {
        "content-range": `bytes */${attachment.byteSize}`,
      }),
    });
  }
  const object = await getAttachmentBucket().get(
    attachment.objectKey,
    range ? { range } : undefined,
  );
  if (!object) throw new NotFoundError("Attachment not found");

  const headers: Record<string, string> = {};
  if (range) {
    const end = range.offset + range.length - 1;
    headers["content-range"] = `bytes ${range.offset}-${end}/${attachment.byteSize}`;
    headers["content-length"] = String(range.length);
  } else {
    headers["content-length"] = String(attachment.byteSize);
  }
  return new Response(object.body, {
    status: range ? 206 : 200,
    headers: privateContentHeaders(attachment, options.preview, headers),
  });
}

export async function deleteAttachment(
  currentUser: UserRecord,
  taskId: string,
  attachmentRef: string,
  expectedVersion: number,
): Promise<AttachmentRecord> {
  const task = await getTask(currentUser, taskId);
  if (!canEditContent(task.accessRole)) {
    throw new PermissionError("Editor access is required");
  }
  const current = await loadTaskAttachment(task.id, attachmentRef);
  if (current.version !== expectedVersion) {
    throw new ConflictError("Attachment was changed in another session");
  }
  if (current.state !== "ready" && current.state !== "failed") {
    throw new ConflictError("Attachment cannot be deleted in its current state");
  }
  const now = new Date().toISOString();
  const row = await getD1()
    .prepare(
      `UPDATE attachments
       SET state = 'deleted', deleted_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND task_id = ? AND version = ?
       RETURNING *`,
    )
    .bind(now, now, current.id, task.id, expectedVersion)
    .first<DbRow>();
  if (!row) throw new ConflictError("Attachment was changed in another session");
  return mapAttachment(row);
}

export async function restoreAttachment(
  currentUser: UserRecord,
  taskId: string,
  attachmentRef: string,
  expectedVersion: number,
): Promise<AttachmentRecord> {
  const task = await getTask(currentUser, taskId);
  if (!canEditContent(task.accessRole)) {
    throw new PermissionError("Editor access is required");
  }
  const current = await loadTaskAttachment(task.id, attachmentRef, true);
  if (current.version !== expectedVersion) {
    throw new ConflictError("Attachment was changed in another session");
  }
  if (current.state !== "deleted" || !current.deletedAt) {
    throw new ConflictError("Attachment is not deleted");
  }
  const graceMs = attachmentLimits().deleteGraceSeconds * 1_000;
  if (Date.now() - Date.parse(current.deletedAt) >= graceMs) {
    throw new ConflictError("Attachment recovery period has expired");
  }
  if (!(await getAttachmentBucket().head(current.objectKey))) {
    throw new ConflictError("Attachment object is no longer available");
  }
  const now = new Date().toISOString();
  const row = await getD1()
    .prepare(
      `UPDATE attachments
       SET state = 'ready', deleted_at = NULL, version = version + 1, updated_at = ?
       WHERE id = ? AND task_id = ? AND version = ? AND state = 'deleted'
       RETURNING *`,
    )
    .bind(now, current.id, task.id, expectedVersion)
    .first<DbRow>();
  if (!row) throw new ConflictError("Attachment was changed in another session");
  return mapAttachment(row);
}

export async function purgeAttachmentGarbage(now = new Date()) {
  const limits = attachmentLimits();
  const deletedCutoff = new Date(
    now.getTime() - limits.deleteGraceSeconds * 1_000,
  ).toISOString();
  const failedCutoff = new Date(
    now.getTime() - limits.failedRetentionSeconds * 1_000,
  ).toISOString();
  const rows = await getD1()
    .prepare(
      `SELECT * FROM attachments
       WHERE (state = 'deleted' AND deleted_at <= ?)
          OR (state = 'uploading' AND upload_expires_at <= ?)
          OR (state = 'failed' AND updated_at <= ?)
       ORDER BY updated_at, id LIMIT ?`,
    )
    .bind(deletedCutoff, now.toISOString(), failedCutoff, CLEANUP_BATCH_SIZE)
    .all<DbRow>();
  let purged = 0;
  let failed = 0;
  const bucket = getAttachmentBucket();
  for (const row of rows.results) {
    const attachment = mapAttachment(row);
    try {
      await bucket.delete(attachment.objectKey);
      if (attachment.state === "uploading") {
        await getD1()
          .prepare(
            `UPDATE attachments
             SET state = 'failed', failure_code = 'upload_timeout',
                 upload_expires_at = NULL, version = version + 1, updated_at = ?
             WHERE id = ? AND state = 'uploading'`,
          )
          .bind(now.toISOString(), attachment.id)
          .run();
      } else {
        const result = await getD1()
          .prepare("DELETE FROM attachments WHERE id = ? AND state = ? RETURNING id")
          .bind(attachment.id, attachment.state)
          .first<{ id: string }>();
        purged += result ? 1 : 0;
      }
    } catch {
      failed += 1;
    }
  }
  return { processed: rows.results.length, purged, failed };
}

export async function purgeTaskAttachmentObjects(taskId: string) {
  const rows = await getD1()
    .prepare("SELECT object_key FROM attachments WHERE task_id = ?")
    .bind(taskId)
    .all<{ object_key: string }>();
  const bucket = getAttachmentBucket();
  for (const row of rows.results) await bucket.delete(row.object_key);
  return { deletedObjects: rows.results.length };
}

async function loadTaskAttachment(
  taskId: string,
  attachmentRef: string,
  includeDeleted = false,
): Promise<AttachmentRecord> {
  const row = await getD1()
    .prepare(
      `SELECT * FROM attachments
       WHERE task_id = ? AND (id = ? OR public_id = ?)
         ${includeDeleted ? "" : "AND state <> 'deleted'"}
       LIMIT 1`,
    )
    .bind(taskId, attachmentRef, attachmentRef)
    .first<DbRow>();
  if (!row) throw new NotFoundError("Attachment not found");
  return mapAttachment(row);
}

async function findIdempotentAttachment(
  taskId: string,
  uploaderUserId: string,
  idempotencyKey: string,
) {
  const row = await getD1()
    .prepare(
      `SELECT * FROM attachments
       WHERE task_id = ? AND uploader_user_id = ? AND idempotency_key = ?
       LIMIT 1`,
    )
    .bind(taskId, uploaderUserId, idempotencyKey)
    .first<DbRow>();
  return row ? mapAttachment(row) : null;
}

function inspectContent(
  bytes: Uint8Array,
  claimedMediaType: string | null | undefined,
  maxImagePixels: number,
): InspectedContent {
  if (looksActive(bytes)) {
    throw new ValidationError("Active HTML and SVG content is not accepted");
  }
  let inspected: InspectedContent;
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    inspected = { mediaType: "application/pdf", kind: "file", width: null, height: null };
  } else if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    const dimensions = pngDimensions(bytes);
    inspected = { mediaType: "image/png", kind: "image", ...dimensions };
  } else if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    const dimensions = jpegDimensions(bytes);
    inspected = { mediaType: "image/jpeg", kind: "image", ...dimensions };
  } else if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    const dimensions = gifDimensions(bytes);
    inspected = { mediaType: "image/gif", kind: "image", ...dimensions };
  } else if (isLikelyText(bytes)) {
    inspected = { mediaType: "text/plain", kind: "file", width: null, height: null };
  } else if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])
  ) {
    inspected = { mediaType: "application/zip", kind: "file", width: null, height: null };
  } else {
    inspected = {
      mediaType: "application/octet-stream",
      kind: "file",
      width: null,
      height: null,
    };
  }

  const claim = normalizeClaimedMediaType(claimedMediaType);
  if (claim && claim !== "application/octet-stream" && claim !== inspected.mediaType) {
    throw new ValidationError(
      `File content is ${inspected.mediaType}, not the claimed ${claim}`,
    );
  }
  if (inspected.width !== null && inspected.height !== null) {
    if (
      inspected.width < 1 ||
      inspected.height < 1 ||
      inspected.width > maxImagePixels ||
      inspected.height > maxImagePixels ||
      inspected.width * inspected.height > maxImagePixels
    ) {
      throw new ValidationError("Image dimensions exceed the safe decode limit");
    }
  }
  return inspected;
}

function pngDimensions(bytes: Uint8Array) {
  if (bytes.byteLength < 24 || ascii(bytes.subarray(12, 16)) !== "IHDR") {
    throw new ValidationError("PNG image is corrupted");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function gifDimensions(bytes: Uint8Array) {
  if (bytes.byteLength < 10) throw new ValidationError("GIF image is corrupted");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function jpegDimensions(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.byteLength) break;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.byteLength) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) break;
      return {
        height: view.getUint16(offset + 3),
        width: view.getUint16(offset + 5),
      };
    }
    offset += length;
  }
  throw new ValidationError("JPEG image is corrupted");
}

function looksActive(bytes: Uint8Array) {
  const prefix = ascii(bytes.subarray(0, Math.min(bytes.byteLength, 1_024)))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  return (
    prefix.startsWith("<!doctype html") ||
    prefix.startsWith("<html") ||
    prefix.startsWith("<svg") ||
    (prefix.startsWith("<?xml") && (prefix.includes("<svg") || prefix.includes("<html")))
  );
}

function isLikelyText(bytes: Uint8Array) {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 4_096));
  for (const value of sample) {
    if (value === 0) return false;
    if (value < 0x09 || (value > 0x0d && value < 0x20)) return false;
  }
  return true;
}

function normalizeClaimedMediaType(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.split(";", 1)[0]!.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)) {
    throw new ValidationError("Content-Type is invalid");
  }
  if (normalized === "text/html" || normalized === "image/svg+xml") {
    throw new ValidationError("Active HTML and SVG content is not accepted");
  }
  return normalized;
}

function normalizeFilenames(value: string) {
  if (typeof value !== "string") throw new ValidationError("Filename is required");
  const withoutControls = [...value.normalize("NFKC")]
    .filter((character) => !isControlCharacter(character))
    .join("");
  const originalFilename = withoutControls.trim().slice(0, 1_024);
  const displayName = originalFilename.replace(/\\/g, "/").split("/").pop()!.trim().slice(0, 255);
  if (!originalFilename || !displayName || displayName === "." || displayName === "..") {
    throw new ValidationError("Filename is required");
  }
  return { originalFilename, displayName };
}

function normalizeIdempotencyKey(value: string) {
  if (typeof value !== "string") {
    throw new ValidationError("Idempotency-Key is required");
  }
  const key = value.trim();
  if (!key || key.length > 200 || [...key].some(isControlCharacter)) {
    throw new ValidationError("Idempotency-Key must contain 1 to 200 safe characters");
  }
  return key;
}

function isControlCharacter(character: string) {
  const code = character.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

function attachmentScope() {
  const env = getRuntimeEnvironment();
  const configured = env.TASK_MANAGER_ATTACHMENT_SCOPE?.trim();
  const originHost = env.TASK_MANAGER_PUBLIC_ORIGIN
    ? new URL(env.TASK_MANAGER_PUBLIC_ORIGIN).hostname
    : "local";
  const scope = (configured || originHost).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  if (!scope || scope.length > 100) {
    throw new Error("Attachment storage scope is invalid");
  }
  return scope;
}

function parseRange(value: string | null | undefined, size: number) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || value.includes(",")) {
    return "unsatisfiable" as const;
  }
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable" as const;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return "unsatisfiable" as const;
  }
  end = Math.min(end, size - 1);
  return { offset: start, length: end - start + 1 };
}

function privateContentHeaders(
  attachment: AttachmentRecord,
  preview: boolean,
  additional: Record<string, string>,
) {
  const safePreview = preview && attachment.kind === "image";
  return {
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "content-disposition": contentDisposition(
      safePreview ? "inline" : "attachment",
      attachment.displayName,
    ),
    "content-security-policy": "default-src 'none'; sandbox",
    "content-type": attachment.mediaType,
    "x-content-type-options": "nosniff",
    ...additional,
  };
}

function contentDisposition(disposition: "inline" | "attachment", filename: string) {
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 150) || "attachment";
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function mapAttachment(row: DbRow): AttachmentRecord {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    taskId: String(row.task_id),
    uploaderUserId: String(row.uploader_user_id),
    originalFilename: String(row.original_filename),
    displayName: String(row.display_name),
    mediaType: String(row.media_type),
    byteSize: Number(row.byte_size),
    checksumSha256: String(row.checksum_sha256),
    objectKey: String(row.object_key),
    kind: String(row.kind) as AttachmentKind,
    state: String(row.state) as AttachmentState,
    imageWidth: row.image_width == null ? null : Number(row.image_width),
    imageHeight: row.image_height == null ? null : Number(row.image_height),
    variants: safeJson(row.variant_metadata_json),
    uploadExpiresAt: row.upload_expires_at == null ? null : String(row.upload_expires_at),
    failureCode: row.failure_code == null ? null : String(row.failure_code),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at == null ? null : String(row.deleted_at),
  };
}

function safeJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function configuredPositiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function startsWith(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
