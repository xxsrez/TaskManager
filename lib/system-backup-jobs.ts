import { getAttachmentBucket, getD1 } from "@/db";
import { assertAdmin } from "./admin";
import { attachmentStorageScope } from "./attachment-storage";
import { ValidationError } from "./domain";
import { getRuntimeEnvironment } from "./runtime-environment";
import {
  liveTableDeleteOrder,
  normalizeDbRow,
  restoreTableDefinitions,
  tableDefinitions,
} from "./system-backup-format";
import {
  systemBackupCurrentSchemaVersion,
  systemBackupD1TableContracts,
  systemBackupExactTableContracts,
  systemBackupR2ObjectClassContracts,
} from "./system-backup-contract";
import {
  IncrementalSha256,
  canonicalJson,
  createObjectFrame,
  createPackageManifest,
  createRowsFrame,
  descriptorOf,
  encodePackageLine,
  systemBackupObjectChunkBytes,
  maxSystemBackupPartBytes,
  systemBackupPackageFormat,
  systemBackupPackageMediaType,
  systemBackupPackageVersion,
  systemBackupSchemaFingerprint,
  targetSystemBackupPartBytes,
  validateDataFrame,
  validatePackageHeader,
  validatePackageManifest,
  type SystemBackupDataFrame,
  type SystemBackupObjectManifest,
  type SystemBackupPackageHeader,
  type SystemBackupPackageManifest,
  type SystemBackupPartDescriptor,
} from "./system-backup-package";
import type { UserRecord } from "./types";
import { validateSystemBackupStagedState } from "./system-backup-validation";

const encoder = new TextEncoder();
const jobLifetimeSeconds = 24 * 60 * 60;
const jobLeaseSeconds = 5 * 60;
const systemBackupAction = "system-backup";

type DbRow = Record<string, unknown>;

type BackupJobRow = {
  id: string;
  kind: "export" | "import" | "rollback";
  parent_job_id: string | null;
  rollback_job_id: string | null;
  created_by_user_id: string;
  status: string;
  phase: string;
  site_origin: string;
  environment_scope: string;
  schema_version: number;
  schema_fingerprint: string;
  exported_at: string | null;
  root_sha256: string | null;
  state_sha256: string | null;
  manifest_json: string | null;
  counts_json: string;
  total_rows: number;
  total_bytes: number;
  part_count: number;
  next_part_index: number;
  phase_cursor: string | null;
  hash_state_json: string | null;
  attempt_count: number;
  error_code: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  d1_committed_at: string | null;
  applied_at: string | null;
};

export type SystemBackupJobStatus = {
  jobId: string;
  kind: BackupJobRow["kind"];
  status: string;
  phase: string;
  schemaVersion: number;
  schemaFingerprint: string;
  exportedAt: string | null;
  rootSha256: string | null;
  stateSha256: string | null;
  counts: Record<string, number>;
  progress: {
    rows: number;
    bytes: number;
    parts: number;
    nextPartIndex: number;
  };
  rollbackJobId: string | null;
  cleanupPending: boolean;
  error: string | null;
  format: { name: string; version: number; schemaVersion: number; schemaFingerprint: string };
  siteOrigin: string;
  environmentScope: string;
  r2: {
    objects: number;
    bytes: number;
    bound: number;
    unbound: number;
    orphan: number;
    namespaces: Record<string, { objects: number; bytes: number }>;
  };
  policies: Record<string, string[]>;
  warnings: string[];
  validationErrors: string[];
  advanceDeferred?: boolean;
  updatedAt: string;
  attemptCount: number;
  expiresAt: string;
  downloadUrl: string | null;
};

export async function createSystemBackupExportJob(
  currentUser: UserRecord,
  options: {
    kind?: "export" | "rollback";
    parentJobId?: string | null;
    siteOrigin?: string;
    reuseCurrent?: boolean;
  } = {},
): Promise<SystemBackupJobStatus> {
  assertConfiguredAdmin(currentUser);
  await cleanupExpiredSystemBackupJobs();
  const kind = options.kind ?? "export";
  if (kind === "export" && options.reuseCurrent) {
    const current = await getCurrentSystemBackupExportJob(currentUser);
    if (current?.status === "running") return current;
  }
  const jobId = `${kind === "rollback" ? "system-rollback" : "system-export"}:${crypto.randomUUID()}`;
  const exportedAt = new Date().toISOString();
  const fingerprint = await systemBackupSchemaFingerprint();
  const siteOrigin = currentSiteOrigin(options.siteOrigin);
  const environmentScope = attachmentStorageScope();
  const expiresAt = new Date(Date.now() + jobLifetimeSeconds * 1000).toISOString();
  const db = getD1();
  const freezeStatements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO system_backup_jobs
      (id, kind, parent_job_id, created_by_user_id, status, phase,
       site_origin, environment_scope, schema_version, schema_fingerprint,
       exported_at, expires_at)
      VALUES (?, ?, ?, ?, 'running', 'freezing_d1', ?, ?, ?, ?, ?, ?)`)
      .bind(
        jobId,
        kind,
        options.parentJobId ?? null,
        currentUser.id,
        siteOrigin,
        environmentScope,
        systemBackupCurrentSchemaVersion,
        fingerprint,
        exportedAt,
        expiresAt,
      ),
  ];
  for (const table of tableDefinitions) {
    freezeStatements.push(
      db.prepare(`INSERT INTO system_backup_rows (job_id, table_name, ordinal, row_json)
        SELECT ?, ?, ROW_NUMBER() OVER (ORDER BY ${table.orderBy}) - 1,
          ${jsonObjectExpression(table.columns)}
        FROM ${table.name}
        ORDER BY ${table.orderBy}`)
        .bind(jobId, table.name),
    );
  }
  try {
    await db.batch(freezeStatements);
    const counts = await readFrozenCounts(jobId);
    const totalRows = Object.values(counts).reduce((sum, value) => sum + value, 0);
    await db.prepare(`UPDATE system_backup_jobs
      SET status = 'running', phase = 'inventory_r2', phase_cursor = NULL,
          counts_json = ?, total_rows = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).bind(JSON.stringify(counts), totalRows, jobId).run();
  } catch (error) {
    await failJob(jobId, error);
    throw error;
  }
  return getSystemBackupJobStatus(currentUser, jobId);
}

export async function getCurrentSystemBackupExportJob(
  currentUser: UserRecord,
): Promise<SystemBackupJobStatus | null> {
  assertConfiguredAdmin(currentUser);
  await cleanupExpiredSystemBackupJobs();
  const job = await getD1().prepare(`SELECT * FROM system_backup_jobs
    WHERE created_by_user_id = ? AND kind = 'export'
      AND status IN ('running', 'ready')
      AND datetime(expires_at) > datetime('now')
    ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,
      exported_at DESC, id DESC
    LIMIT 1`)
    .bind(currentUser.id)
    .first<BackupJobRow>();
  return job ? statusFromRow(job) : null;
}

export async function createSystemBackupImportJob(
  currentUser: UserRecord,
  headerValue: unknown,
  siteOrigin?: string,
): Promise<SystemBackupJobStatus> {
  assertConfiguredAdmin(currentUser);
  const header = await validatePackageHeader(headerValue);
  assertLocalPackageBoundary(header, siteOrigin);
  const jobId = `system-import:${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + jobLifetimeSeconds * 1000).toISOString();
  await getD1().prepare(`INSERT INTO system_backup_jobs
    (id, kind, created_by_user_id, status, phase, site_origin,
     environment_scope, schema_version, schema_fingerprint, exported_at,
     expires_at)
    VALUES (?, 'import', ?, 'uploading', 'uploading', ?, ?, ?, ?, ?, ?)`)
    .bind(
      jobId,
      currentUser.id,
      header.siteOrigin,
      header.environmentScope,
      header.schemaVersion,
      header.schemaFingerprint,
      header.exportedAt,
      expiresAt,
    ).run();
  return getSystemBackupJobStatus(currentUser, jobId);
}

export async function uploadSystemBackupImportPart(
  currentUser: UserRecord,
  jobId: string,
  partIndex: number,
  value: unknown,
): Promise<SystemBackupJobStatus> {
  assertConfiguredAdmin(currentUser);
  const job = await requireOwnedJob(currentUser, jobId, "import");
  if (job.status !== "uploading" || job.phase !== "uploading") {
    throw new ValidationError("System backup upload is not accepting parts");
  }
  const validated = await validateDataFrame(value);
  if (validated.frame.index !== partIndex) {
    throw new ValidationError("System backup part index does not match the upload URL");
  }
  if (partIndex < job.next_part_index) {
    const existing = await getD1().prepare(`SELECT sha256 FROM system_backup_parts
      WHERE job_id = ? AND part_index = ?`).bind(jobId, partIndex)
      .first<{ sha256: string }>();
    if (!existing || existing.sha256 !== validated.frame.sha256) {
      throw new ValidationError("Uploaded system backup part conflicts with the durable receipt");
    }
    return getSystemBackupJobStatus(currentUser, jobId);
  }
  if (partIndex !== job.next_part_index) {
    throw new ValidationError(`Expected system backup part ${job.next_part_index}`);
  }
  const objectKey = packagePartKey(jobId, partIndex);
  await getAttachmentBucket().put(objectKey, encodePackageLine(validated.frame), {
    httpMetadata: { contentType: systemBackupPackageMediaType },
    customMetadata: { sha256: validated.frame.sha256 },
  });
  const db = getD1();
  try {
    const [, transition] = await db.batch([
      db.prepare(`INSERT INTO system_backup_parts
        (job_id, part_index, part_type, table_name, ordinal_start, row_count,
         logical_ref, byte_length, sha256, object_key, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded')`)
        .bind(
          jobId,
          partIndex,
          validated.frame.type,
          validated.frame.table,
          validated.frame.ordinal,
          validated.frame.count,
          validated.frame.logicalRef,
          validated.frame.byteLength,
          validated.frame.sha256,
          objectKey,
        ),
      db.prepare(`UPDATE system_backup_jobs
        SET next_part_index = next_part_index + 1,
            total_bytes = total_bytes + ?, part_count = part_count + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND created_by_user_id = ? AND status = 'uploading'
          AND phase = 'uploading' AND next_part_index = ?`)
        .bind(validated.frame.byteLength, jobId, currentUser.id, partIndex),
    ]);
    if (transition.meta.changes !== 1) {
      throw new ValidationError("System backup upload changed concurrently");
    }
  } catch (error) {
    await getAttachmentBucket().delete(objectKey);
    throw error;
  }
  return getSystemBackupJobStatus(currentUser, jobId);
}

export async function finalizeSystemBackupImport(
  currentUser: UserRecord,
  jobId: string,
  manifestValue: unknown,
): Promise<SystemBackupJobStatus> {
  assertConfiguredAdmin(currentUser);
  const job = await requireOwnedJob(currentUser, jobId, "import");
  if (job.status !== "uploading" || job.phase !== "uploading") {
    if (job.status === "ready") return getSystemBackupJobStatus(currentUser, jobId);
    throw new ValidationError("System backup upload cannot be finalized");
  }
  const manifest = await validatePackageManifest(manifestValue);
  assertManifestMatchesJob(manifest, job);
  if (manifest.parts.length !== job.next_part_index) {
    throw new ValidationError("System backup is truncated or has extra uploaded parts");
  }
  const db = getD1();
  try {
    await db.prepare("DELETE FROM system_backup_rows WHERE job_id = ?").bind(jobId).run();
    await db.prepare("DELETE FROM system_backup_objects WHERE job_id = ?").bind(jobId).run();
    await stageObjectLedger(jobId, manifest.objects);
    await persistCompletedManifest(jobId, manifest);
    const stateHasher = new IncrementalSha256();
    stateHasher.update(encoder.encode(`schema:${manifest.schemaFingerprint}\n`));
    const transition = await db.prepare(`UPDATE system_backup_jobs
      SET status = 'running', phase = 'validating_parts', phase_cursor = '0',
          hash_state_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND kind = 'import' AND status = 'uploading'
        AND phase = 'uploading' AND next_part_index = ?`)
      .bind(stateHasher.snapshot(), jobId, manifest.parts.length).run();
    if (transition.meta.changes !== 1) {
      throw new ValidationError("System backup finalize changed concurrently");
    }
  } catch (error) {
    await failJob(jobId, error);
    throw error;
  }
  return getSystemBackupJobStatus(currentUser, jobId);
}

export async function applySystemBackupImport(
  currentUser: UserRecord,
  input: { importId: string; sha256: string; confirmation: string },
): Promise<SystemBackupJobStatus> {
  assertConfiguredAdmin(currentUser);
  if (input.confirmation !== "RESTORE") {
    throw new ValidationError("Type RESTORE to confirm replacement");
  }
  const job = await requireOwnedJob(currentUser, input.importId, "import");
  if (job.root_sha256 !== input.sha256) {
    throw new ValidationError("System backup digest does not match the staged import");
  }
  if (job.status === "applied" || job.status === "cleanup_pending") {
    return getSystemBackupJobStatus(currentUser, job.id);
  }
  if (job.status === "running" || job.status === "applying") {
    return getSystemBackupJobStatus(currentUser, job.id);
  }
  if (!job.root_sha256 || job.status !== "ready") {
    throw new ValidationError("System backup import is not ready to apply");
  }
  const transition = await getD1().prepare(`UPDATE system_backup_jobs
    SET status = 'running', phase = 'apply_revalidate_rows', phase_cursor = ?,
        hash_state_json = ?, error_code = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND created_by_user_id = ? AND kind = 'import'
      AND status = 'ready' AND phase = 'ready'`)
    .bind(
      JSON.stringify({ table: 0, ordinal: 0 }),
      new IncrementalSha256().update(encoder.encode(`schema:${job.schema_fingerprint}\n`)).snapshot(),
      job.id,
      currentUser.id,
    ).run();
  if (transition.meta.changes !== 1) {
    throw new ValidationError("System backup apply was claimed concurrently");
  }
  return getSystemBackupJobStatus(currentUser, job.id);
}

export async function advanceSystemBackupJob(
  currentUser: UserRecord,
  jobId: string,
): Promise<SystemBackupJobStatus> {
  assertConfiguredAdmin(currentUser);
  await cleanupExpiredSystemBackupJobs();
  let job = await requireOwnedJob(currentUser, jobId);
  if (["ready", "applied", "failed", "expired"].includes(job.status)) {
    return getSystemBackupJobStatus(currentUser, jobId);
  }
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + jobLeaseSeconds * 1000).toISOString();
  const claim = await getD1().prepare(`UPDATE system_backup_jobs
    SET lease_token = ?, lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND created_by_user_id = ?
      AND (lease_token IS NULL OR datetime(lease_expires_at) <= datetime('now'))`)
    .bind(leaseToken, leaseExpiresAt, jobId, currentUser.id).run();
  if (claim.meta.changes !== 1) {
    throw new ValidationError("System backup job is already advancing");
  }
  let dependency: string | null = null;
  try {
    job = (await getD1().prepare(`SELECT * FROM system_backup_jobs
      WHERE id = ? AND lease_token = ?`).bind(jobId, leaseToken)
      .first<BackupJobRow>())!;
    dependency = await advanceSystemBackupJobPhase(job, currentUser, leaseToken);
  } catch (error) {
    const fresh = await getD1().prepare(`SELECT d1_committed_at, phase FROM system_backup_jobs WHERE id = ?`)
      .bind(job.id).first<{ d1_committed_at: string | null; phase: string }>();
    if (fresh?.d1_committed_at) {
      const postCommitError = error instanceof Error && /Applied D1 state differs from backup table ([a-z_]+)/.test(error.message)
        ? `applied_state_mismatch:${/Applied D1 state differs from backup table ([a-z_]+)/.exec(error.message)?.[1]}`
        : job.phase === "cleanup" ? "cleanup_failed" : "post_commit_attention";
      await getD1().prepare(`UPDATE system_backup_jobs SET
        status = CASE WHEN phase = 'cleanup' THEN 'cleanup_pending' ELSE 'running' END,
        phase = CASE WHEN phase = 'd1_cutover' THEN 'verifying_d1' ELSE phase END,
        error_code = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(postCommitError, job.id).run();
      return getSystemBackupJobStatus(currentUser, job.id);
    }
    if (error instanceof ValidationError) {
      await failJob(job.id, error);
    } else {
      await getD1().prepare(`UPDATE system_backup_jobs
        SET status = 'running', error_code = ?, attempt_count = attempt_count + 1,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(safeErrorCode(error), job.id).run();
    }
    throw error;
  } finally {
    await getD1().prepare(`UPDATE system_backup_jobs
      SET lease_token = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND lease_token = ?`).bind(jobId, leaseToken).run();
  }
  if (dependency) {
    const dependencyStatus = await getSystemBackupJobStatus(currentUser, dependency);
    if (!dependencyStatus.status.match(/^(ready|failed|expired)$/)) {
      await advanceSystemBackupJob(currentUser, dependency);
    }
  }
  return getSystemBackupJobStatus(currentUser, jobId);
}

export async function advanceSystemBackupExportSlice(
  currentUser: UserRecord,
  jobId: string,
  options: { maximumSteps?: number; maximumDurationMs?: number } = {},
): Promise<SystemBackupJobStatus> {
  assertConfiguredAdmin(currentUser);
  await cleanupExpiredSystemBackupJobs();
  let job = await requireOwnedJob(currentUser, jobId);
  if (job.kind !== "export" && job.kind !== "rollback") {
    throw new ValidationError("System backup export slice requires an export job");
  }
  if (["ready", "failed", "expired"].includes(job.status)) {
    return getSystemBackupJobStatus(currentUser, jobId);
  }
  const maximumSteps = Math.max(1, Math.min(128, options.maximumSteps ?? 24));
  const maximumDurationMs = Math.max(100, Math.min(10_000, options.maximumDurationMs ?? 1_500));
  const deadline = Date.now() + maximumDurationMs;
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + jobLeaseSeconds * 1000).toISOString();
  const claim = await getD1().prepare(`UPDATE system_backup_jobs
    SET lease_token = ?, lease_expires_at = ?
    WHERE id = ? AND created_by_user_id = ?
      AND (lease_token IS NULL OR datetime(lease_expires_at) <= datetime('now'))`)
    .bind(leaseToken, leaseExpiresAt, jobId, currentUser.id).run();
  if (claim.meta.changes !== 1) {
    return {
      ...await getSystemBackupJobStatus(currentUser, jobId),
      advanceDeferred: true,
    };
  }
  try {
    for (let step = 0; step < maximumSteps && Date.now() < deadline; step += 1) {
      const leasedJob = await getD1().prepare(`SELECT * FROM system_backup_jobs
        WHERE id = ? AND lease_token = ?`).bind(jobId, leaseToken)
        .first<BackupJobRow>();
      if (!leasedJob) throw new Error("System backup export lease was lost");
      job = leasedJob;
      if (["ready", "failed", "expired"].includes(job.status)) break;
      await advanceSystemBackupJobPhase(job, currentUser, leaseToken);
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      await failJob(job.id, error);
    } else {
      await getD1().prepare(`UPDATE system_backup_jobs
        SET status = 'running', error_code = ?, attempt_count = attempt_count + 1,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(safeErrorCode(error), job.id).run();
    }
    throw error;
  } finally {
    await getD1().prepare(`UPDATE system_backup_jobs
      SET lease_token = NULL, lease_expires_at = NULL
      WHERE id = ? AND lease_token = ?`).bind(jobId, leaseToken).run();
  }
  return getSystemBackupJobStatus(currentUser, jobId);
}

async function advanceSystemBackupJobPhase(
  job: BackupJobRow,
  currentUser: UserRecord,
  leaseToken: string,
): Promise<string | null> {
  switch (job.phase) {
    case "inventory_r2":
      await advanceExportInventory(job);
      break;
    case "hash_objects":
      await advanceExportObjectHash(job);
      break;
    case "build_rows":
      await advanceExportRows(job);
      break;
    case "build_object_parts":
      await advanceExportObjectParts(job);
      break;
    case "state_digest_rows":
      await advanceStateDigestRows(job);
      break;
    case "state_digest_objects":
      await advanceStateDigestObjects(job);
      break;
    case "finalize_export":
      await finalizeExportManifest(job);
      break;
    case "validating_parts":
      await advancePackagePartValidation(job);
      break;
    case "validating_objects":
      await advancePackageObjectValidation(job);
      break;
    case "preflight":
      await advancePackagePreflight(job, currentUser);
      break;
    case "revalidate_r2":
      await advanceExportR2Revalidation(job);
      break;
    case "apply_revalidate_rows":
      await advanceApplyRowRevalidation(job);
      break;
    case "apply_revalidate_objects":
      await advanceApplyObjectRevalidation(job);
      break;
    case "prepare_rollback":
      return prepareRollbackDependency(job, currentUser);
    case "waiting_rollback":
      return advanceRollbackDependency(job);
    case "materializing":
      await advanceImportMaterialization(job);
      break;
    case "d1_cutover":
      await commitExactReplace(job.id, job.rollback_job_id!, leaseToken);
      break;
    case "verifying_d1":
      await advanceAppliedD1Verification(job, currentUser.id);
      break;
    case "verifying_objects":
      await advanceAppliedObjectVerification(job);
      break;
    case "cleanup":
      await advanceCommittedCleanup(job);
      break;
    default:
      throw new ValidationError(`Unknown system backup phase ${job.phase}`);
  }
  return null;
}

export async function getSystemBackupJobStatus(
  currentUser: UserRecord,
  jobId: string,
): Promise<SystemBackupJobStatus> {
  assertConfiguredAdmin(currentUser);
  const job = await requireOwnedJob(currentUser, jobId);
  return statusFromRow(job);
}

export async function streamSystemBackupPackage(
  currentUser: UserRecord,
  jobId: string,
  fromPart = 0,
): Promise<Response> {
  assertConfiguredAdmin(currentUser);
  const job = await requireOwnedJob(currentUser, jobId);
  if ((job.kind !== "export" && job.kind !== "rollback") || job.status !== "ready") {
    throw new ValidationError("System backup export is not ready for download");
  }
  if (!Number.isInteger(fromPart) || fromPart < 0 || fromPart > job.part_count) {
    throw new ValidationError("Invalid system backup resume part");
  }
  const manifest = await readJobManifest(job);
  const header: SystemBackupPackageHeader = {
    format: systemBackupPackageFormat,
    version: systemBackupPackageVersion,
    frame: "header",
    schemaVersion: systemBackupCurrentSchemaVersion,
    schemaFingerprint: job.schema_fingerprint,
    siteOrigin: job.site_origin,
    environmentScope: job.environment_scope,
    exportedAt: job.exported_at!,
  };
  const db = getD1();
  const partRows = await db.prepare(`SELECT object_key FROM system_backup_parts
    WHERE job_id = ? AND part_index >= ? ORDER BY part_index`)
    .bind(jobId, fromPart).all<{ object_key: string }>();
  const bucket = getAttachmentBucket();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encodePackageLine(header));
        for (const part of partRows.results) {
          const object = await bucket.get(part.object_key);
          if (!object) throw new Error("Stored system backup part is missing");
          const reader = object.body.getReader();
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            controller.enqueue(result.value);
          }
        }
        controller.enqueue(encodePackageLine(manifest));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  const date = job.exported_at!.slice(0, 10);
  return new Response(body, {
    headers: {
      "cache-control": "no-store, max-age=0",
      "content-disposition": `attachment; filename="task-manager-${job.kind}-${date}.tmbak"`,
      "content-type": systemBackupPackageMediaType,
      "x-content-type-options": "nosniff",
      "x-task-manager-first-part": String(fromPart),
      "x-task-manager-part-count": String(job.part_count),
      "x-task-manager-backup-sha256": job.root_sha256!,
    },
  });
}

export function assertSystemBackupAction(request: Request) {
  if (request.headers.get("x-task-manager-action") !== systemBackupAction) {
    throw Object.assign(new Error("Invalid system backup request"), { status: 403 });
  }
}

export function systemBackupRequestOrigin(request: Request) {
  return new URL(request.url).origin;
}

async function advanceExportInventory(job: BackupJobRow) {
  const page = await getAttachmentBucket().list({
    limit: 250,
    ...(job.phase_cursor ? { cursor: job.phase_cursor } : {}),
  });
  const db = getD1();
  const internalMaterializedKeys = await readUncommittedMaterializedKeys(
    page.objects
      .map((object) => object.key)
      .filter((key) => !key.startsWith(`${attachmentStorageScope()}/backup-staging/`)),
  );
  const current = await db.prepare(`SELECT COALESCE(MAX(ordinal), -1) AS ordinal
    FROM system_backup_objects WHERE job_id = ?`).bind(job.id)
    .first<{ ordinal: number }>();
  let ordinal = Number(current?.ordinal ?? -1) + 1;
  const statements: D1PreparedStatement[] = [];
  for (const object of page.objects) {
    if (internalMaterializedKeys.has(object.key)) continue;
    const classified = classifyManagedObjectKey(object.key);
    if (!classified) continue;
    statements.push(db.prepare(`INSERT INTO system_backup_objects
      (job_id, ordinal, logical_ref, namespace, source_object_key, byte_size,
       sha256, etag, state)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'inventory')`)
      .bind(
        job.id,
        ordinal,
        `pending:${ordinal}`,
        classified.namespace,
        object.key,
        object.size,
        object.etag ?? null,
      ));
    ordinal += 1;
  }
  if (statements.length) await db.batch(statements);
  if (page.truncated && page.cursor) {
    await db.prepare(`UPDATE system_backup_jobs SET phase_cursor = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(page.cursor, job.id).run();
  } else {
    await db.prepare(`UPDATE system_backup_jobs
      SET phase = 'hash_objects', phase_cursor = '0', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).bind(job.id).run();
  }
}

async function advanceExportObjectHash(job: BackupJobRow) {
  const ordinal = Number(job.phase_cursor ?? "0");
  const db = getD1();
  const object = await db.prepare(`SELECT * FROM system_backup_objects
    WHERE job_id = ? AND ordinal = ?`).bind(job.id, ordinal).first<DbRow>();
  if (!object) {
    await db.prepare(`UPDATE system_backup_jobs
      SET phase = 'build_rows', phase_cursor = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).bind(JSON.stringify({ table: 0, ordinal: 0, nextPart: 0 }), job.id).run();
    return;
  }
  const sourceKey = String(object.source_object_key);
  const byteSize = Number(object.byte_size);
  const processed = Number(object.processed_bytes);
  const chunkIndex = Number(object.next_chunk_index);
  const length = Math.min(systemBackupObjectChunkBytes, byteSize - processed);
  const bytes = length > 0
    ? await readR2Range(sourceKey, processed, length)
    : new Uint8Array(0);
  const hasher = IncrementalSha256.fromSnapshot(
    object.hash_state_json === null ? null : String(object.hash_state_json),
  );
  hasher.update(bytes);
  const rawKey = rawObjectChunkKey(job.id, ordinal, chunkIndex);
  await getAttachmentBucket().put(rawKey, bytes, {
    customMetadata: { backupJob: job.id, ordinal: String(ordinal) },
  });
  const nextProcessed = processed + bytes.byteLength;
  if (nextProcessed < byteSize) {
    await db.prepare(`UPDATE system_backup_objects
      SET state = 'hashing', processed_bytes = ?, next_chunk_index = ?,
          hash_state_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND ordinal = ?`)
      .bind(nextProcessed, chunkIndex + 1, hasher.snapshot(), job.id, ordinal).run();
    return;
  }
  const sha256 = hasher.digestHex();
  const binding = await stableObjectBinding(job.id, sourceKey, String(object.namespace), sha256, ordinal);
  await db.prepare(`UPDATE system_backup_objects
    SET logical_ref = ?, sha256 = ?, bound_kind = ?, is_orphan = ?,
        processed_bytes = ?, next_chunk_index = ?, hash_state_json = NULL,
        state = 'frozen', updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ? AND ordinal = ?`)
    .bind(
      binding.logicalRef,
      sha256,
      binding.boundKind,
      binding.orphan ? 1 : 0,
      nextProcessed,
      chunkIndex + 1,
      job.id,
      ordinal,
    ).run();
  await db.prepare(`UPDATE system_backup_jobs SET phase_cursor = ?,
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(String(ordinal + 1), job.id).run();
}

async function advanceExportRows(job: BackupJobRow) {
  const cursor = parseCursor(job.phase_cursor, { table: 0, ordinal: 0, nextPart: 0 });
  const db = getD1();
  let tableIndex = cursor.table;
  let ordinal = cursor.ordinal;
  while (tableIndex < tableDefinitions.length) {
    const table = tableDefinitions[tableIndex]!;
    const page = await db.prepare(`SELECT ordinal, row_json FROM system_backup_rows
      WHERE job_id = ? AND table_name = ? AND ordinal >= ?
      ORDER BY ordinal LIMIT 25`).bind(job.id, table.name, ordinal)
      .all<{ ordinal: number; row_json: string }>();
    if (!page.results.length) {
      tableIndex += 1;
      ordinal = 0;
      continue;
    }
    const records: Record<string, string | number | null>[] = [];
    let estimated = 2;
    for (const source of page.results) {
      const normalized = normalizeDbRow(table, JSON.parse(source.row_json) as DbRow);
      const portable = await normalizePortableObjectKey(job.id, table.name, normalized);
      const rowBytes = encoder.encode(JSON.stringify(portable)).byteLength + 1;
      if (records.length && estimated + rowBytes > targetSystemBackupPartBytes) break;
      records.push(portable);
      estimated += rowBytes;
    }
    const frame = await createRowsFrame({
      index: cursor.nextPart,
      table: table.name,
      ordinal,
      records,
    });
    await putPackagePart(job.id, frame);
    await db.prepare(`UPDATE system_backup_jobs
      SET phase_cursor = ?, part_count = part_count + 1,
          next_part_index = next_part_index + 1,
          total_bytes = total_bytes + ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).bind(
        JSON.stringify({ table: tableIndex, ordinal: ordinal + records.length, nextPart: cursor.nextPart + 1 }),
        frame.byteLength,
        job.id,
      ).run();
    return;
  }
  await db.prepare(`UPDATE system_backup_jobs
    SET phase = 'build_object_parts', phase_cursor = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).bind(JSON.stringify({ object: 0, chunk: 0, nextPart: cursor.nextPart }), job.id).run();
}

async function advanceExportObjectParts(job: BackupJobRow) {
  const cursor = parseCursor(job.phase_cursor, { object: 0, chunk: 0, nextPart: job.next_part_index });
  const db = getD1();
  const object = await db.prepare(`SELECT * FROM system_backup_objects
    WHERE job_id = ? AND ordinal = ? AND state = 'frozen'`)
    .bind(job.id, cursor.object).first<DbRow>();
  if (!object) {
    const initial = new IncrementalSha256();
    initial.update(encoder.encode(`schema:${job.schema_fingerprint}\n`));
    await db.prepare(`UPDATE system_backup_jobs
      SET phase = 'state_digest_rows', phase_cursor = '0', hash_state_json = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(initial.snapshot(), job.id).run();
    return;
  }
  const totalChunks = Number(object.next_chunk_index);
  const rawKey = rawObjectChunkKey(job.id, cursor.object, cursor.chunk);
  const raw = await getAttachmentBucket().get(rawKey);
  if (!raw) throw new Error("Frozen system backup object chunk is missing");
  const bytes = await readBoundedR2Object(raw, systemBackupObjectChunkBytes);
  const frame = await createObjectFrame({
    index: cursor.nextPart,
    objectOrdinal: cursor.object,
    logicalRef: String(object.logical_ref),
    bytes,
  });
  await putPackagePart(job.id, frame);
  const firstPart = cursor.chunk === 0 ? cursor.nextPart : Number(object.first_part_index);
  const nextChunk = cursor.chunk + 1;
  const nextObject = nextChunk >= totalChunks ? cursor.object + 1 : cursor.object;
  await db.batch([
    db.prepare(`UPDATE system_backup_objects
      SET first_part_index = ?, part_count = part_count + 1,
          updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND ordinal = ?`)
      .bind(firstPart, job.id, cursor.object),
    db.prepare(`UPDATE system_backup_jobs
      SET phase_cursor = ?, part_count = part_count + 1,
          next_part_index = next_part_index + 1,
          total_bytes = total_bytes + ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).bind(
        JSON.stringify({
          object: nextObject,
          chunk: nextChunk >= totalChunks ? 0 : nextChunk,
          nextPart: cursor.nextPart + 1,
        }),
        frame.byteLength,
        job.id,
      ),
  ]);
}

async function advanceStateDigestRows(job: BackupJobRow) {
  const partIndex = Number(job.phase_cursor ?? "0");
  const row = await getD1().prepare(`SELECT part_index FROM system_backup_parts
    WHERE job_id = ? AND part_type = 'rows' AND part_index >= ?
    ORDER BY part_index LIMIT 1`).bind(job.id, partIndex)
    .first<{ part_index: number }>();
  if (!row) {
    await getD1().prepare(`UPDATE system_backup_jobs
      SET phase = 'state_digest_objects', phase_cursor = '0',
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(job.id).run();
    return;
  }
  const frame = await readAndValidatePart(job.id, row.part_index);
  if (frame.frame !== "rows") throw new Error("State digest encountered a non-row frame");
  const hasher = IncrementalSha256.fromSnapshot(job.hash_state_json);
  frame.records.forEach((record, index) => {
    hasher.update(encoder.encode(
      `${frame.table}\0${frame.ordinal + index}\0${canonicalJson(record)}\n`,
    ));
  });
  await getD1().prepare(`UPDATE system_backup_jobs
    SET phase_cursor = ?, hash_state_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).bind(String(row.part_index + 1), hasher.snapshot(), job.id).run();
}

async function advanceStateDigestObjects(job: BackupJobRow) {
  const ordinal = Number(job.phase_cursor ?? "0");
  const object = await getD1().prepare(`SELECT ordinal, logical_ref, namespace,
      byte_size, sha256, bound_kind, is_orphan
    FROM system_backup_objects WHERE job_id = ? AND ordinal = ?`)
    .bind(job.id, ordinal).first<DbRow>();
  if (!object) {
    const hasher = IncrementalSha256.fromSnapshot(job.hash_state_json);
    const stateSha = hasher.digestHex();
    if (job.kind === "import") {
      const manifest = await readJobManifest(job);
      if (stateSha !== manifest.stateSha256) {
        throw new ValidationError("System backup canonical state digest does not match");
      }
      await getD1().prepare(`UPDATE system_backup_jobs
        SET state_sha256 = ?, phase = 'preflight', phase_cursor = NULL,
            hash_state_json = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(stateSha, job.id).run();
    } else {
      await getD1().prepare(`UPDATE system_backup_jobs
        SET state_sha256 = ?, phase = 'finalize_export', phase_cursor = NULL,
            hash_state_json = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).bind(stateSha, job.id).run();
    }
    return;
  }
  const hasher = IncrementalSha256.fromSnapshot(job.hash_state_json);
  hasher.update(encoder.encode(
    `object\0${object.logical_ref}\0${object.byte_size}\0${object.sha256}\n`,
  ));
  await getD1().prepare(`UPDATE system_backup_jobs
    SET phase_cursor = ?, hash_state_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).bind(String(ordinal + 1), hasher.snapshot(), job.id).run();
}

async function finalizeExportManifest(job: BackupJobRow) {
  const refreshed = await getD1().prepare("SELECT * FROM system_backup_jobs WHERE id = ?")
    .bind(job.id).first<BackupJobRow>();
  if (!refreshed?.state_sha256) throw new Error("System backup state digest is missing");
  const manifest = await buildManifestFromLedger(refreshed);
  await persistCompletedManifest(job.id, manifest);
  await getD1().prepare(`UPDATE system_backup_jobs
    SET phase = 'validating_parts', phase_cursor = '0', status = 'running',
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(job.id).run();
}

async function advancePackagePartValidation(job: BackupJobRow) {
  const manifest = await readJobManifest(job);
  const index = Number(job.phase_cursor ?? "0");
  if (index >= manifest.parts.length) {
    await getD1().prepare(`UPDATE system_backup_jobs
      SET phase = 'validating_objects', phase_cursor = '0', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).bind(job.id).run();
    return;
  }
  const frame = await readAndValidatePart(job.id, index);
  if (JSON.stringify(descriptorOf(frame)) !== JSON.stringify(manifest.parts[index])) {
    throw new ValidationError(`System backup part ${index} does not match its manifest`);
  }
  if (job.kind === "import" && frame.frame === "rows") {
    await stageOneRowsFrame(job.id, frame);
    const hasher = IncrementalSha256.fromSnapshot(job.hash_state_json);
    frame.records.forEach((record, ordinalOffset) => hasher.update(encoder.encode(
      `${frame.table}\0${frame.ordinal + ordinalOffset}\0${canonicalJson(record)}\n`,
    )));
    await getD1().prepare(`UPDATE system_backup_jobs SET hash_state_json = ?
      WHERE id = ?`).bind(hasher.snapshot(), job.id).run();
  }
  await getD1().prepare(`UPDATE system_backup_jobs SET phase_cursor = ?,
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(String(index + 1), job.id).run();
}

async function advancePackageObjectValidation(job: BackupJobRow) {
  const manifest = await readJobManifest(job);
  const cursor = parseCursor(job.phase_cursor, { object: 0, chunk: 0 });
  const object = manifest.objects[cursor.object];
  if (!object) {
    if (job.kind === "import") {
      const stateHasher = new IncrementalSha256();
      stateHasher.update(encoder.encode(`schema:${manifest.schemaFingerprint}\n`));
      await getD1().prepare(`UPDATE system_backup_jobs
        SET phase = 'state_digest_rows', phase_cursor = '0',
            hash_state_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(stateHasher.snapshot(), job.id).run();
    } else {
      await getD1().prepare(`UPDATE system_backup_jobs
        SET phase = 'preflight', phase_cursor = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).bind(job.id).run();
    }
    return;
  }
  const ledger = await getD1().prepare(`SELECT hash_state_json, processed_bytes
    FROM system_backup_objects WHERE job_id = ? AND ordinal = ?`)
    .bind(job.id, cursor.object).first<{ hash_state_json: string | null; processed_bytes: number }>();
  if (!ledger) throw new ValidationError("System backup object ledger is missing");
  const partIndex = object.firstPartIndex + cursor.chunk;
  const validated = await validateDataFrame(await readAndValidatePart(job.id, partIndex));
  if (validated.frame.frame !== "object" || validated.frame.logicalRef !== object.logicalRef) {
    throw new ValidationError(`Object ${object.logicalRef} has a foreign part`);
  }
  const hasher = IncrementalSha256.fromSnapshot(ledger.hash_state_json);
  hasher.update(validated.payload);
  const processed = Number(ledger.processed_bytes) + validated.payload.byteLength;
  const nextChunk = cursor.chunk + 1;
  if (nextChunk >= object.partCount) {
    if (processed !== object.byteSize || hasher.digestHex() !== object.sha256) {
      throw new ValidationError(`Object ${object.logicalRef} checksum or size does not match`);
    }
    await getD1().prepare(`UPDATE system_backup_objects
      SET hash_state_json = NULL, processed_bytes = ?, state = 'verified',
          updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND ordinal = ?`)
      .bind(processed, job.id, cursor.object).run();
    if (job.kind === "import") {
      const refreshed = await getD1().prepare(`SELECT hash_state_json FROM system_backup_jobs WHERE id = ?`)
        .bind(job.id).first<{ hash_state_json: string }>();
      const stateHasher = IncrementalSha256.fromSnapshot(refreshed?.hash_state_json);
      stateHasher.update(encoder.encode(
        `object\0${object.logicalRef}\0${object.byteSize}\0${object.sha256}\n`,
      ));
      await getD1().prepare(`UPDATE system_backup_jobs SET hash_state_json = ? WHERE id = ?`)
        .bind(stateHasher.snapshot(), job.id).run();
    }
    await getD1().prepare(`UPDATE system_backup_jobs SET phase_cursor = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(JSON.stringify({ object: cursor.object + 1, chunk: 0 }), job.id).run();
  } else {
    await getD1().prepare(`UPDATE system_backup_objects
      SET hash_state_json = ?, processed_bytes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND ordinal = ?`)
      .bind(hasher.snapshot(), processed, job.id, cursor.object).run();
    await getD1().prepare(`UPDATE system_backup_jobs SET phase_cursor = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(JSON.stringify({ object: cursor.object, chunk: nextChunk }), job.id).run();
  }
}

async function advancePackagePreflight(job: BackupJobRow, currentUser: UserRecord) {
  const manifest = await readJobManifest(job);
  await verifyStagedRowsMatchParts(job.id, manifest);
  await validateSystemBackupStagedState(job.id, manifest.counts, currentUser.id);
  if (job.kind === "import") {
    if (job.state_sha256 && job.state_sha256 !== manifest.stateSha256) {
      throw new ValidationError("System backup canonical state digest does not match");
    }
    await markJobReady(job.id);
  } else {
    await getD1().prepare(`UPDATE system_backup_jobs
      SET phase = 'revalidate_r2', phase_cursor = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).bind(JSON.stringify({ cursor: null, seen: 0 }), job.id).run();
  }
}

async function advanceExportR2Revalidation(job: BackupJobRow) {
  const cursor = parseCursor(job.phase_cursor, { cursor: null as string | null, seen: 0 });
  const stagingPrefix = `${attachmentStorageScope()}/backup-staging/`;
  const page = await getAttachmentBucket().list({
    limit: 250,
    ...(cursor.cursor ? { cursor: cursor.cursor } : {}),
  });
  const internalMaterializedKeys = await readUncommittedMaterializedKeys(
    page.objects
      .map((object) => object.key)
      .filter((key) => !key.startsWith(stagingPrefix)),
  );
  let seen = cursor.seen;
  for (const object of page.objects) {
    if (object.key.startsWith(stagingPrefix) || internalMaterializedKeys.has(object.key)) continue;
    const classified = classifyManagedObjectKey(object.key);
    if (!classified) continue;
    const match = await getD1().prepare(`SELECT 1 FROM system_backup_objects
      WHERE job_id = ? AND source_object_key = ? AND byte_size = ?
        AND (etag = ? OR (etag IS NULL AND ? IS NULL))`)
      .bind(job.id, object.key, object.size, object.etag ?? null, object.etag ?? null).first();
    if (!match) throw new ValidationError("R2 inventory changed while the system backup was frozen");
    seen += 1;
  }
  if (page.truncated && page.cursor) {
    await getD1().prepare(`UPDATE system_backup_jobs SET phase_cursor = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(JSON.stringify({ cursor: page.cursor, seen }), job.id).run();
    return;
  }
  const expected = await getD1().prepare(`SELECT COUNT(*) AS count FROM system_backup_objects
    WHERE job_id = ?`).bind(job.id).first<{ count: number }>();
  if (seen !== Number(expected?.count ?? -1)) {
    throw new ValidationError("R2 inventory changed while the system backup was frozen");
  }
  await markJobReady(job.id);
}

async function advanceApplyRowRevalidation(job: BackupJobRow) {
  const cursor = parseCursor(job.phase_cursor, { table: 0, ordinal: 0 });
  let tableIndex = cursor.table;
  let ordinal = cursor.ordinal;
  const db = getD1();
  while (tableIndex < tableDefinitions.length) {
    const table = tableDefinitions[tableIndex]!;
    const rows = await db.prepare(`SELECT ordinal, row_json FROM system_backup_rows
      WHERE job_id = ? AND table_name = ? AND ordinal >= ?
      ORDER BY ordinal LIMIT 25`).bind(job.id, table.name, ordinal)
      .all<{ ordinal: number; row_json: string }>();
    if (!rows.results.length) {
      tableIndex += 1;
      ordinal = 0;
      continue;
    }
    const hasher = IncrementalSha256.fromSnapshot(job.hash_state_json);
    for (const row of rows.results) {
      if (row.ordinal !== ordinal) throw new ValidationError(`Staged ${table.name} rows changed before apply`);
      const normalized = normalizeDbRow(table, JSON.parse(row.row_json) as DbRow);
      hasher.update(encoder.encode(`${table.name}\0${row.ordinal}\0${canonicalJson(normalized)}\n`));
      ordinal += 1;
    }
    await db.prepare(`UPDATE system_backup_jobs SET phase_cursor = ?, hash_state_json = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(
      JSON.stringify({ table: tableIndex, ordinal }),
      hasher.snapshot(),
      job.id,
    ).run();
    return;
  }
  await db.prepare(`UPDATE system_backup_jobs SET phase = 'apply_revalidate_objects',
    phase_cursor = '0', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(job.id).run();
}

async function advanceApplyObjectRevalidation(job: BackupJobRow) {
  const ordinal = Number(job.phase_cursor ?? "0");
  const object = await getD1().prepare(`SELECT logical_ref, byte_size, sha256, state
    FROM system_backup_objects WHERE job_id = ? AND ordinal = ?`)
    .bind(job.id, ordinal).first<{ logical_ref: string; byte_size: number; sha256: string; state: string }>();
  if (!object) {
    const stateSha = IncrementalSha256.fromSnapshot(job.hash_state_json).digestHex();
    if (stateSha !== job.state_sha256) throw new ValidationError("Staged system backup changed before apply");
    await getD1().prepare(`UPDATE system_backup_jobs SET phase = 'prepare_rollback',
      phase_cursor = NULL, hash_state_json = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).bind(job.id).run();
    return;
  }
  if (object.state !== "verified" && object.state !== "staged") {
    throw new ValidationError("Staged object ledger changed before apply");
  }
  const hasher = IncrementalSha256.fromSnapshot(job.hash_state_json);
  hasher.update(encoder.encode(
    `object\0${object.logical_ref}\0${object.byte_size}\0${object.sha256}\n`,
  ));
  await getD1().prepare(`UPDATE system_backup_jobs SET phase_cursor = ?, hash_state_json = ?,
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(String(ordinal + 1), hasher.snapshot(), job.id).run();
}

async function prepareRollbackDependency(job: BackupJobRow, currentUser: UserRecord) {
  if (job.rollback_job_id) {
    await getD1().prepare(`UPDATE system_backup_jobs
      SET phase = 'waiting_rollback', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(job.id).run();
    return job.rollback_job_id;
  }
  const rollback = await createSystemBackupExportJob(currentUser, {
    kind: "rollback",
    parentJobId: job.id,
    siteOrigin: job.site_origin,
  });
  const transition = await getD1().prepare(`UPDATE system_backup_jobs
    SET rollback_job_id = ?, phase = 'waiting_rollback', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND lease_token = ? AND rollback_job_id IS NULL`)
    .bind(rollback.jobId, job.id, job.lease_token).run();
  if (transition.meta.changes !== 1) {
    throw new ValidationError("Rollback snapshot linkage changed concurrently");
  }
  return rollback.jobId;
}

async function advanceRollbackDependency(job: BackupJobRow): Promise<string | null> {
  if (!job.rollback_job_id) throw new Error("Rollback snapshot dependency is missing");
  const rollback = await getD1().prepare(`SELECT status FROM system_backup_jobs WHERE id = ?`)
    .bind(job.rollback_job_id).first<{ status: string }>();
  if (!rollback || rollback.status === "failed" || rollback.status === "expired") {
    throw new Error("Rollback snapshot could not be completed");
  }
  if (rollback.status !== "ready") return job.rollback_job_id;
  await getD1().prepare(`UPDATE system_backup_jobs
    SET phase = 'materializing', phase_cursor = '0', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).bind(job.id).run();
  return null;
}

async function advanceImportMaterialization(job: BackupJobRow) {
  const manifest = await readJobManifest(job);
  const ordinal = Number(job.phase_cursor ?? "0");
  const object = manifest.objects[ordinal];
  if (!object) {
    await getD1().prepare(`UPDATE system_backup_jobs
      SET phase = 'd1_cutover', phase_cursor = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).bind(job.id).run();
    return;
  }
  const db = getD1();
  const ledger = await db.prepare(`SELECT * FROM system_backup_objects
    WHERE job_id = ? AND ordinal = ?`).bind(job.id, ordinal).first<DbRow>();
  if (!ledger) throw new Error("Import object ledger is missing");
  if (ledger.state === "materialized") {
    await db.prepare(`UPDATE system_backup_jobs SET phase_cursor = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(String(ordinal + 1), job.id).run();
    return;
  }
  const targetKey = ledger.staged_object_key
    ? String(ledger.staged_object_key)
    : `${attachmentStorageScope()}/${object.namespace}/system-restore/${safeJobPath(job.id)}/${object.logicalRef}`;
  const alreadyStored = await getAttachmentBucket().head(targetKey);
  if (
    alreadyStored?.size === object.byteSize &&
    alreadyStored.customMetadata?.sha256 === object.sha256
  ) {
    await db.prepare(`UPDATE system_backup_objects SET staged_object_key = ?,
      materialized_object_key = ?, state = 'materialized', updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND ordinal = ?`).bind(targetKey, targetKey, job.id, ordinal).run();
    await db.prepare(`UPDATE system_backup_jobs SET phase_cursor = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(String(ordinal + 1), job.id).run();
    return;
  }
  let uploadId = ledger.multipart_upload_id === null ? null : String(ledger.multipart_upload_id);
  let uploadedParts = JSON.parse(String(ledger.multipart_parts_json ?? "[]")) as R2UploadedPart[];
  if (!uploadId) {
    const upload = await getAttachmentBucket().createMultipartUpload(targetKey, {
      customMetadata: {
        sha256: object.sha256,
        logicalRef: object.logicalRef,
        restoreJob: job.id,
      },
    });
    uploadId = upload.uploadId;
    await db.prepare(`UPDATE system_backup_objects
      SET staged_object_key = ?, multipart_upload_id = ?, state = 'materializing',
          updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND ordinal = ?`)
      .bind(targetKey, uploadId, job.id, ordinal).run();
  }
  const nextChunk = Number(ledger.next_chunk_index ?? 0);
  const remaining = object.partCount - nextChunk;
  const take = Math.min(14, remaining);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let offset = 0; offset < take; offset += 1) {
    const frame = await readAndValidatePart(job.id, object.firstPartIndex + nextChunk + offset);
    const validated = await validateDataFrame(frame);
    if (validated.frame.frame !== "object" || validated.frame.logicalRef !== object.logicalRef) {
      throw new ValidationError("Object part changed before materialization");
    }
    chunks.push(validated.payload);
    total += validated.payload.byteLength;
  }
  const bytes = new Uint8Array(total);
  let byteOffset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, byteOffset);
    byteOffset += chunk.byteLength;
  }
  const multipart = getAttachmentBucket().resumeMultipartUpload(targetKey, uploadId);
  const uploaded = await multipart.uploadPart(uploadedParts.length + 1, bytes);
  uploadedParts = [...uploadedParts, uploaded];
  const consumed = nextChunk + take;
  if (consumed < object.partCount) {
    await db.prepare(`UPDATE system_backup_objects
      SET next_chunk_index = ?, multipart_parts_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND ordinal = ?`)
      .bind(consumed, JSON.stringify(uploadedParts), job.id, ordinal).run();
    return;
  }
  await multipart.complete(uploadedParts);
  const stored = await getAttachmentBucket().head(targetKey);
  if (!stored || stored.size !== object.byteSize) {
    throw new Error(`Materialized object ${object.logicalRef} failed size verification`);
  }
  await db.prepare(`UPDATE system_backup_objects
    SET materialized_object_key = ?, next_chunk_index = ?, multipart_parts_json = ?,
        state = 'materialized', updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ? AND ordinal = ?`)
    .bind(targetKey, consumed, JSON.stringify(uploadedParts), job.id, ordinal).run();
  await db.prepare(`UPDATE system_backup_jobs SET phase_cursor = ?,
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(String(ordinal + 1), job.id).run();
}

async function advanceAppliedD1Verification(job: BackupJobRow, currentUserId: string) {
  const manifest = await readJobManifest(job);
  await verifyStagedRowsMatchParts(job.id, manifest);
  await revalidateLiveAgainstJob(job.id, currentUserId);
  await getD1().prepare(`UPDATE system_backup_jobs
    SET phase = 'verifying_objects', phase_cursor = '0', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).bind(job.id).run();
}

async function advanceAppliedObjectVerification(job: BackupJobRow) {
  const manifest = await readJobManifest(job);
  const ordinal = Number(job.phase_cursor ?? "0");
  const object = manifest.objects[ordinal];
  if (!object) {
    await getD1().prepare(`UPDATE system_backup_jobs
      SET status = 'cleanup_pending', phase = 'cleanup', phase_cursor = '0',
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(job.id).run();
    return;
  }
  const ledger = await getD1().prepare(`SELECT materialized_object_key, processed_bytes, hash_state_json
    FROM system_backup_objects WHERE job_id = ? AND ordinal = ?
      AND state IN ('applied_verifying', 'materialized')`)
    .bind(job.id, ordinal).first<{
      materialized_object_key: string;
      processed_bytes: number;
      hash_state_json: string | null;
    }>();
  if (!ledger) throw new Error("Materialized object receipt is missing");
  if (ledger.processed_bytes === object.byteSize && ledger.hash_state_json === null) {
    await getD1().prepare(`UPDATE system_backup_jobs SET phase_cursor = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(String(ordinal + 1), job.id).run();
    return;
  }
  const processed = Number(ledger.processed_bytes);
  const remaining = object.byteSize - processed;
  const bytes = remaining > 0
    ? await readR2Range(ledger.materialized_object_key, processed, Math.min(systemBackupObjectChunkBytes, remaining))
    : new Uint8Array(0);
  if (processed === 0) {
    const head = await getAttachmentBucket().head(ledger.materialized_object_key);
    if (!head || head.size !== object.byteSize) throw new Error("Applied R2 object is missing or truncated");
  }
  const hasher = IncrementalSha256.fromSnapshot(ledger.hash_state_json);
  hasher.update(bytes);
  const nextProcessed = processed + bytes.byteLength;
  if (nextProcessed < object.byteSize) {
    await getD1().prepare(`UPDATE system_backup_objects
      SET processed_bytes = ?, hash_state_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND ordinal = ?`).bind(
      nextProcessed,
      hasher.snapshot(),
      job.id,
      ordinal,
    ).run();
    return;
  }
  if (hasher.digestHex() !== object.sha256) throw new Error("Applied R2 object checksum mismatch");
  await getD1().prepare(`UPDATE system_backup_objects
    SET processed_bytes = ?, hash_state_json = NULL, state = 'materialized',
        updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND ordinal = ?`)
    .bind(nextProcessed, job.id, ordinal).run();
  await getD1().prepare(`UPDATE system_backup_jobs SET phase_cursor = ?,
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(String(ordinal + 1), job.id).run();
}

async function advanceCommittedCleanup(job: BackupJobRow) {
  const ordinal = Number(job.phase_cursor ?? "0");
  const row = await getD1().prepare(`SELECT ordinal, source_object_key
    FROM system_backup_objects WHERE job_id = ? AND state = 'cleanup_pending'
      AND ordinal >= ? ORDER BY ordinal LIMIT 1`)
    .bind(job.id, ordinal).first<{ ordinal: number; source_object_key: string }>();
  if (!row) {
    const part = await getD1().prepare(`SELECT part_index, object_key FROM system_backup_parts
      WHERE job_id = ? ORDER BY part_index LIMIT 1`).bind(job.id)
      .first<{ part_index: number; object_key: string }>();
    if (part) {
      await getAttachmentBucket().delete(part.object_key);
      await getD1().prepare(`DELETE FROM system_backup_parts WHERE job_id = ? AND part_index = ?`)
        .bind(job.id, part.part_index).run();
      return;
    }
    const raw = await getAttachmentBucket().list({
      prefix: `${attachmentStorageScope()}/backup-staging/system-backup/${safeJobPath(job.id)}/objects/`,
      limit: 20,
    });
    if (raw.objects.length) {
      await getAttachmentBucket().delete(raw.objects.map((item) => item.key));
      return;
    }
    await getD1().prepare(`UPDATE system_backup_jobs
      SET status = 'applied', phase = 'applied', error_code = NULL,
          applied_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP,
          phase_cursor = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(job.id).run();
    return;
  }
  await getAttachmentBucket().delete(row.source_object_key);
  await getD1().prepare(`UPDATE system_backup_objects
    SET state = 'cleaned', updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ? AND ordinal = ? AND state = 'cleanup_pending'`)
    .bind(job.id, row.ordinal).run();
  await getD1().prepare(`UPDATE system_backup_jobs SET phase_cursor = ?,
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(String(row.ordinal + 1), job.id).run();
}

async function markJobReady(jobId: string) {
  await getD1().prepare(`UPDATE system_backup_jobs
    SET status = 'ready', phase = 'ready', completed_at = CURRENT_TIMESTAMP,
        phase_cursor = NULL, hash_state_json = NULL, error_code = NULL,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(jobId).run();
}

function parseCursor<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new ValidationError("System backup phase cursor is invalid");
  }
}

function classifyManagedObjectKey(key: string): { namespace: "stored-files" | "attachments" } | null {
  const parts = key.split("/");
  if (parts[0] !== attachmentStorageScope()) {
    throw new ValidationError(`Unknown R2 scope in system backup inventory: ${key}`);
  }
  if (parts[1] === "backup-staging") return null;
  if ((parts[1] !== "stored-files" && parts[1] !== "attachments") || parts.length < 3) {
    throw new ValidationError(`Unknown R2 namespace in system backup inventory: ${key}`);
  }
  return { namespace: parts[1] };
}

async function readR2Range(key: string, offset: number, length: number): Promise<Uint8Array> {
  const object = await getAttachmentBucket().get(key, { range: { offset, length } });
  if (!object) throw new ValidationError(`R2 object disappeared during backup: ${key}`);
  const bytes = await readBoundedR2Object(object, length);
  if (bytes.byteLength !== length) throw new ValidationError(`R2 object changed during backup: ${key}`);
  return bytes;
}

async function readBoundedR2Object(
  object: { body: ReadableStream<Uint8Array> },
  limit: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = object.body.getReader();
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > limit) throw new ValidationError("System backup object exceeds its bounded read limit");
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function rawObjectChunkKey(jobId: string, ordinal: number, chunkIndex: number) {
  return `${attachmentStorageScope()}/backup-staging/system-backup/${safeJobPath(jobId)}/objects/${String(ordinal).padStart(10, "0")}/${String(chunkIndex).padStart(10, "0")}`;
}

async function stableObjectBinding(
  jobId: string,
  sourceKey: string,
  namespace: string,
  sha256: string,
  ordinal: number,
): Promise<{ logicalRef: string; boundKind: "stored_file" | "legacy_attachment" | null; orphan: boolean }> {
  const db = getD1();
  const storedFile = await db.prepare(`SELECT json_extract(row_json, '$.id') AS id
    FROM system_backup_rows WHERE job_id = ? AND table_name = 'stored_files'
      AND json_extract(row_json, '$.object_key') = ? ORDER BY ordinal LIMIT 1`)
    .bind(jobId, sourceKey).first<{ id: string }>();
  if (storedFile) {
    return { logicalRef: `stored-files/file/${storedFile.id}`, boundKind: "stored_file", orphan: false };
  }
  const attachment = await db.prepare(`SELECT json_extract(row_json, '$.id') AS id
    FROM system_backup_rows WHERE job_id = ? AND table_name = 'attachments'
      AND json_extract(row_json, '$.stored_file_id') IS NULL
      AND json_extract(row_json, '$.object_key') = ? ORDER BY ordinal LIMIT 1`)
    .bind(jobId, sourceKey).first<{ id: string }>();
  if (attachment) {
    return { logicalRef: `attachments/attachment/${attachment.id}`, boundKind: "legacy_attachment", orphan: false };
  }
  const scopePrefix = `${attachmentStorageScope()}/`;
  const existing = sourceKey.startsWith(scopePrefix) ? sourceKey.slice(scopePrefix.length) : "";
  const canonical = new RegExp(`^${namespace}/orphan/sha256/${sha256}/[0-9]+$`);
  if (canonical.test(existing)) return { logicalRef: existing, boundKind: null, orphan: true };
  const restoredPrefix = new RegExp(`^${namespace}/system-restore/[^/]+/`);
  const restored = existing.replace(restoredPrefix, "");
  if (canonical.test(restored)) return { logicalRef: restored, boundKind: null, orphan: true };
  const previous = await db.prepare(`SELECT COUNT(*) AS count FROM system_backup_objects
    WHERE job_id = ? AND ordinal < ? AND namespace = ? AND sha256 = ? AND is_orphan = 1`)
    .bind(jobId, ordinal, namespace, sha256).first<{ count: number }>();
  return {
    logicalRef: `${namespace}/orphan/sha256/${sha256}/${Number(previous?.count ?? 0)}`,
    boundKind: null,
    orphan: true,
  };
}

async function normalizePortableObjectKey(
  _jobId: string,
  tableName: string,
  row: Record<string, string | number | null>,
) {
  if (tableName === "stored_files") {
    return { ...row, object_key: `stored-files/file/${String(row.id)}` };
  }
  if (tableName === "attachments") {
    return {
      ...row,
      object_key: row.stored_file_id
        ? `stored-files/file/${String(row.stored_file_id)}`
        : `attachments/attachment/${String(row.id)}`,
    };
  }
  return row;
}

async function buildManifestFromLedger(job: BackupJobRow): Promise<SystemBackupPackageManifest> {
  const db = getD1();
  const [parts, objects] = await db.batch([
    db.prepare(`SELECT part_index, part_type, table_name, ordinal_start, row_count,
      logical_ref, byte_length, sha256 FROM system_backup_parts
      WHERE job_id = ? ORDER BY part_index`).bind(job.id),
    db.prepare(`SELECT ordinal, logical_ref, namespace, byte_size, sha256,
      bound_kind, is_orphan, first_part_index, part_count
      FROM system_backup_objects WHERE job_id = ? AND state != 'cleanup_pending'
      ORDER BY ordinal`).bind(job.id),
  ]);
  const descriptors = (parts.results as DbRow[]).map((row) => ({
    index: Number(row.part_index),
    type: String(row.part_type) as SystemBackupPartDescriptor["type"],
    table: row.table_name === null ? null : String(row.table_name),
    ordinal: row.ordinal_start === null ? null : Number(row.ordinal_start),
    logicalRef: row.logical_ref === null ? null : String(row.logical_ref),
    byteLength: Number(row.byte_length),
    count: Number(row.row_count),
    sha256: String(row.sha256),
  }));
  const objectItems = (objects.results as DbRow[]).map((row) => ({
    ordinal: Number(row.ordinal),
    logicalRef: String(row.logical_ref),
    namespace: String(row.namespace) as "stored-files" | "attachments",
    byteSize: Number(row.byte_size),
    sha256: String(row.sha256),
    boundKind: row.bound_kind === null ? null : String(row.bound_kind) as "stored_file" | "legacy_attachment",
    orphan: Boolean(row.is_orphan),
    firstPartIndex: Number(row.first_part_index),
    partCount: Number(row.part_count),
  }));
  return createPackageManifest({
    schemaVersion: systemBackupCurrentSchemaVersion,
    schemaFingerprint: job.schema_fingerprint,
    siteOrigin: job.site_origin,
    environmentScope: job.environment_scope,
    exportedAt: job.exported_at!,
    counts: JSON.parse(job.counts_json) as Record<string, number>,
    objects: objectItems,
    parts: descriptors,
    totalRows: job.total_rows,
    totalBytes: descriptors.reduce((sum, part) => sum + part.byteLength, 0),
    stateSha256: job.state_sha256!,
  });
}

async function stageOneRowsFrame(jobId: string, frame: Extract<SystemBackupDataFrame, { frame: "rows" }>) {
  const table = tableDefinitions.find((candidate) => candidate.name === frame.table);
  if (!table) throw new ValidationError(`Unknown system backup table ${frame.table}`);
  const db = getD1();
  const statements = frame.records.map((record, index) => db.prepare(`INSERT INTO system_backup_rows
    (job_id, table_name, ordinal, row_json) VALUES (?, ?, ?, ?)`)
    .bind(jobId, frame.table, frame.ordinal + index, JSON.stringify(normalizeDbRow(table, record))));
  for (let offset = 0; offset < statements.length; offset += 50) {
    await db.batch(statements.slice(offset, offset + 50));
  }
}

async function verifyStagedRowsMatchParts(jobId: string, manifest: SystemBackupPackageManifest) {
  const counts = await readFrozenCounts(jobId);
  for (const table of systemBackupExactTableContracts) {
    if ((counts[table.name] ?? 0) !== manifest.counts[table.name]) {
      throw new ValidationError(`Staged row count changed for ${table.name}`);
    }
  }
}

async function putPackagePart(jobId: string, frame: SystemBackupDataFrame) {
  const objectKey = packagePartKey(jobId, frame.index);
  await getAttachmentBucket().put(objectKey, encodePackageLine(frame), {
    httpMetadata: { contentType: systemBackupPackageMediaType },
    customMetadata: { sha256: frame.sha256 },
  });
  await getD1().prepare(`INSERT INTO system_backup_parts
    (job_id, part_index, part_type, table_name, ordinal_start, row_count,
     logical_ref, byte_length, sha256, object_key, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'frozen')`)
    .bind(
      jobId,
      frame.index,
      frame.type,
      frame.table,
      frame.ordinal,
      frame.count,
      frame.logicalRef,
      frame.byteLength,
      frame.sha256,
      objectKey,
    ).run();
}

async function stageObjectLedger(
  jobId: string,
  objects: SystemBackupObjectManifest[],
) {
  const db = getD1();
  const statements = objects.map((object) => db.prepare(`INSERT INTO system_backup_objects
    (job_id, ordinal, logical_ref, namespace, byte_size, sha256,
     bound_kind, is_orphan, first_part_index, part_count, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged')`)
    .bind(
      jobId,
      object.ordinal,
      object.logicalRef,
      object.namespace,
      object.byteSize,
      object.sha256,
      object.boundKind,
      object.orphan ? 1 : 0,
      object.firstPartIndex,
      object.partCount,
    ));
  for (let offset = 0; offset < statements.length; offset += 50) {
    await db.batch(statements.slice(offset, offset + 50));
  }
}

async function commitExactReplace(importJobId: string, rollbackJobId: string, leaseToken: string) {
  const db = getD1();
  const owner = await db.prepare(`SELECT lease_token, lease_expires_at, phase, d1_committed_at
    FROM system_backup_jobs WHERE id = ?`).bind(importJobId).first<{
      lease_token: string | null;
      lease_expires_at: string | null;
      phase: string;
      d1_committed_at: string | null;
    }>();
  if (owner?.d1_committed_at) return;
  if (
    !owner || owner.phase !== "d1_cutover" || owner.lease_token !== leaseToken ||
    !owner.lease_expires_at || Date.parse(owner.lease_expires_at) <= Date.now()
  ) {
    throw new ValidationError("System backup cutover lease is not owned by this runner");
  }
  const objectCount = await db.prepare(`SELECT COUNT(*) AS count FROM system_backup_objects
    WHERE job_id = ? AND state = 'materialized'`)
    .bind(importJobId).first<{ count: number }>();
  const expectedObjects = await db.prepare(`SELECT COUNT(*) AS count FROM system_backup_objects
    WHERE job_id = ? AND logical_ref NOT LIKE 'cleanup:%'`)
    .bind(importJobId).first<{ count: number }>();
  if (!objectCount || !expectedObjects || objectCount.count !== expectedObjects.count) {
    throw new ValidationError("Not all backup objects are materialized");
  }
  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE system_backup_jobs SET status = 'applying',
      attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND phase = 'd1_cutover' AND lease_token = ?
        AND datetime(lease_expires_at) > datetime('now') AND d1_committed_at IS NULL`)
      .bind(importJobId, leaseToken),
  ];
  const resetOrRevoke = systemBackupD1TableContracts.filter((entry) =>
    entry.policy === "reset" || entry.policy === "revoke");
  for (const table of resetOrRevoke) {
    statements.push(db.prepare(`DELETE FROM ${table.name}`));
  }
  statements.push(
    db.prepare("DELETE FROM task_label_group_values"),
    db.prepare("DELETE FROM admin_import_rows"),
    db.prepare("DELETE FROM admin_import_sessions"),
    db.prepare("DELETE FROM user_import_rows"),
    db.prepare("DELETE FROM user_import_sessions"),
  );
  for (const table of liveTableDeleteOrder) statements.push(db.prepare(`DELETE FROM ${table}`));
  for (const table of restoreTableDefinitions) {
    const statement = db.prepare(restoreFromJobSql(table.name, table.columns));
    statements.push(table.name === "stored_files" || table.name === "attachments"
      ? statement.bind(importJobId, attachmentStorageScope(), safeJobPath(importJobId), importJobId, table.name)
      : statement.bind(importJobId, table.name));
  }
  for (const tableName of deletionRestoreOrder) {
    statements.push(
      db.prepare(restoreDeletionStateFromJobSql(tableName))
        .bind(importJobId, tableName),
    );
  }
  for (const table of resetOrRevoke) statements.push(db.prepare(`DELETE FROM ${table.name}`));
  statements.push(
    db.prepare("DELETE FROM task_label_group_values"),
    db.prepare(`INSERT INTO task_label_group_values (task_id, group_id, label_id)
      SELECT tl.task_id, l.group_id, tl.label_id
      FROM task_labels tl JOIN labels l ON l.id = tl.label_id
      WHERE l.group_id IS NOT NULL`),
    db.prepare(`INSERT INTO workspace_sync_sequences (audience_user_id, last_sequence)
      SELECT id, 1 FROM users`),
    db.prepare(`INSERT INTO workspace_change_events
      (audience_user_id, sequence, entity_type, entity_id, operation, created_at)
      SELECT id, 1, 'workspace', 'system-restore', 'reset', CURRENT_TIMESTAMP FROM users`),
    db.prepare(`UPDATE system_backup_jobs
      SET status = 'expired', phase = 'expired', lease_token = NULL,
          lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id NOT IN (?, ?) AND status NOT IN ('applied', 'expired')`)
      .bind(importJobId, rollbackJobId),
    db.prepare(`INSERT INTO system_backup_objects
      (job_id, ordinal, logical_ref, namespace, source_object_key, byte_size,
       sha256, etag, state)
      SELECT ?, 1000000000 + ordinal, 'cleanup:' || source_object_key,
        namespace, source_object_key, byte_size, sha256, etag, 'cleanup_pending'
      FROM system_backup_objects WHERE job_id = ? AND state = 'frozen'`)
      .bind(importJobId, rollbackJobId),
    db.prepare(`UPDATE system_backup_jobs
      SET status = 'running', phase = 'verifying_d1', phase_cursor = NULL,
          d1_committed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND lease_token = ? AND d1_committed_at IS NULL`)
      .bind(importJobId, leaseToken),
    db.prepare(`UPDATE system_backup_objects SET state = 'applied_verifying',
      processed_bytes = 0, next_chunk_index = 0, hash_state_json = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND state = 'materialized'`)
      .bind(importJobId),
  );
  await db.batch(statements);
}

async function readAndValidatePart(jobId: string, partIndex: number): Promise<SystemBackupDataFrame> {
  const row = await getD1().prepare(`SELECT object_key FROM system_backup_parts
    WHERE job_id = ? AND part_index = ?`).bind(jobId, partIndex)
    .first<{ object_key: string }>();
  if (!row) throw new ValidationError(`System backup part ${partIndex} is missing`);
  const object = await getAttachmentBucket().get(row.object_key);
  if (!object) throw new ValidationError(`System backup part ${partIndex} object is missing`);
  const transportLimit = maxSystemBackupPartBytes + 900_000;
  if (object.size > transportLimit) throw new ValidationError(`System backup part ${partIndex} exceeds its transport bound`);
  const text = new TextDecoder().decode(await readBoundedR2Object(object, transportLimit));
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    throw new ValidationError(`System backup part ${partIndex} is not valid JSON`);
  }
  return (await validateDataFrame(value)).frame;
}

async function persistCompletedManifest(jobId: string, manifest: SystemBackupPackageManifest) {
  await getD1().prepare(`UPDATE system_backup_jobs
    SET root_sha256 = ?, state_sha256 = ?, manifest_json = ?, counts_json = ?,
        total_rows = ?, total_bytes = ?, part_count = ?, next_part_index = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`)
    .bind(
      manifest.rootSha256,
      manifest.stateSha256,
      JSON.stringify(manifest),
      JSON.stringify(manifest.counts),
      manifest.totalRows,
      manifest.totalBytes,
      manifest.parts.length,
      manifest.parts.length,
      jobId,
    ).run();
}

async function readJobManifest(job: BackupJobRow): Promise<SystemBackupPackageManifest> {
  if (job.manifest_json) {
    return validatePackageManifest(JSON.parse(job.manifest_json) as unknown);
  }
  const db = getD1();
  const [parts, objects] = await db.batch([
    db.prepare(`SELECT part_index, part_type, table_name, ordinal_start,
      row_count, logical_ref, byte_length, sha256
      FROM system_backup_parts WHERE job_id = ? ORDER BY part_index`).bind(job.id),
    db.prepare(`SELECT ordinal, logical_ref, namespace, byte_size, sha256,
      bound_kind, is_orphan, first_part_index, part_count FROM system_backup_objects
      WHERE job_id = ? AND logical_ref NOT LIKE 'cleanup:%'
      ORDER BY ordinal`).bind(job.id),
  ]);
  const descriptors = (parts.results as DbRow[]).map((row) => ({
    index: Number(row.part_index),
    type: String(row.part_type) as SystemBackupPartDescriptor["type"],
    table: row.table_name === null ? null : String(row.table_name),
    ordinal: row.ordinal_start === null ? null : Number(row.ordinal_start),
    logicalRef: row.logical_ref === null ? null : String(row.logical_ref),
    byteLength: Number(row.byte_length),
    count: Number(row.row_count),
    sha256: String(row.sha256),
  }));
  const objectItems = (objects.results as DbRow[]).map((row) => {
    const objectParts = descriptors.filter((part) =>
      part.type === "object" && part.ordinal === Number(row.ordinal));
    return {
      ordinal: Number(row.ordinal),
      logicalRef: String(row.logical_ref),
      namespace: String(row.namespace) as "stored-files" | "attachments",
      byteSize: Number(row.byte_size),
      sha256: String(row.sha256),
      boundKind: row.bound_kind === null ? null : String(row.bound_kind),
      orphan: Boolean(row.is_orphan),
      firstPartIndex: Number(row.first_part_index ?? objectParts[0]?.index ?? 0),
      partCount: Number(row.part_count ?? objectParts.length),
    };
  });
  return validatePackageManifest({
    format: systemBackupPackageFormat,
    version: systemBackupPackageVersion,
    frame: "manifest",
    schemaVersion: job.schema_version,
    schemaFingerprint: job.schema_fingerprint,
    siteOrigin: job.site_origin,
    environmentScope: job.environment_scope,
    exportedAt: job.exported_at,
    counts: JSON.parse(job.counts_json),
    objects: objectItems,
    parts: descriptors,
    totalRows: job.total_rows,
    totalBytes: job.total_bytes,
    stateSha256: job.state_sha256,
    rootSha256: job.root_sha256,
  });
}

async function revalidateLiveAgainstJob(jobId: string, currentUserId: string) {
  const db = getD1();
  const comparisons: Array<{
    table: (typeof tableDefinitions)[number];
    columns: readonly string[];
    liveFilter?: string;
    stagedFilter?: string;
  }> = [];
  for (const table of tableDefinitions) {
    if (table.name !== "users") {
      comparisons.push({ table, columns: table.columns });
      continue;
    }
    comparisons.push({
      table,
      columns: table.columns.filter((column) => column !== "email" && column !== "updated_at"),
    });
    comparisons.push({
      table,
      columns: table.columns,
      liveFilter: " WHERE users.id <> ?",
      stagedFilter: " AND json_extract(row_json, '$.id') <> ?",
    });
  }
  const statements = comparisons.map(({ table, columns, liveFilter = "", stagedFilter = "" }) => {
    const liveColumns = columns.map((column) => {
      if (column !== "object_key") return `${table.name}.${column}`;
      if (table.name === "stored_files") return `'stored-files/file/' || stored_files.id`;
      if (table.name === "attachments") {
        return `CASE WHEN attachments.stored_file_id IS NOT NULL
          THEN 'stored-files/file/' || attachments.stored_file_id
          ELSE 'attachments/attachment/' || attachments.id END`;
      }
      return `${table.name}.${column}`;
    }).join(", ");
    const stagedColumns = columns.map((column) =>
      `json_extract(row_json, '$.${column}')`).join(", ");
    const filterValues = liveFilter ? [currentUserId] : [];
    const stagedFilterValues = stagedFilter ? [currentUserId] : [];
    return db.prepare(`SELECT
      (SELECT COUNT(*) FROM (
        SELECT ${liveColumns} FROM ${table.name}${liveFilter}
        EXCEPT SELECT ${stagedColumns} FROM system_backup_rows
          WHERE job_id = ? AND table_name = ?${stagedFilter}
      )) +
      (SELECT COUNT(*) FROM (
        SELECT ${stagedColumns} FROM system_backup_rows
          WHERE job_id = ? AND table_name = ?${stagedFilter}
        EXCEPT SELECT ${liveColumns} FROM ${table.name}${liveFilter}
      )) AS mismatch`).bind(
      ...filterValues,
      jobId,
      table.name,
      ...stagedFilterValues,
      jobId,
      table.name,
      ...stagedFilterValues,
      ...filterValues,
    );
  });
  const results = await db.batch(statements);
  results.forEach((result, index) => {
    if (Number((result.results[0] as DbRow | undefined)?.mismatch ?? -1) !== 0) {
      throw new Error(`Applied D1 state differs from backup table ${comparisons[index]!.table.name}`);
    }
  });
}

async function readFrozenCounts(jobId: string): Promise<Record<string, number>> {
  const rows = await getD1().prepare(`SELECT table_name, COUNT(*) AS count
    FROM system_backup_rows WHERE job_id = ? GROUP BY table_name`)
    .bind(jobId).all<{ table_name: string; count: number }>();
  const source = new Map(rows.results.map((row) => [row.table_name, Number(row.count)]));
  return Object.fromEntries(tableDefinitions.map((table) => [table.name, source.get(table.name) ?? 0]));
}

function restoreFromJobSql(tableName: string, columns: readonly string[]) {
  const values = columns.map((column) => {
    if (deletionDeferredTables.has(tableName) && deletionStateColumns.has(column)) {
      return "NULL";
    }
    if ((tableName === "stored_files" || tableName === "attachments") && column === "object_key") {
      return `COALESCE((SELECT materialized_object_key FROM system_backup_objects o
        WHERE o.job_id = ? AND o.logical_ref = json_extract(r.row_json, '$.object_key')
          AND o.state IN ('materialized', 'applied_verifying')),
        ? || '/' || '${tableName === "stored_files" ? "stored-files" : "attachments"}' ||
          '/system-restore/' || ? || '/missing/' || json_extract(r.row_json, '$.object_key'))`;
    }
    return `json_extract(r.row_json, '$.${column}')`;
  });
  return `INSERT INTO ${tableName} (${columns.join(", ")})
    SELECT ${values.join(", ")} FROM system_backup_rows r
    WHERE r.job_id = ? AND r.table_name = ? ORDER BY r.ordinal`;
}

const deletionStateColumns = new Set(["deleted_at", "deleted_by_user_id", "purge_after"]);
const deletionRestoreOrder = ["tasks", "releases", "saved_views", "projects"] as const;
const deletionDeferredTables = new Set<string>(deletionRestoreOrder);

function restoreDeletionStateFromJobSql(tableName: typeof deletionRestoreOrder[number]) {
  return `WITH restored AS (
    SELECT json_extract(row_json, '$.id') AS id,
      json_extract(row_json, '$.deleted_at') AS deleted_at,
      json_extract(row_json, '$.deleted_by_user_id') AS deleted_by_user_id,
      json_extract(row_json, '$.purge_after') AS purge_after
    FROM system_backup_rows WHERE job_id = ? AND table_name = ?
  )
  UPDATE ${tableName} SET
    deleted_at = (SELECT deleted_at FROM restored WHERE restored.id = ${tableName}.id),
    deleted_by_user_id = (SELECT deleted_by_user_id FROM restored WHERE restored.id = ${tableName}.id),
    purge_after = (SELECT purge_after FROM restored WHERE restored.id = ${tableName}.id)
  WHERE id IN (SELECT id FROM restored)`;
}

async function readUncommittedMaterializedKeys(keys: string[]) {
  if (!keys.length) return new Set<string>();
  const db = getD1();
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < keys.length; offset += 40) {
    const chunk = keys.slice(offset, offset + 40);
    const placeholders = chunk.map(() => "?").join(", ");
    statements.push(db.prepare(`SELECT o.staged_object_key, o.materialized_object_key
      FROM system_backup_objects o
      JOIN system_backup_jobs j ON j.id = o.job_id
      WHERE j.d1_committed_at IS NULL AND (
        o.staged_object_key IN (${placeholders})
        OR o.materialized_object_key IN (${placeholders})
      )`).bind(...chunk, ...chunk));
  }
  const results = await db.batch(statements);
  const rows = results.flatMap((result) => result.results as Array<{
    staged_object_key: string | null;
    materialized_object_key: string | null;
  }>);
  return new Set(rows.flatMap((row) => [
    row.staged_object_key,
    row.materialized_object_key,
  ]).filter((key): key is string => key !== null));
}

function jsonObjectExpression(columns: readonly string[], objectKeyOverride?: string) {
  let expression = "json('{}')";
  for (let offset = 0; offset < columns.length; offset += 15) {
    const chunk = columns.slice(offset, offset + 15);
    expression = `json_set(${expression}, ${chunk.map((column) =>
      `'$.${column}', ${column === "object_key" && objectKeyOverride ? objectKeyOverride : column}`)
      .join(", ")})`;
  }
  return expression;
}

async function requireOwnedJob(
  currentUser: UserRecord,
  jobId: string,
  kind?: BackupJobRow["kind"],
): Promise<BackupJobRow> {
  if (!/^(system-export|system-import|system-rollback):[0-9a-f-]{36}$/.test(jobId)) {
    throw new ValidationError("Invalid system backup job reference");
  }
  const row = await getD1().prepare(`SELECT * FROM system_backup_jobs
    WHERE id = ? AND created_by_user_id = ? AND datetime(expires_at) > datetime('now')`)
    .bind(jobId, currentUser.id).first<BackupJobRow>();
  if (!row || (kind && row.kind !== kind)) {
    throw new ValidationError("System backup job is missing, expired, or belongs to another administrator");
  }
  return row;
}

function normalizeDatabaseTimestamp(value: string): string {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return `${value.replace(" ", "T")}Z`;
  }
  return value;
}

async function statusFromRow(job: BackupJobRow): Promise<SystemBackupJobStatus> {
  const db = getD1();
  const [objectSummary, namespaceSummary] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS objects, COALESCE(SUM(byte_size), 0) AS bytes,
      SUM(CASE WHEN is_orphan = 1 THEN 1 ELSE 0 END) AS orphan,
      SUM(CASE WHEN is_orphan = 0 AND (
        bound_kind = 'legacy_attachment' OR EXISTS (
          SELECT 1 FROM system_backup_rows r
          WHERE r.job_id = o.job_id AND r.table_name = 'attachments'
            AND json_extract(r.row_json, '$.stored_file_id') =
              substr(o.logical_ref, length('stored-files/file/') + 1)
        )) THEN 1 ELSE 0 END) AS bound
      FROM system_backup_objects o
      WHERE job_id = ? AND logical_ref NOT LIKE 'cleanup:%'`).bind(job.id),
    db.prepare(`SELECT namespace, COUNT(*) AS objects, COALESCE(SUM(byte_size), 0) AS bytes
      FROM system_backup_objects WHERE job_id = ? AND logical_ref NOT LIKE 'cleanup:%'
      GROUP BY namespace ORDER BY namespace`).bind(job.id),
  ]);
  const summary = (objectSummary.results[0] ?? {}) as DbRow;
  const objects = Number(summary.objects ?? 0);
  const orphan = Number(summary.orphan ?? 0);
  const bound = Number(summary.bound ?? 0);
  const policies: Record<string, string[]> = Object.fromEntries(
    ["exact", "rebuild", "reset", "revoke", "excluded"].map((policy) => [
      policy,
      systemBackupD1TableContracts
        .filter((table) => table.policy === policy)
        .map((table) => table.name),
    ]),
  );
  policies.exact = [
    ...policies.exact,
    ...systemBackupR2ObjectClassContracts
      .filter((entry) => entry.policy === "exact")
      .map((entry) => `R2:${entry.namespace}`),
  ];
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    phase: job.phase,
    schemaVersion: job.schema_version,
    schemaFingerprint: job.schema_fingerprint,
    exportedAt: job.exported_at,
    rootSha256: job.root_sha256,
    stateSha256: job.state_sha256,
    counts: JSON.parse(job.counts_json) as Record<string, number>,
    progress: {
      rows: job.total_rows,
      bytes: job.total_bytes,
      parts: job.part_count,
      nextPartIndex: job.next_part_index,
    },
    rollbackJobId: job.rollback_job_id,
    cleanupPending: job.status === "cleanup_pending",
    error: job.error_code,
    format: {
      name: systemBackupPackageFormat,
      version: systemBackupPackageVersion,
      schemaVersion: job.schema_version,
      schemaFingerprint: job.schema_fingerprint,
    },
    siteOrigin: job.site_origin,
    environmentScope: job.environment_scope,
    r2: {
      objects,
      bytes: Number(summary.bytes ?? 0),
      bound,
      unbound: Math.max(0, objects - orphan - bound),
      orphan,
      namespaces: Object.fromEntries((namespaceSummary.results as DbRow[]).map((row) => [
        String(row.namespace),
        { objects: Number(row.objects), bytes: Number(row.bytes) },
      ])),
    },
    policies,
    warnings: job.status === "cleanup_pending" ? ["Restore committed; old object cleanup is pending"] : [],
    validationErrors: job.error_code === "validation_failed" ? [job.error_code] : [],
    updatedAt: normalizeDatabaseTimestamp(job.updated_at),
    attemptCount: job.attempt_count,
    expiresAt: job.expires_at,
    downloadUrl:
      (job.kind === "export" || job.kind === "rollback") && job.status === "ready"
        ? `/api/admin/export/${encodeURIComponent(job.id)}`
        : null,
  };
}

function assertManifestMatchesJob(manifest: SystemBackupPackageManifest, job: BackupJobRow) {
  if (
    manifest.siteOrigin !== job.site_origin ||
    manifest.environmentScope !== job.environment_scope ||
    manifest.schemaFingerprint !== job.schema_fingerprint ||
    manifest.exportedAt !== job.exported_at
  ) {
    throw new ValidationError("System backup manifest does not match its upload session");
  }
}

function assertLocalPackageBoundary(
  header: SystemBackupPackageHeader,
  siteOrigin?: string,
) {
  if (header.siteOrigin !== currentSiteOrigin(siteOrigin)) {
    throw new ValidationError("System backup belongs to another Task Manager Site");
  }
  if (header.environmentScope !== attachmentStorageScope()) {
    throw new ValidationError("System backup belongs to another attachment environment");
  }
}

function currentSiteOrigin(requestOrigin?: string) {
  return new URL(
    requestOrigin ??
      getRuntimeEnvironment().TASK_MANAGER_PUBLIC_ORIGIN ??
      "https://local.task-manager.invalid",
  ).origin;
}

function assertConfiguredAdmin(user: UserRecord) {
  assertAdmin(user, getRuntimeEnvironment().TASK_MANAGER_ADMIN_EMAILS ?? "");
}

function packagePartKey(jobId: string, partIndex: number) {
  return `${attachmentStorageScope()}/backup-staging/system-backup/${safeJobPath(jobId)}/parts/${String(partIndex).padStart(10, "0")}`;
}

function safeJobPath(jobId: string) {
  return jobId.replace(/[^a-z0-9-]+/gi, "-");
}

async function cleanupExpiredSystemBackupJobs() {
  const db = getD1();
  const expired = await db.prepare(`SELECT id, kind, d1_committed_at
    FROM system_backup_jobs WHERE datetime(expires_at) <= datetime('now')
      AND status != 'expired' ORDER BY expires_at LIMIT 1`)
    .first<{ id: string; kind: string; d1_committed_at: string | null }>();
  if (expired) {
    await db.prepare(`UPDATE system_backup_jobs
      SET status = 'expired', phase = 'expired', lease_token = NULL,
          lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(expired.id).run();
  }
  const job = expired ?? await db.prepare(`SELECT id, kind, d1_committed_at
    FROM system_backup_jobs WHERE status = 'expired' ORDER BY expires_at LIMIT 1`)
    .first<{ id: string; kind: string; d1_committed_at: string | null }>();
  if (!job) return;
  const part = await db.prepare(`SELECT part_index, object_key FROM system_backup_parts
    WHERE job_id = ? ORDER BY part_index LIMIT 1`).bind(job.id)
    .first<{ part_index: number; object_key: string }>();
  if (part) {
    await getAttachmentBucket().delete(part.object_key);
    await db.prepare(`DELETE FROM system_backup_parts WHERE job_id = ? AND part_index = ?`)
      .bind(job.id, part.part_index).run();
    return;
  }
  const object = await db.prepare(`SELECT ordinal, materialized_object_key,
      staged_object_key, multipart_upload_id FROM system_backup_objects
    WHERE job_id = ? ORDER BY ordinal LIMIT 1`).bind(job.id).first<{
      ordinal: number;
      materialized_object_key: string | null;
      staged_object_key: string | null;
      multipart_upload_id: string | null;
    }>();
  if (object) {
    if (!job.d1_committed_at && object.multipart_upload_id && object.staged_object_key) {
      await getAttachmentBucket()
        .resumeMultipartUpload(object.staged_object_key, object.multipart_upload_id)
        .abort();
    }
    if (!job.d1_committed_at && object.materialized_object_key) {
      await getAttachmentBucket().delete(object.materialized_object_key);
    }
    await db.prepare(`DELETE FROM system_backup_objects WHERE job_id = ? AND ordinal = ?`)
      .bind(job.id, object.ordinal).run();
    return;
  }
  const raw = await getAttachmentBucket().list({
    prefix: `${attachmentStorageScope()}/backup-staging/system-backup/${safeJobPath(job.id)}/objects/`,
    limit: 20,
  });
  if (raw.objects.length) {
    await getAttachmentBucket().delete(raw.objects.map((item) => item.key));
    return;
  }
  await db.prepare(`DELETE FROM system_backup_rows WHERE job_id = ?`).bind(job.id).run();
}

async function failJob(jobId: string, error: unknown) {
  try {
    await getD1().prepare(`UPDATE system_backup_jobs
      SET status = 'failed', phase = 'failed', error_code = ?,
          attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).bind(safeErrorCode(error), jobId).run();
  } catch {
    // Preserve the original error. Failure to update the durable receipt is
    // independently visible through the unfinished phase.
  }
}

function safeErrorCode(error: unknown) {
  if (error instanceof ValidationError) return "validation_failed";
  if (error instanceof Error && /R2|object|storage/i.test(error.message)) return "object_storage_failed";
  return "system_backup_failed";
}

// Kept exported for route-contract tests: full package uploads must use
// bounded frames rather than a single request body.
export const systemBackupUploadContract = {
  actionHeader: systemBackupAction,
  mediaType: systemBackupPackageMediaType,
  maxPartBytes: maxSystemBackupPartBytes,
} as const;
