import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  advanceSystemBackupExportSlice,
  advanceSystemBackupJob,
  applySystemBackupImport,
  createSystemBackupExportJob,
  createSystemBackupImportJob,
  finalizeSystemBackupImport,
  getCurrentSystemBackupExportJob,
  streamSystemBackupPackage,
  uploadSystemBackupImportPart,
  type SystemBackupJobStatus,
} from "../lib/system-backup-jobs";
import { systemBackupCurrentSchemaVersion } from "../lib/system-backup-contract";
import { IncrementalSha256, canonicalJson, sha256Hex } from "../lib/system-backup-package";
import { createProject, createTask, getOrCreateUser } from "../lib/repository";
import type { Actor } from "../lib/auth";
import type { UserRecord } from "../lib/types";
import { createD1TestHarness } from "./helpers/d1";

let database: D1Database;
let bucket: R2Bucket;
let admin: UserRecord;
let other: UserRecord;
let adminActor: Actor;
let dispose: (() => Promise<void>) | undefined;

before(async () => {
  const harness = await createD1TestHarness({
    TASK_MANAGER_ADMIN_EMAILS: "admin@example.test,admin+changed@example.test",
    TASK_MANAGER_PUBLIC_ORIGIN: "https://task-manager.example",
    TASK_MANAGER_ATTACHMENT_SCOPE: "test",
  }, { r2: true });
  database = harness.database;
  bucket = harness.attachmentBucket!;
  dispose = harness.dispose;
  adminActor = {
    provider: "chatgpt",
    providerAccountKey: "system-backup-admin",
    displayName: "Backup Admin",
    email: "admin@example.test",
  };
  admin = await getOrCreateUser(adminActor);
  other = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "system-backup-other",
    displayName: "Other User",
    email: "other@example.test",
  });
});

after(async () => dispose?.());

async function drive(
  jobId: string,
  terminal: string[],
  max = 500,
  onStatus?: (status: SystemBackupJobStatus) => Promise<void>,
) {
  let status: SystemBackupJobStatus | undefined;
  for (let attempt = 0; attempt < max; attempt += 1) {
    status = await advanceSystemBackupJob(admin, jobId, adminActor);
    await onStatus?.(status);
    if (terminal.includes(status.status)) return status;
    if (status.error?.startsWith("applied_state_mismatch:")) {
      throw new Error(status.error);
    }
  }
  throw new Error(`Job ${jobId} did not reach ${terminal.join("/")}; last=${status?.status}/${status?.phase}`);
}

async function stageCurrentStateForRestore() {
  const created = await createSystemBackupExportJob(admin);
  const exportPreflightCursors: Array<string | null> = [];
  const ready = await drive(created.jobId, ["ready", "failed"], 500, async (status) => {
    if (status.phase !== "preflight") return;
    exportPreflightCursors.push(
      (await database.prepare("SELECT phase_cursor FROM system_backup_jobs WHERE id = ?")
        .bind(created.jobId).first<{ phase_cursor: string | null }>())?.phase_cursor ?? null,
    );
  });
  assert.equal(ready.status, "ready", ready.error ?? ready.phase);
  assert.deepEqual(exportPreflightCursors.slice(0, 3), [null, "1", "2"]);
  const response = await streamSystemBackupPackage(admin, created.jobId);
  const lines = (await response.text()).trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const header = lines[0]!;
  const manifest = lines.at(-1)!;
  const frames = lines.slice(1, -1);
  const upload = await createSystemBackupImportJob(admin, header);
  for (let index = 0; index < frames.length; index += 1) {
    await uploadSystemBackupImportPart(admin, upload.jobId, index, frames[index]);
  }
  await finalizeSystemBackupImport(admin, upload.jobId, manifest);
  const importPreflightCursors: Array<string | null> = [];
  const staged = await drive(upload.jobId, ["ready", "failed"], 500, async (status) => {
    if (status.phase !== "preflight") return;
    importPreflightCursors.push(
      (await database.prepare("SELECT phase_cursor FROM system_backup_jobs WHERE id = ?")
        .bind(upload.jobId).first<{ phase_cursor: string | null }>())?.phase_cursor ?? null,
    );
  });
  assert.equal(staged.status, "ready", staged.error ?? staged.phase);
  assert.deepEqual(importPreflightCursors.slice(0, 3), [null, "1", "2"]);
  await applySystemBackupImport(admin, {
    importId: upload.jobId,
    sha256: staged.rootSha256!,
    confirmation: "RESTORE",
  });
  return { source: ready, importJobId: upload.jobId };
}

test("export slice advances several durable checkpoints and current export is discoverable", async () => {
  const slicedJob = await createSystemBackupExportJob(admin);
  assert.equal((await getCurrentSystemBackupExportJob(admin))?.jobId, slicedJob.jobId);
  await database.prepare(`UPDATE system_backup_jobs
    SET lease_token = 'other-runner', lease_expires_at = '2099-01-01T00:00:00.000Z'
    WHERE id = ?`).bind(slicedJob.jobId).run();
  assert.equal(
    (await advanceSystemBackupExportSlice(admin, slicedJob.jobId)).phase,
    slicedJob.phase,
  );
  await database.prepare(`UPDATE system_backup_jobs
    SET lease_token = NULL, lease_expires_at = NULL WHERE id = ?`)
    .bind(slicedJob.jobId).run();
  const sliced = await advanceSystemBackupExportSlice(admin, slicedJob.jobId, {
    maximumSteps: 2,
    maximumDurationMs: 10_000,
  });

  assert.equal(sliced.phase, "build_rows");
  assert.match(sliced.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal((await getCurrentSystemBackupExportJob(admin))?.jobId, slicedJob.jobId);
  assert.equal(
    (await createSystemBackupExportJob(admin, { reuseCurrent: true })).jobId,
    slicedJob.jobId,
  );
  await database.batch([
    database.prepare(`DELETE FROM system_backup_rows WHERE job_id = ?`).bind(slicedJob.jobId),
    database.prepare(`DELETE FROM system_backup_objects WHERE job_id = ?`).bind(slicedJob.jobId),
    database.prepare(`DELETE FROM system_backup_parts WHERE job_id = ?`).bind(slicedJob.jobId),
    database.prepare(`DELETE FROM system_backup_jobs WHERE id = ?`).bind(slicedJob.jobId),
  ]);
});

test("concurrent reuse requests freeze one canonical ordinary export", async () => {
  let waiting = 0;
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const startTogether = async () => {
    waiting += 1;
    if (waiting === 2) releaseBarrier();
    await barrier;
    return createSystemBackupExportJob(admin, { reuseCurrent: true });
  };

  const results = await Promise.all([startTogether(), startTogether()]);
  const jobIds = [...new Set(results.map((result) => result.jobId))];
  try {
    assert.deepEqual(jobIds, [results[0]!.jobId]);
    assert.equal((await getCurrentSystemBackupExportJob(admin))?.jobId, results[0]!.jobId);
    assert.equal(
      (await database.prepare(`SELECT COUNT(*) AS count FROM system_backup_jobs
        WHERE created_by_user_id = ? AND kind = 'export'
          AND status IN ('running', 'ready')`).bind(admin.id).first<{ count: number }>())?.count,
      1,
    );
    assert.equal(
      (await database.prepare(`SELECT COUNT(DISTINCT job_id) AS count
        FROM system_backup_rows WHERE job_id LIKE 'system-export:%'`)
        .first<{ count: number }>())?.count,
      1,
    );
  } finally {
    for (const jobId of jobIds) {
      await database.batch([
        database.prepare("DELETE FROM system_backup_rows WHERE job_id = ?").bind(jobId),
        database.prepare("DELETE FROM system_backup_objects WHERE job_id = ?").bind(jobId),
        database.prepare("DELETE FROM system_backup_parts WHERE job_id = ?").bind(jobId),
        database.prepare("DELETE FROM system_backup_jobs WHERE id = ?").bind(jobId),
      ]);
    }
  }
});

test("export preflight checkpoints validation work and resumes from a legacy empty cursor", async () => {
  const created = await createSystemBackupExportJob(admin);
  try {
    let status: SystemBackupJobStatus = created;
    for (let attempt = 0; status.phase !== "preflight" && attempt < 500; attempt += 1) {
      status = await advanceSystemBackupJob(admin, created.jobId, adminActor);
    }
    assert.equal(status.phase, "preflight", status.error ?? status.status);
    assert.equal(
      (await database.prepare("SELECT phase_cursor FROM system_backup_jobs WHERE id = ?")
        .bind(created.jobId).first<{ phase_cursor: string | null }>())?.phase_cursor,
      null,
    );

    const firstSlice = await advanceSystemBackupExportSlice(admin, created.jobId, {
      maximumSteps: 1,
      maximumDurationMs: 100,
    });
    assert.equal(firstSlice.phase, "preflight");
    assert.equal(
      (await database.prepare("SELECT phase_cursor FROM system_backup_jobs WHERE id = ?")
        .bind(created.jobId).first<{ phase_cursor: string | null }>())?.phase_cursor,
      "1",
    );

    const secondSlice = await advanceSystemBackupExportSlice(admin, created.jobId, {
      maximumSteps: 1,
      maximumDurationMs: 100,
    });
    assert.equal(secondSlice.phase, "preflight");
    assert.equal(
      (await database.prepare("SELECT phase_cursor FROM system_backup_jobs WHERE id = ?")
        .bind(created.jobId).first<{ phase_cursor: string | null }>())?.phase_cursor,
      "2",
    );

    await database.prepare(`UPDATE system_backup_rows
      SET row_json = json_set(row_json, '$.unexpected', 'boom')
      WHERE job_id = ? AND table_name = 'users' AND ordinal = 0`)
      .bind(created.jobId).run();
    await assert.rejects(
      advanceSystemBackupExportSlice(admin, created.jobId, {
        maximumSteps: 1,
        maximumDurationMs: 100,
      }),
      /Invalid row shape for users/,
    );
    assert.equal(
      (await database.prepare("SELECT status FROM system_backup_jobs WHERE id = ?")
        .bind(created.jobId).first<{ status: string }>())?.status,
      "failed",
    );
  } finally {
    await database.batch([
      database.prepare("DELETE FROM system_backup_rows WHERE job_id = ?").bind(created.jobId),
      database.prepare("DELETE FROM system_backup_objects WHERE job_id = ?").bind(created.jobId),
      database.prepare("DELETE FROM system_backup_parts WHERE job_id = ?").bind(created.jobId),
      database.prepare("DELETE FROM system_backup_jobs WHERE id = ?").bind(created.jobId),
    ]);
  }
});

test("export preflight rejects a corrupted cursor", async () => {
  const created = await createSystemBackupExportJob(admin);
  try {
    let status: SystemBackupJobStatus = created;
    for (let attempt = 0; status.phase !== "preflight" && attempt < 500; attempt += 1) {
      status = await advanceSystemBackupJob(admin, created.jobId, adminActor);
    }
    assert.equal(status.phase, "preflight", status.error ?? status.status);
    await database.prepare(`UPDATE system_backup_jobs
      SET phase_cursor = '999999', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).bind(created.jobId).run();
    await assert.rejects(
      advanceSystemBackupExportSlice(admin, created.jobId, {
        maximumSteps: 1,
        maximumDurationMs: 100,
      }),
      /Invalid system backup preflight cursor/,
    );
    assert.equal(
      (await database.prepare("SELECT status FROM system_backup_jobs WHERE id = ?")
        .bind(created.jobId).first<{ status: string }>())?.status,
      "failed",
    );
  } finally {
    await database.batch([
      database.prepare("DELETE FROM system_backup_rows WHERE job_id = ?").bind(created.jobId),
      database.prepare("DELETE FROM system_backup_objects WHERE job_id = ?").bind(created.jobId),
      database.prepare("DELETE FROM system_backup_parts WHERE job_id = ?").bind(created.jobId),
      database.prepare("DELETE FROM system_backup_jobs WHERE id = ?").bind(created.jobId),
    ]);
  }
});

test("current export discovery is isolated by Site origin within one environment", async () => {
  const first = await createSystemBackupExportJob(admin, {
    siteOrigin: "https://task-manager-a.example",
    reuseCurrent: true,
  });
  const second = await createSystemBackupExportJob(admin, {
    siteOrigin: "https://task-manager-b.example",
    reuseCurrent: true,
  });
  try {
    assert.notEqual(first.jobId, second.jobId);
    assert.equal(
      (await getCurrentSystemBackupExportJob(admin, {
        siteOrigin: "https://task-manager-a.example",
      }))?.jobId,
      first.jobId,
    );
    assert.equal(
      (await getCurrentSystemBackupExportJob(admin, {
        siteOrigin: "https://task-manager-b.example",
      }))?.jobId,
      second.jobId,
    );
    assert.equal(
      await getCurrentSystemBackupExportJob(admin, {
        siteOrigin: "https://task-manager-c.example",
      }),
      null,
    );
  } finally {
    for (const jobId of [first.jobId, second.jobId]) {
      await database.batch([
        database.prepare("DELETE FROM system_backup_rows WHERE job_id = ?").bind(jobId),
        database.prepare("DELETE FROM system_backup_objects WHERE job_id = ?").bind(jobId),
        database.prepare("DELETE FROM system_backup_parts WHERE job_id = ?").bind(jobId),
        database.prepare("DELETE FROM system_backup_jobs WHERE id = ?").bind(jobId),
      ]);
    }
  }
});

test("fresh export conflicts with a running job and replaces a ready job atomically", async () => {
  const running = await createSystemBackupExportJob(admin);
  await assert.rejects(
    createSystemBackupExportJob(admin),
    (error: unknown) => error instanceof Error
      && "status" in error
      && error.status === 409,
  );
  assert.equal((await getCurrentSystemBackupExportJob(admin))?.jobId, running.jobId);
  const ready = await drive(running.jobId, ["ready", "failed"]);
  assert.equal(ready.status, "ready", ready.error ?? ready.phase);

  const retried = await createSystemBackupExportJob(admin, { reuseCurrent: true });
  assert.equal(retried.jobId, ready.jobId);
  assert.equal(retried.rootSha256, ready.rootSha256);
  assert.equal(retried.stateSha256, ready.stateSha256);

  const fresh = await createSystemBackupExportJob(admin);
  assert.notEqual(fresh.jobId, ready.jobId);
  assert.equal((await getCurrentSystemBackupExportJob(admin))?.jobId, fresh.jobId);
  assert.equal(
    (await database.prepare("SELECT status FROM system_backup_jobs WHERE id = ?")
      .bind(ready.jobId).first<{ status: string }>())?.status,
    "expired",
  );

  for (const jobId of [ready.jobId, fresh.jobId]) {
    await database.batch([
      database.prepare("DELETE FROM system_backup_rows WHERE job_id = ?").bind(jobId),
      database.prepare("DELETE FROM system_backup_objects WHERE job_id = ?").bind(jobId),
      database.prepare("DELETE FROM system_backup_parts WHERE job_id = ?").bind(jobId),
      database.prepare("DELETE FROM system_backup_jobs WHERE id = ?").bind(jobId),
    ]);
  }
});

test("post-restore verification allows only the authenticated identity email touch", async () => {
  const originalActor = adminActor;
  const changedActor: Actor = { ...originalActor, email: "admin+changed@example.test" };
  const { source, importJobId } = await stageCurrentStateForRestore();
  let reconciled = false;

  const applied = await drive(importJobId, ["applied", "failed"], 1_000, async (status) => {
    if (status.phase !== "verifying_d1" || reconciled) return;
    reconciled = true;
    adminActor = changedActor;
    admin = await getOrCreateUser(changedActor);
  });

  assert.equal(applied.status, "applied", applied.error ?? applied.phase);
  assert.equal(reconciled, true);
  assert.equal(admin.email, changedActor.email);
  assert.deepEqual(
    await database.prepare(`SELECT user_id, provider, provider_account_key, verified_email
      FROM user_identities WHERE provider = ? AND provider_account_key = ?`)
      .bind(changedActor.provider, changedActor.providerAccountKey).first(),
    {
      user_id: admin.id,
      provider: changedActor.provider,
      provider_account_key: changedActor.providerAccountKey,
      verified_email: changedActor.email,
    },
  );
  const reexport = await createSystemBackupExportJob(admin);
  const reexportReady = await drive(reexport.jobId, ["ready", "failed"]);
  assert.equal(reexportReady.status, "ready", reexportReady.error ?? reexportReady.phase);
  assert.notEqual(reexportReady.stateSha256, source.stateSha256);

  adminActor = originalActor;
  admin = await getOrCreateUser(originalActor);
});

test("post-restore verification remains fail-closed for every other identity change", async () => {
  const otherIdentity = await database.prepare(`SELECT verified_email, created_at
    FROM user_identities WHERE user_id = ?`).bind(other.id)
    .first<{ verified_email: string; created_at: string }>();
  const adminIdentity = await database.prepare(`SELECT created_at
    FROM user_identities WHERE provider = ? AND provider_account_key = ?`)
    .bind(adminActor.provider, adminActor.providerAccountKey)
    .first<{ created_at: string }>();
  assert.ok(otherIdentity);
  assert.ok(adminIdentity);

  const cases: Array<{
    name: string;
    mutate: () => Promise<unknown>;
    repair: () => Promise<unknown>;
  }> = [
    {
      name: "another user's verified email",
      mutate: () => database.prepare(`UPDATE user_identities SET verified_email = 'tampered@example.test'
        WHERE user_id = ?`).bind(other.id).run(),
      repair: () => database.prepare("UPDATE user_identities SET verified_email = ? WHERE user_id = ?")
        .bind(otherIdentity.verified_email, other.id).run(),
    },
    {
      name: "the authenticated identity creation timestamp",
      mutate: () => database.prepare(`UPDATE user_identities SET created_at = '2020-01-01T00:00:00.000Z'
        WHERE provider = ? AND provider_account_key = ?`)
        .bind(adminActor.provider, adminActor.providerAccountKey).run(),
      repair: () => database.prepare(`UPDATE user_identities SET created_at = ?
        WHERE provider = ? AND provider_account_key = ?`)
        .bind(adminIdentity.created_at, adminActor.provider, adminActor.providerAccountKey).run(),
    },
    {
      name: "the authenticated provider account key",
      mutate: () => database.prepare(`UPDATE user_identities SET provider_account_key = ?
        WHERE provider = ? AND provider_account_key = ?`)
        .bind(`${adminActor.providerAccountKey}-tampered`, adminActor.provider, adminActor.providerAccountKey).run(),
      repair: () => database.prepare(`UPDATE user_identities SET provider_account_key = ?
        WHERE provider = ? AND provider_account_key = ?`)
        .bind(adminActor.providerAccountKey, adminActor.provider, `${adminActor.providerAccountKey}-tampered`).run(),
    },
  ];

  const { importJobId } = await stageCurrentStateForRestore();
  let status = await advanceSystemBackupJob(admin, importJobId, adminActor);
  for (let attempt = 0; status.phase !== "verifying_d1" && attempt < 1_000; attempt += 1) {
    status = await advanceSystemBackupJob(admin, importJobId, adminActor);
  }
  assert.equal(status.phase, "verifying_d1");

  for (const [index, scenario] of cases.entries()) {
    if (index > 0) {
      await database.prepare(`UPDATE system_backup_jobs SET
        status = 'running', phase = 'verifying_d1', error_code = NULL,
        completed_at = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE id = ?`).bind(importJobId).run();
    }
    await scenario.mutate();
    const result = await advanceSystemBackupJob(admin, importJobId, adminActor);
    assert.equal(result.status, "failed", scenario.name);
    assert.equal(result.phase, "verification_failed", scenario.name);
    assert.equal(result.error, "applied_state_mismatch:user_identities", scenario.name);
    assert.match(result.warnings.join(" "), /replacement committed/i, scenario.name);
    await scenario.repair();
  }
});

test("all-user export/import preserves bound, unbound, missing and orphan object state exactly", async () => {
  await createProject(admin, { name: "Backup project", taskCode: "BKP" });
  const project = await database.prepare("SELECT id FROM projects WHERE task_code = 'BKP'")
    .first<{ id: string }>();
  assert.ok(project);
  const task = await createTask(admin, { projectId: project.id, title: "Backup task" });

  const boundBytes = new TextEncoder().encode("bound-file");
  const unboundBytes = new TextEncoder().encode("unbound-file");
  const legacyBytes = new TextEncoder().encode("legacy-file");
  const orphanBytes = new TextEncoder().encode("orphan-file");
  const boundSha = await sha256Hex(boundBytes);
  const unboundSha = await sha256Hex(unboundBytes);
  const legacySha = await sha256Hex(legacyBytes);
  const missingSha = await sha256Hex(new TextEncoder().encode("missing"));
  const now = "2026-08-27T20:00:00.000Z";
  await database.batch([
    database.prepare(`INSERT INTO access_grants
      (id, resource_type, resource_id, owner_user_id, grantee_user_id,
       granted_by_user_id, permission, revoked_at, created_at)
      VALUES ('legacy-revoked-task-grant', 'task', ?, ?, ?, ?, 'full_access', ?, ?)`)
      .bind(task.id, admin.id, other.id, admin.id, now, now),
    database.prepare(`INSERT INTO label_groups
      (id, owner_user_id, name, description, position, version, created_at, updated_at)
      VALUES ('backup-group', ?, 'Size', '', 0, 1, ?, ?)`)
      .bind(admin.id, now, now),
    database.prepare(`INSERT INTO labels
      (id, owner_user_id, group_id, name, color, description, version, created_at, updated_at)
      VALUES ('backup-label', ?, 'backup-group', 'Small', '#335577', '', 1, ?, ?)`)
      .bind(admin.id, now, now),
    database.prepare(`INSERT INTO task_labels (task_id, label_id) VALUES (?, 'backup-label')`)
      .bind(task.id),
    database.prepare(`INSERT INTO stored_files
      (id, public_id, uploader_user_id, original_filename, display_name, media_type,
       byte_size, checksum_sha256, object_key, kind, state, idempotency_key, version,
       created_at, updated_at)
      VALUES ('sf-bound', '10000000-0000-4000-8000-000000000001', ?, 'bound.txt',
        'bound.txt', 'text/plain', ?, ?, 'test/stored-files/bound', 'file', 'ready',
        'sf-bound-key', 1, ?, ?)`)
      .bind(admin.id, boundBytes.byteLength, boundSha, now, now),
    database.prepare(`INSERT INTO stored_files
      (id, public_id, uploader_user_id, original_filename, display_name, media_type,
       byte_size, checksum_sha256, object_key, kind, state, idempotency_key, version,
       created_at, updated_at)
      VALUES ('sf-unbound', '10000000-0000-4000-8000-000000000002', ?, 'unbound.txt',
        'unbound.txt', 'text/plain', ?, ?, 'test/stored-files/unbound', 'file', 'ready',
        'sf-unbound-key', 1, ?, ?)`)
      .bind(admin.id, unboundBytes.byteLength, unboundSha, now, now),
    database.prepare(`INSERT INTO stored_files
      (id, public_id, uploader_user_id, original_filename, display_name, media_type,
       byte_size, checksum_sha256, object_key, kind, state, idempotency_key, failure_code,
       version, created_at, updated_at)
      VALUES ('sf-missing', '10000000-0000-4000-8000-000000000003', ?, 'missing.txt',
        'missing.txt', 'text/plain', 7, ?, 'test/stored-files/missing', 'file', 'failed',
        'sf-missing-key', 'storage_write_failed', 1, ?, ?)`)
      .bind(admin.id, missingSha, now, now),
    database.prepare(`INSERT INTO attachments
      (id, public_id, stored_file_id, task_id, uploader_user_id, original_filename,
       display_name, media_type, byte_size, checksum_sha256, object_key, kind, state,
       idempotency_key, version, created_at, updated_at)
      VALUES ('attachment-bound', '20000000-0000-4000-8000-000000000001', 'sf-bound', ?, ?,
        'bound.txt', 'bound.txt', 'text/plain', ?, ?, 'test/stored-files/bound', 'file',
        'ready', 'attachment-bound-key', 1, ?, ?)`)
      .bind(task.id, admin.id, boundBytes.byteLength, boundSha, now, now),
    database.prepare(`INSERT INTO attachments
      (id, public_id, task_id, uploader_user_id, original_filename, display_name,
       media_type, byte_size, checksum_sha256, object_key, kind, state, idempotency_key,
       version, created_at, updated_at)
      VALUES ('attachment-legacy', '20000000-0000-4000-8000-000000000002', ?, ?,
        'legacy.txt', 'legacy.txt', 'text/plain', ?, ?, 'test/attachments/legacy', 'file',
        'ready', 'attachment-legacy-key', 1, ?, ?)`)
      .bind(task.id, admin.id, legacyBytes.byteLength, legacySha, now, now),
  ]);
  await bucket.put("test/stored-files/bound", boundBytes);
  await bucket.put("test/stored-files/unbound", unboundBytes);
  await bucket.put("test/attachments/legacy", legacyBytes);
  await bucket.put("test/attachments/orphan", orphanBytes);

  const created = await createSystemBackupExportJob(admin);
  const ready = await drive(created.jobId, ["ready", "failed"]);
  assert.equal(ready.status, "ready", ready.error ?? ready.phase);
  assert.equal(ready.counts.users, 2);
  assert.deepEqual(
    { objects: ready.r2.objects, bound: ready.r2.bound, unbound: ready.r2.unbound, orphan: ready.r2.orphan },
    { objects: 4, bound: 2, unbound: 1, orphan: 1 },
  );
  assert.ok(ready.stateSha256);

  const download = await streamSystemBackupPackage(admin, created.jobId);
  const lines = (await download.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const header = lines[0]!;
  const manifest = lines.at(-1)!;
  const frames = lines.slice(1, -1);
  const exportedAdmin = frames
    .filter((item) => item.frame === "rows" && item.table === "users")
    .flatMap((item) => item.records as Record<string, unknown>[])
    .find((row) => row.id === admin.id);
  assert.equal(typeof exportedAdmin?.updated_at, "string");
  const packageState = new IncrementalSha256();
  packageState.update(new TextEncoder().encode(`schema:${String(header.schemaFingerprint)}\n`));
  for (const frame of frames.filter((item) => item.frame === "rows")) {
    (frame.records as Record<string, unknown>[]).forEach((record, offset) => packageState.update(
      new TextEncoder().encode(`${String(frame.table)}\0${Number(frame.ordinal) + offset}\0${canonicalJson(record)}\n`),
    ));
  }
  for (const object of manifest.objects as Array<Record<string, unknown>>) {
    packageState.update(new TextEncoder().encode(
      `object\0${String(object.logicalRef)}\0${Number(object.byteSize)}\0${String(object.sha256)}\n`,
    ));
  }
  assert.equal(packageState.digestHex(), manifest.stateSha256);
  const upload = await createSystemBackupImportJob(admin, header);
  const staleSystemImport = await createSystemBackupImportJob(admin, header);
  for (let index = 0; index < frames.length; index += 1) {
    await uploadSystemBackupImportPart(admin, upload.jobId, index, frames[index]);
  }
  await finalizeSystemBackupImport(admin, upload.jobId, manifest);
  const staged = await drive(upload.jobId, ["ready", "failed"]);
  assert.equal(staged.status, "ready", staged.error ?? staged.phase);
  assert.equal(staged.stateSha256, ready.stateSha256);

  await database.prepare("UPDATE users SET display_name = 'Mutated' WHERE id = ?").bind(admin.id).run();
  await database.batch([
    database.prepare(`INSERT INTO admin_import_sessions
      (id, created_by_user_id, source_exported_at, source_schema_version,
       payload_sha256, counts_json, status)
      VALUES ('stale-admin-import', ?, ?, ?, ?, '{}', 'staged')`)
      .bind(admin.id, now, systemBackupCurrentSchemaVersion, "a".repeat(64)),
    database.prepare(`INSERT INTO admin_import_rows
      (import_id, table_name, ordinal, row_json)
      VALUES ('stale-admin-import', 'users', 0, '{}')`),
    database.prepare(`INSERT INTO user_import_sessions
      (id, created_by_user_id, kind, status, expires_at)
      VALUES ('stale-user-import', ?, 'project', 'staged', '2099-01-01T00:00:00.000Z')`)
      .bind(admin.id),
    database.prepare(`INSERT INTO user_import_rows
      (import_id, row_type, ordinal, row_json)
      VALUES ('stale-user-import', 'projects', 0, '{}')`),
  ]);
  await applySystemBackupImport(admin, {
    importId: upload.jobId,
    sha256: staged.rootSha256!,
    confirmation: "RESTORE",
  });
  let applied: SystemBackupJobStatus;
  const authenticatedTouch = "2026-08-28T07:26:13.000Z";
  let touchedAfterCutover = false;
  try {
    applied = await drive(upload.jobId, ["applied", "failed"], 1_000, async (status) => {
      if (status.phase !== "verifying_d1" || touchedAfterCutover) return;
      touchedAfterCutover = true;
      await database.prepare(`UPDATE users
        SET email = ?, updated_at = ? WHERE id = ?`)
        .bind(admin.email, authenticatedTouch, admin.id).run();
    });
  } catch (error) {
    const live = await database.prepare("SELECT * FROM tasks WHERE id = ?").bind(task.id).first<Record<string, unknown>>();
    const stagedRow = await database.prepare(`SELECT row_json FROM system_backup_rows
      WHERE job_id = ? AND table_name = 'tasks' AND json_extract(row_json, '$.id') = ?`)
      .bind(upload.jobId, task.id).first<{ row_json: string }>();
    const stagedTask = JSON.parse(stagedRow!.row_json) as Record<string, unknown>;
    const differences = Object.keys(stagedTask).filter((key) => live?.[key] !== stagedTask[key])
      .map((key) => [key, live?.[key], stagedTask[key]]);
    throw new Error(`${String(error)} differences=${JSON.stringify(differences)}`);
  }
  assert.equal(applied.status, "applied", applied.error ?? applied.phase);
  assert.equal(touchedAfterCutover, true);
  assert.equal(
    (await database.prepare("SELECT display_name FROM users WHERE id = ?").bind(admin.id)
      .first<{ display_name: string }>())?.display_name,
    "Backup Admin",
  );
  assert.equal(
    (await database.prepare("SELECT updated_at FROM users WHERE id = ?").bind(admin.id)
      .first<{ updated_at: string }>())?.updated_at,
    authenticatedTouch,
  );
  const restoredMissing = await database.prepare("SELECT object_key FROM stored_files WHERE id = 'sf-missing'")
    .first<{ object_key: string }>();
  assert.match(restoredMissing!.object_key, /\/missing\/stored-files\/file\/sf-missing$/);
  assert.equal(await bucket.head(restoredMissing!.object_key), null);
  assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM task_label_group_values")
    .first<{ count: number }>())?.count, 1);
  assert.equal((await database.prepare(`SELECT COUNT(*) AS count FROM workspace_change_events
    WHERE operation = 'reset' AND entity_id = 'system-restore'`).first<{ count: number }>())?.count, 2);
  assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM admin_import_sessions")
    .first<{ count: number }>())?.count, 0);
  assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM user_import_sessions")
    .first<{ count: number }>())?.count, 0);
  assert.equal((await database.prepare("SELECT status FROM system_backup_jobs WHERE id = ?")
    .bind(staleSystemImport.jobId).first<{ status: string }>())?.status, "expired");

  await database.prepare("UPDATE users SET updated_at = ? WHERE id = ?")
    .bind(exportedAdmin!.updated_at, admin.id).run();
  const reexport = await createSystemBackupExportJob(admin);
  const reexportReady = await drive(reexport.jobId, ["ready", "failed"]);
  assert.equal(reexportReady.status, "ready", reexportReady.error ?? reexportReady.phase);
  assert.equal(reexportReady.stateSha256, ready.stateSha256);
});

test("export keeps its point-in-time D1 snapshot when ordinary live rows change after freeze", async () => {
  await database.prepare("UPDATE users SET display_name = 'Before export freeze', updated_at = ? WHERE id = ?")
    .bind("2026-08-28T00:00:00.000Z", admin.id).run();
  const created = await createSystemBackupExportJob(admin);

  await database.prepare("UPDATE users SET display_name = 'After export freeze', updated_at = ? WHERE id = ?")
    .bind("2026-08-28T00:00:01.000Z", admin.id).run();

  const ready = await drive(created.jobId, ["ready", "failed"]);
  assert.equal(ready.status, "ready", ready.error ?? ready.phase);
  const response = await streamSystemBackupPackage(admin, created.jobId);
  const lines = (await response.text()).trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const frozenUser = lines
    .filter((line) => line.frame === "rows" && line.table === "users")
    .flatMap((line) => line.records as Record<string, unknown>[])
    .find((row) => row.id === admin.id);
  assert.equal(frozenUser?.display_name, "Before export freeze");
  assert.equal(
    (await database.prepare("SELECT display_name FROM users WHERE id = ?").bind(admin.id)
      .first<{ display_name: string }>())?.display_name,
    "After export freeze",
  );
});

test("non-admin cannot create a cross-user backup job", async () => {
  const outsider = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "system-backup-outsider",
    displayName: "Outsider",
    email: "outsider@example.test",
  });
  await assert.rejects(createSystemBackupExportJob(outsider), /administrator/i);
});
