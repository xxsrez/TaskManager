import { getAttachmentBucket, getD1 } from "@/db";
import { assertAdmin } from "./admin";
import {
  attachmentLimits,
  createAttachment,
  findIdempotentAttachment,
  getTaskAttachment,
} from "./attachments";
import { canEditContent } from "./access";
import { editableProjectWhere } from "./access-sql";
import { PermissionError, ValidationError } from "./domain";
import { getTask } from "./repository";
import { getRuntimeEnvironment } from "./runtime-environment";
import type { AttachmentRecord, UserRecord } from "./types";

type DbRow = Record<string, unknown>;

export type ImportedAttachmentDisposition =
  | "candidate"
  | "blocked"
  | "skipped";

export type PlannedImportedAttachment = {
  sourceRecordId: string;
  taskId: string;
  sourceIndex: number;
  sourceAttachmentId: string | null;
  title: string | null;
  url: string | null;
  rawJson: string;
  disposition: ImportedAttachmentDisposition;
  reason: string | null;
};

export type AttachmentMigrationOutcome =
  | "migrated"
  | "non_binary_mapped"
  | "skipped"
  | "blocked";

export type AttachmentMigrationItemResult = {
  sourceRecordId: string;
  sourceIndex: number;
  action:
    | "migrated"
    | "already_migrated"
    | "non_binary_mapped"
    | "already_reconciled"
    | "skipped"
    | "blocked";
  reason: string | null;
  attachmentRef: string | null;
};

export type AttachmentMigrationReport = {
  generatedAt: string;
  mode: "inventory" | "apply";
  sourceRecordCount: number;
  sourceAttachmentCount: number;
  pendingCount: number;
  migratedCount: number;
  nonBinaryMappedCount: number;
  skippedCount: number;
  blockedCount: number;
  cutoverReady: boolean;
  truncated: boolean;
  items: AttachmentMigrationItemResult[];
};

type SourceRecord = {
  id: string;
  taskId: string;
  metadataJson: string;
};

type StoredOutcome = {
  outcome: AttachmentMigrationOutcome;
  reason: string | null;
  attachmentId: string | null;
  attachmentPublicId: string | null;
  attachmentState: string | null;
  attachmentTaskId: string | null;
  attachmentObjectKey: string | null;
  attachmentByteSize: number | null;
  attachmentChecksum: string | null;
};

export function planImportedAttachments(
  sourceRecordId: string,
  taskId: string,
  metadataJson: string,
): PlannedImportedAttachment[] {
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataJson);
  } catch {
    return [blockedSentinel(sourceRecordId, taskId, metadataJson, "metadata_not_json")];
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [blockedSentinel(sourceRecordId, taskId, metadataJson, "metadata_not_object")];
  }
  const attachments = (metadata as Record<string, unknown>).attachments;
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments)) {
    return [blockedSentinel(sourceRecordId, taskId, JSON.stringify(attachments), "attachments_not_array")];
  }

  const seenUrls = new Map<string, number>();
  return attachments.map((value, sourceIndex) => {
    const rawJson = safeJson(value);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return planned(sourceRecordId, taskId, sourceIndex, null, null, null, rawJson, "blocked", "attachment_not_object");
    }
    const row = value as Record<string, unknown>;
    const title = optionalText(row.title);
    const sourceAttachmentId = optionalText(row.id);
    const urlText = optionalText(row.url);
    if (!urlText) {
      return planned(sourceRecordId, taskId, sourceIndex, sourceAttachmentId, title, null, rawJson, "blocked", "attachment_url_missing");
    }
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      return planned(sourceRecordId, taskId, sourceIndex, sourceAttachmentId, title, null, rawJson, "blocked", "attachment_url_invalid");
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      return planned(sourceRecordId, taskId, sourceIndex, sourceAttachmentId, title, null, rawJson, "blocked", "attachment_url_not_safe_https");
    }
    url.hash = "";
    const normalized = url.toString();
    const duplicateOf = seenUrls.get(normalized);
    if (duplicateOf !== undefined) {
      return planned(sourceRecordId, taskId, sourceIndex, sourceAttachmentId, title, normalized, rawJson, "skipped", `duplicate_source_url:${duplicateOf}`);
    }
    seenUrls.set(normalized, sourceIndex);
    return planned(sourceRecordId, taskId, sourceIndex, sourceAttachmentId, title, normalized, rawJson, "candidate", null);
  });
}

export async function reconcileImportedAttachments(
  currentUser: UserRecord,
  options: {
    mode?: "inventory" | "apply";
    sourceRecordId?: string;
    sourceIndex?: number;
    maxRecords?: number;
    maxAttachments?: number;
    verifiedNonBinary?: boolean;
    fetcher?: typeof fetch;
  } = {},
): Promise<AttachmentMigrationReport> {
  assertConfiguredAdmin(currentUser);
  const mode = options.mode ?? "inventory";
  if (
    options.verifiedNonBinary === true &&
    (mode !== "apply" || !options.sourceRecordId || options.sourceIndex === undefined)
  ) {
    throw new ValidationError(
      "Verified non-binary mapping requires one exact source record and index",
    );
  }
  const maxRecords = boundedInteger(options.maxRecords, 100, 1, 500);
  const maxAttachments = boundedInteger(options.maxAttachments, 25, 1, 100);
  const db = getD1();
  const accessJoin = `FROM external_records er
    JOIN tasks t ON t.id = er.target_id
    JOIN projects p ON p.id = t.project_id
    WHERE er.source = 'linear' AND er.target_type = 'task'
      AND ${editableProjectWhere("p")}`;
  const sourceQuery = options.sourceRecordId
    ? db.prepare(`SELECT er.id, er.target_id, er.metadata_json ${accessJoin}
        AND er.id = ? LIMIT 1`)
        .bind(currentUser.id, currentUser.id, options.sourceRecordId)
    : db.prepare(`SELECT er.id, er.target_id, er.metadata_json ${accessJoin}
        ORDER BY er.id LIMIT ?`)
        .bind(currentUser.id, currentUser.id, maxRecords + 1);
  const sourceRows = await sourceQuery.all<DbRow>();
  const truncated = !options.sourceRecordId && sourceRows.results.length > maxRecords;
  const sources = sourceRows.results.slice(0, maxRecords).map((row): SourceRecord => ({
    id: String(row.id),
    taskId: String(row.target_id),
    metadataJson: String(row.metadata_json),
  }));
  const plans = sources.flatMap((source) =>
    planImportedAttachments(source.id, source.taskId, source.metadataJson),
  ).filter((item) => options.sourceIndex === undefined || item.sourceIndex === options.sourceIndex);
  const stored = await loadStoredOutcomes(plans);
  const items: AttachmentMigrationItemResult[] = [];
  let applied = 0;

  for (const item of plans) {
    const key = outcomeKey(item.sourceRecordId, item.sourceIndex);
    const prior = stored.get(key);
    if (mode === "inventory") {
      items.push(await inventoryResult(item, prior));
      continue;
    }
    if (applied >= maxAttachments) break;
    applied += 1;
    items.push(await applyPlannedAttachment(
      currentUser,
      item,
      prior,
      options.fetcher ?? fetch,
      options.verifiedNonBinary === true,
    ));
  }

  if (mode === "apply") {
    const refreshed = await loadStoredOutcomes(plans);
    const allItems = await Promise.all(plans.map((item) => inventoryResult(item, refreshed.get(outcomeKey(item.sourceRecordId, item.sourceIndex)))));
    return summarize(mode, sources.length, plans.length, allItems, truncated || applied < plans.length, items);
  }
  return summarize(mode, sources.length, plans.length, items, truncated, items);
}

async function applyPlannedAttachment(
  currentUser: UserRecord,
  item: PlannedImportedAttachment,
  prior: StoredOutcome | undefined,
  fetcher: typeof fetch,
  verifiedNonBinary: boolean,
): Promise<AttachmentMigrationItemResult> {
  const task = await getTask(currentUser, item.taskId);
  if (!canEditContent(task.accessRole)) throw new PermissionError("Editor access is required");

  if (prior?.outcome === "migrated") {
    const verified = await verifyStoredMigration(currentUser, item.taskId, prior);
    if (verified) return result(item, "already_migrated", null, verified.publicId);
    await storeOutcome(item, "blocked", "native_attachment_verification_failed", null, null, null);
    return result(item, "blocked", "native_attachment_verification_failed", null);
  }
  if (prior && prior.outcome !== "blocked") {
    return result(item, "already_reconciled", prior.reason, prior.attachmentPublicId);
  }
  if (item.disposition === "blocked") {
    await storeOutcome(item, "blocked", item.reason, null, null, null);
    return result(item, "blocked", item.reason, null);
  }
  if (item.disposition === "skipped") {
    await storeOutcome(item, "skipped", item.reason, null, null, null);
    return result(item, "skipped", item.reason, null);
  }
  const existing = await findIdempotentAttachment(
    item.taskId,
    currentUser.id,
    migrationIdempotencyKey(item),
  );
  if (existing) {
    const verified = await verifyNativeAttachment(currentUser, item.taskId, existing);
    if (!verified) {
      await storeOutcome(
        item,
        "blocked",
        "native_attachment_verification_failed",
        null,
        null,
        null,
      );
      return result(item, "blocked", "native_attachment_verification_failed", null);
    }
    await storeOutcome(item, "migrated", null, existing.id, null, null);
    return result(item, "migrated", null, existing.publicId);
  }
  if (verifiedNonBinary) {
    if (!item.url) throw new ValidationError("Attachment URL is unavailable");
    assertAllowedMigrationUrl(new URL(item.url));
    const reason = "verified_non_binary_link_preserved";
    await storeOutcome(item, "non_binary_mapped", reason, null, item.title, item.url);
    return result(item, "non_binary_mapped", reason, null);
  }

  try {
    const downloaded = await downloadCandidate(item, fetcher);
    if (downloaded.kind === "non_binary_link") {
      await storeOutcome(item, "non_binary_mapped", "html_link_preserved", null, item.title ?? downloaded.filename, item.url);
      return result(item, "non_binary_mapped", "html_link_preserved", null);
    }
    const attachment = await createAttachment(currentUser, item.taskId, {
      body: downloaded.bytes,
      filename: downloaded.filename,
      claimedMediaType: downloaded.mediaType,
      idempotencyKey: migrationIdempotencyKey(item),
    });
    const verified = await verifyNativeAttachment(currentUser, item.taskId, attachment);
    if (!verified) {
      await storeOutcome(item, "blocked", "native_attachment_verification_failed", null, null, null);
      return result(item, "blocked", "native_attachment_verification_failed", null);
    }
    await storeOutcome(item, "migrated", null, attachment.id, null, null);
    return result(item, "migrated", null, attachment.publicId);
  } catch (error) {
    const reason = migrationFailureReason(error);
    await storeOutcome(item, "blocked", reason, null, null, null);
    return result(item, "blocked", reason, null);
  }
}

async function downloadCandidate(item: PlannedImportedAttachment, fetcher: typeof fetch) {
  if (!item.url) throw new ValidationError("Attachment URL is unavailable");
  let current = new URL(item.url);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    assertAllowedMigrationUrl(current);
    const response = await fetcher(current, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { accept: "application/octet-stream, image/*, application/pdf, text/plain;q=0.8, */*;q=0.1" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("redirect_not_allowed");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`source_unavailable:${response.status}`);
    const mediaType = normalizeMediaType(response.headers.get("content-type"));
    const filename = responseFilename(response, current, item.title);
    if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
      await response.body.cancel().catch(() => undefined);
      return { kind: "non_binary_link" as const, filename };
    }
    const bytes = await readBoundedResponse(response, attachmentLimits().maxBytes);
    return { kind: "binary" as const, bytes, filename, mediaType };
  }
  throw new Error("redirect_not_allowed");
}

async function readBoundedResponse(response: Response, maxBytes: number) {
  const declared = response.headers.get("content-length");
  if (declared) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw new Error("source_size_invalid");
    }
  }
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("source_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!bytes.byteLength) throw new Error("source_empty");
  return bytes;
}

async function verifyStoredMigration(
  currentUser: UserRecord,
  taskId: string,
  prior: StoredOutcome,
) {
  if (
    !prior.attachmentId || !prior.attachmentPublicId ||
    prior.attachmentTaskId !== taskId || prior.attachmentState !== "ready" ||
    !prior.attachmentObjectKey || prior.attachmentByteSize === null || !prior.attachmentChecksum
  ) return null;
  const record = await getTaskAttachment(currentUser, taskId, prior.attachmentPublicId).catch(() => null);
  if (!record) return null;
  const object = await getAttachmentBucket().get(prior.attachmentObjectKey);
  if (!object || object.size !== prior.attachmentByteSize) return null;
  const checksum = await sha256Hex(new Uint8Array(await object.arrayBuffer()));
  return checksum === prior.attachmentChecksum ? record : null;
}

async function verifyNativeAttachment(
  currentUser: UserRecord,
  taskId: string,
  attachment: AttachmentRecord,
) {
  if (attachment.state !== "ready") return false;
  const readBack = await getTaskAttachment(currentUser, taskId, attachment.publicId);
  const object = await getAttachmentBucket().get(attachment.objectKey);
  if (!object || object.size !== attachment.byteSize) return false;
  const checksum = await sha256Hex(new Uint8Array(await object.arrayBuffer()));
  return readBack.id === attachment.id && checksum === attachment.checksumSha256;
}

async function loadStoredOutcomes(plans: PlannedImportedAttachment[]) {
  const result = new Map<string, StoredOutcome>();
  if (!plans.length) return result;
  const sourceIds = [...new Set(plans.map((item) => item.sourceRecordId))];
  const placeholders = sourceIds.map(() => "?").join(", ");
  const rows = await getD1().prepare(`SELECT o.source_record_id, o.source_index,
      o.outcome, o.reason, o.attachment_id,
      a.public_id AS attachment_public_id, a.state AS attachment_state,
      a.task_id AS attachment_task_id, a.object_key AS attachment_object_key,
      a.byte_size AS attachment_byte_size, a.checksum_sha256 AS attachment_checksum
    FROM attachment_migration_outcomes o
    LEFT JOIN attachments a ON a.id = o.attachment_id
    WHERE o.source_record_id IN (${placeholders})`)
    .bind(...sourceIds).all<DbRow>();
  for (const row of rows.results) {
    result.set(outcomeKey(String(row.source_record_id), Number(row.source_index)), {
      outcome: String(row.outcome) as AttachmentMigrationOutcome,
      reason: row.reason == null ? null : String(row.reason),
      attachmentId: row.attachment_id == null ? null : String(row.attachment_id),
      attachmentPublicId: row.attachment_public_id == null ? null : String(row.attachment_public_id),
      attachmentState: row.attachment_state == null ? null : String(row.attachment_state),
      attachmentTaskId: row.attachment_task_id == null ? null : String(row.attachment_task_id),
      attachmentObjectKey: row.attachment_object_key == null ? null : String(row.attachment_object_key),
      attachmentByteSize: row.attachment_byte_size == null ? null : Number(row.attachment_byte_size),
      attachmentChecksum: row.attachment_checksum == null ? null : String(row.attachment_checksum),
    });
  }
  return result;
}

async function storeOutcome(
  item: PlannedImportedAttachment,
  outcome: AttachmentMigrationOutcome,
  reason: string | null,
  attachmentId: string | null,
  mappedTitle: string | null,
  mappedUrl: string | null,
) {
  await getD1().prepare(`INSERT INTO attachment_migration_outcomes (
      id, task_id, source, source_record_id, source_attachment_id, source_index,
      outcome, reason, attachment_id, mapped_title, mapped_url, raw_json, reconciled_at
    ) VALUES (?, ?, 'linear', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_record_id, source_index) DO UPDATE SET
      task_id = excluded.task_id,
      source_attachment_id = excluded.source_attachment_id,
      outcome = excluded.outcome,
      reason = excluded.reason,
      attachment_id = excluded.attachment_id,
      mapped_title = excluded.mapped_title,
      mapped_url = excluded.mapped_url,
      raw_json = excluded.raw_json,
      reconciled_at = excluded.reconciled_at`)
    .bind(
      `attachment-migration:${item.sourceRecordId}:${item.sourceIndex}`,
      item.taskId,
      item.sourceRecordId,
      item.sourceAttachmentId,
      item.sourceIndex,
      outcome,
      reason,
      attachmentId,
      mappedTitle,
      mappedUrl,
      item.rawJson,
      new Date().toISOString(),
    ).run();
}

async function inventoryResult(
  item: PlannedImportedAttachment,
  prior: StoredOutcome | undefined,
): Promise<AttachmentMigrationItemResult> {
  if (!prior) {
    if (item.disposition === "blocked") return result(item, "blocked", item.reason, null);
    if (item.disposition === "skipped") return result(item, "skipped", item.reason, null);
    return result(item, "blocked", "pending_migration", null);
  }
  if (prior.outcome === "migrated") {
    const consistent =
      prior.attachmentId !== null && prior.attachmentPublicId !== null &&
      prior.attachmentTaskId === item.taskId && prior.attachmentState === "ready";
    return result(item, consistent ? "already_migrated" : "blocked", consistent ? null : "native_attachment_verification_required", consistent ? prior.attachmentPublicId : null);
  }
  if (prior.outcome === "non_binary_mapped") return result(item, "already_reconciled", prior.reason, null);
  if (prior.outcome === "skipped") return result(item, "skipped", prior.reason, null);
  return result(item, "blocked", prior.reason, null);
}

function summarize(
  mode: "inventory" | "apply",
  sourceRecordCount: number,
  sourceAttachmentCount: number,
  stateItems: AttachmentMigrationItemResult[],
  truncated: boolean,
  returnedItems: AttachmentMigrationItemResult[],
): AttachmentMigrationReport {
  const migratedCount = stateItems.filter((item) => item.action === "migrated" || item.action === "already_migrated").length;
  const nonBinaryMappedCount = stateItems.filter((item) =>
    item.action === "non_binary_mapped" ||
    (item.action === "already_reconciled" && isNonBinaryMappingReason(item.reason))
  ).length;
  const skippedCount = stateItems.filter((item) => item.action === "skipped").length;
  const blockedCount = stateItems.filter((item) => item.action === "blocked" && item.reason !== "pending_migration").length;
  const pendingCount = stateItems.filter((item) => item.action === "blocked" && item.reason === "pending_migration").length;
  return {
    generatedAt: new Date().toISOString(),
    mode,
    sourceRecordCount,
    sourceAttachmentCount,
    pendingCount,
    migratedCount,
    nonBinaryMappedCount,
    skippedCount,
    blockedCount,
    cutoverReady: !truncated && pendingCount === 0 && blockedCount === 0 && migratedCount + nonBinaryMappedCount + skippedCount === sourceAttachmentCount,
    truncated,
    items: returnedItems,
  };
}

function isNonBinaryMappingReason(reason: string | null) {
  return reason === "html_link_preserved" ||
    reason === "verified_non_binary_link_preserved";
}

function assertAllowedMigrationUrl(url: URL) {
  if (url.protocol !== "https:" || url.username || url.password || isIpLiteral(url.hostname)) {
    throw new Error("source_host_not_allowed");
  }
  const configured = getRuntimeEnvironment().TASK_MANAGER_ATTACHMENT_MIGRATION_HOSTS ?? "";
  const allowed = configured.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const hostname = url.hostname.toLowerCase();
  if (!allowed.some((entry) => entry.startsWith("*.") ? hostname.endsWith(entry.slice(1)) && hostname !== entry.slice(2) : hostname === entry)) {
    throw new Error("source_host_not_allowed");
  }
}

function responseFilename(response: Response, url: URL, title: string | null) {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  let headerName: string | null = null;
  try {
    headerName = encoded ? decodeURIComponent(encoded) : plain?.trim() ?? null;
  } catch {
    headerName = null;
  }
  const pathName = decodeURIComponent(url.pathname.split("/").pop() || "").trim();
  return headerName || title || pathName || "imported-attachment";
}

function normalizeMediaType(value: string | null) {
  if (!value) return null;
  const normalized = value.split(";", 1)[0]!.trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  if (normalized === "binary/octet-stream" || normalized === "application/x-download") {
    return "application/octet-stream";
  }
  if (normalized === "application/x-zip-compressed") return "application/zip";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized) ? normalized : null;
}

function migrationFailureReason(error: unknown) {
  const message = error instanceof Error ? error.message : "migration_failed";
  if (message.startsWith("source_unavailable:")) return message;
  if ([
    "source_host_not_allowed", "redirect_not_allowed", "source_size_invalid",
    "source_too_large", "source_empty",
  ].includes(message)) return message;
  if (error instanceof ValidationError) return "source_content_invalid";
  return "migration_failed";
}

function migrationIdempotencyKey(item: PlannedImportedAttachment) {
  return `linear-attachment:${item.sourceRecordId}:${item.sourceIndex}`.slice(0, 200);
}

function result(
  item: PlannedImportedAttachment,
  action: AttachmentMigrationItemResult["action"],
  reason: string | null,
  attachmentRef: string | null,
): AttachmentMigrationItemResult {
  return { sourceRecordId: item.sourceRecordId, sourceIndex: item.sourceIndex, action, reason, attachmentRef };
}

function outcomeKey(sourceRecordId: string, sourceIndex: number) {
  return `${sourceRecordId}\u0000${sourceIndex}`;
}

function planned(
  sourceRecordId: string,
  taskId: string,
  sourceIndex: number,
  sourceAttachmentId: string | null,
  title: string | null,
  url: string | null,
  rawJson: string,
  disposition: ImportedAttachmentDisposition,
  reason: string | null,
): PlannedImportedAttachment {
  return { sourceRecordId, taskId, sourceIndex, sourceAttachmentId, title, url, rawJson, disposition, reason };
}

function blockedSentinel(sourceRecordId: string, taskId: string, rawJson: string, reason: string) {
  return planned(sourceRecordId, taskId, -1, null, null, null, rawJson, "blocked", reason);
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return "null";
  }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) {
  return Number.isSafeInteger(value) ? Math.min(max, Math.max(min, value!)) : fallback;
}

function isIpLiteral(hostname: string) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function assertConfiguredAdmin(user: UserRecord) {
  assertAdmin(user, getRuntimeEnvironment().TASK_MANAGER_ADMIN_EMAILS ?? "");
}
