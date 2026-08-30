import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceSystemBackupJob,
  applySystemBackupImport,
  createSystemBackupExportJob,
  createSystemBackupImportJob,
  finalizeSystemBackupImport,
  getSystemBackupJobStatus,
  streamSystemBackupPackage,
  uploadSystemBackupImportPart,
} from "../lib/system-backup-jobs";
import {
  systemBackupCurrentSchemaVersion,
  systemBackupExactTableContracts,
} from "../lib/system-backup-contract";
import {
  canonicalJson,
  createObjectFrame,
  validatePackageManifest,
} from "../lib/system-backup-package";
import { tableDefinitions } from "../lib/system-backup-format";
import {
  createLabel,
  createLabelGroup,
  createProject,
  createRelease,
  createSavedView,
  createTask,
  getOrCreateUser,
  grantAccess,
  setTaskLabel,
} from "../lib/repository";
import {
  configureRuntimeEnvironment,
  type TaskManagerRuntimeEnvironment,
} from "../lib/runtime-environment";
import type { UserRecord } from "../lib/types";
import { createD1TestHarness } from "./helpers/d1";
import {
  buildSystemBackupPackage,
  canonicalPortableStateWithDigests,
  clonePortableSnapshot,
  driveSystemBackupJob,
  parseSystemBackupPackage,
  uploadSystemBackupPackage,
  type BuiltBackupPackage,
  type PortableBackupSnapshot,
} from "./helpers/system-backup-proof";

const runtimeVariables = {
  TASK_MANAGER_ADMIN_EMAILS: "admin@example.test",
  TASK_MANAGER_PUBLIC_ORIGIN: "https://task-manager.example",
  TASK_MANAGER_ATTACHMENT_SCOPE: "test",
};
const fixtureTime = "2026-08-27T20:00:00.000Z";
const purgeAfter = "2026-09-27T20:00:00.000Z";
const encoder = new TextEncoder();

test("TM-318 proves the complete current-format system backup round-trip", async (context) => {
  const harness = await createD1TestHarness(runtimeVariables, { r2: true });
  const database = harness.database;
  const bucket = harness.attachmentBucket!;
  const environment: TaskManagerRuntimeEnvironment = {
    DB: database,
    ATTACHMENTS: bucket,
    ...runtimeVariables,
  };
  let admin!: UserRecord;
  let collaborator!: UserRecord;
  let outsider!: UserRecord;
  let largePackage!: BuiltBackupPackage;
  let compactPackage!: BuiltBackupPackage;

  try {
    ({ admin, collaborator, outsider } = await seedCompleteState(database, bucket));

    await context.test(
      "exporter-produced 5001+ row and 10MB+ state survives exact replace and canonical re-export",
      async () => {
        const created = await createSystemBackupExportJob(admin);
        const ready = await driveSystemBackupJob(admin, created.jobId, ["ready", "failed"]);
        assert.equal(ready.status, "ready", ready.error ?? ready.phase);
        assert.ok(ready.progress.rows > 5_001, String(ready.progress.rows));
        assert.ok(ready.progress.bytes > 10_000_000, String(ready.progress.bytes));
        for (const table of systemBackupExactTableContracts) {
          assert.ok(ready.counts[table.name]! > 0, `${table.name} has no fixture representative`);
        }

        largePackage = await parseSystemBackupPackage(
          await streamSystemBackupPackage(admin, created.jobId),
        );
        assert.equal(largePackage.manifest.totalRows, ready.progress.rows);
        assert.equal(largePackage.manifest.totalBytes, ready.progress.bytes);
        assertLifecycleCoverage(largePackage);

        const before = await canonicalPortableStateWithDigests(largePackage);
        await database.prepare("UPDATE users SET display_name = 'mutated-live-state' WHERE id = ?")
          .bind(admin.id).run();
        await bucket.put("test/attachments/transient-before-restore", "must disappear");

        const importId = await uploadSystemBackupPackage(admin, largePackage);
        const staged = await driveSystemBackupJob(admin, importId, ["ready", "failed"]);
        assert.equal(staged.status, "ready", staged.error ?? staged.phase);
        assert.equal(staged.stateSha256, largePackage.manifest.stateSha256);
        await applySystemBackupImport(admin, {
          importId,
          sha256: staged.rootSha256!,
          confirmation: "RESTORE",
        });
        const applied = await driveSystemBackupJob(admin, importId, ["applied", "failed"]);
        assert.equal(applied.status, "applied", applied.error ?? applied.phase);
        assert.equal(await bucket.head("test/attachments/transient-before-restore"), null);

        const reexport = await createSystemBackupExportJob(admin);
        const reexportReady = await driveSystemBackupJob(admin, reexport.jobId, ["ready", "failed"]);
        assert.equal(reexportReady.status, "ready", reexportReady.error ?? reexportReady.phase);
        assert.equal(reexportReady.stateSha256, ready.stateSha256);
        const afterPackage = await parseSystemBackupPackage(
          await streamSystemBackupPackage(admin, reexport.jobId),
        );
        const after = await canonicalPortableStateWithDigests(afterPackage);
        assert.deepEqual(after.rows, before.rows);
        assert.deepEqual(after.objects, before.objects);

        const crossProjectRelations = await database.prepare(`SELECT r.type
          FROM task_relations r
          JOIN tasks source ON source.id = r.source_task_id
          JOIN tasks target ON target.id = r.target_task_id
          WHERE source.project_id != target.project_id
          ORDER BY r.type`).all<{ type: string }>();
        assert.deepEqual(
          crossProjectRelations.results.map((relation) => relation.type),
          ["blocks", "related"],
        );

        assert.equal(
          (await database.prepare("SELECT COUNT(*) AS count FROM access_grants WHERE revoked_at IS NULL")
            .first<{ count: number }>())?.count,
          2,
        );
        assert.equal(
          (await database.prepare("SELECT COUNT(*) AS count FROM user_identities")
            .first<{ count: number }>())?.count,
          3,
        );
      },
    );

    await context.test("a compact exporter package is lease-safe and ready for fault tests", async () => {
      await database.prepare("DELETE FROM activity_events WHERE id LIKE 'bulk-activity-%'").run();
      const created = await createSystemBackupExportJob(admin);
      await database.prepare(`UPDATE system_backup_jobs
        SET lease_token = 'held-by-other-runner', lease_expires_at = '2099-01-01T00:00:00.000Z'
        WHERE id = ?`).bind(created.jobId).run();
      await assert.rejects(
        advanceSystemBackupJob(admin, created.jobId),
        /already advancing/i,
      );
      await database.prepare(`UPDATE system_backup_jobs
        SET lease_token = NULL, lease_expires_at = NULL WHERE id = ?`).bind(created.jobId).run();
      const ready = await driveSystemBackupJob(admin, created.jobId, ["ready", "failed"]);
      assert.equal(ready.status, "ready", ready.error ?? ready.phase);
      compactPackage = await parseSystemBackupPackage(
        await streamSystemBackupPackage(admin, created.jobId),
      );
      assert.ok(compactPackage.manifest.totalRows < 200);
    });

    await context.test("negative package/domain matrix is rejected before live D1/R2 mutation", async () => {
      const liveBefore = await captureLiveState(database, bucket);

      await assert.rejects(
        createSystemBackupImportJob(admin, {
          ...compactPackage.header,
          schemaVersion: systemBackupCurrentSchemaVersion - 1,
        }),
        /only schema/i,
      );
      await assert.rejects(
        createSystemBackupImportJob(admin, {
          ...compactPackage.header,
          siteOrigin: "https://another-site.example",
        }),
        /another Task Manager Site/i,
      );
      await assert.rejects(
        createSystemBackupImportJob(admin, {
          ...compactPackage.header,
          environmentScope: "another-environment",
        }),
        /another attachment environment/i,
      );

      const missingCount = {
        ...compactPackage.manifest,
        counts: {
          ...compactPackage.manifest.counts,
          users: compactPackage.manifest.counts.users! - 1,
        },
      };
      await assert.rejects(validatePackageManifest(missingCount), /parts do not match count/i);
      const extraCount = {
        ...compactPackage.manifest,
        counts: {
          ...compactPackage.manifest.counts,
          users: compactPackage.manifest.counts.users! + 1,
        },
      };
      await assert.rejects(validatePackageManifest(extraCount), /parts do not match count/i);

      const reordered = structuredClone(compactPackage.manifest);
      [reordered.parts[0], reordered.parts[1]] = [reordered.parts[1]!, reordered.parts[0]!];
      await assert.rejects(validatePackageManifest(reordered), /missing, duplicated, or out of order/i);
      const duplicated = structuredClone(compactPackage.manifest);
      duplicated.parts.splice(1, 0, { ...duplicated.parts[0]! });
      await assert.rejects(validatePackageManifest(duplicated), /missing, duplicated, or out of order/i);

      const truncatedId = await createSystemBackupImportJob(admin, compactPackage.header);
      for (const frame of compactPackage.frames.slice(0, -1)) {
        await uploadSystemBackupImportPart(admin, truncatedId.jobId, frame.index, frame);
      }
      await assert.rejects(
        finalizeSystemBackupImport(admin, truncatedId.jobId, compactPackage.manifest),
        /truncated or has extra uploaded parts/i,
      );

      const reorderedId = await createSystemBackupImportJob(admin, compactPackage.header);
      await assert.rejects(
        uploadSystemBackupImportPart(admin, reorderedId.jobId, 0, compactPackage.frames[1]!),
        /index does not match/i,
      );

      const badLengthId = await createSystemBackupImportJob(admin, compactPackage.header);
      const badLength = {
        ...compactPackage.frames[0]!,
        byteLength: compactPackage.frames[0]!.byteLength + 1,
      };
      await assert.rejects(
        uploadSystemBackupImportPart(admin, badLengthId.jobId, 0, badLength),
        /length does not match/i,
      );

      const badChecksumId = await createSystemBackupImportJob(admin, compactPackage.header);
      const badChecksum = {
        ...compactPackage.frames[0]!,
        sha256: "0".repeat(64),
      };
      await assert.rejects(
        uploadSystemBackupImportPart(admin, badChecksumId.jobId, 0, badChecksum),
        /checksum does not match/i,
      );

      const extraPartId = await createSystemBackupImportJob(admin, compactPackage.header);
      for (const frame of compactPackage.frames) {
        await uploadSystemBackupImportPart(admin, extraPartId.jobId, frame.index, frame);
      }
      const extraFrame = await createObjectFrame({
        index: compactPackage.frames.length,
        objectOrdinal: compactPackage.objects.length,
        logicalRef: "attachments/orphan/sha256/extra/0",
        bytes: encoder.encode("extra"),
      });
      await uploadSystemBackupImportPart(admin, extraPartId.jobId, extraFrame.index, extraFrame);
      await assert.rejects(
        finalizeSystemBackupImport(admin, extraPartId.jobId, compactPackage.manifest),
        /truncated or has extra uploaded parts/i,
      );

      await assertDomainPackageRejected(admin, mutateRow(compactPackage, "tasks", (rows) => {
        rows[0]!.project_id = "missing-project";
      }), "broken reference");
      await assertDomainPackageRejected(admin, mutateRow(compactPackage, "tasks", (rows) => {
        rows[0]!.parent_task_id = String(rows[1]!.id);
        rows[1]!.parent_task_id = String(rows[0]!.id);
      }), "parent cycle");
      await assertDomainPackageRejected(admin, mutateRow(compactPackage, "task_relations", (rows) => {
        const crossProject = rows.find((row) => row.id === "relation-cross-project-blocks");
        assert.ok(crossProject);
        crossProject.type = "duplicate_of";
      }), "cross-Project duplicate relation");
      await assertDomainPackageRejected(admin, mutateRow(compactPackage, "access_grants", (rows) => {
        rows[0]!.owner_user_id = outsider.id;
      }), "invalid ACL");
      await assertDomainPackageRejected(admin, mutateRow(compactPackage, "tasks", (rows) => {
        const completedStatus = compactPackage.rows.workflow_statuses.find((row) => row.category === "completed")!;
        rows[0]!.status_id = completedStatus.id!;
        rows[0]!.completed_at = null;
        rows[0]!.canceled_at = null;
      }), "invalid lifecycle");
      await assertDomainPackageRejected(admin, mutateRow(compactPackage, "user_identities", (rows) => {
        const index = rows.findIndex((row) => row.user_id === admin.id);
        assert.notEqual(index, -1);
        rows.splice(index, 1);
      }), "missing administrator identity");

      const missingObject = clonePortableSnapshot(compactPackage);
      const boundIndex = missingObject.objects.findIndex((object) => object.boundKind === "stored_file");
      assert.notEqual(boundIndex, -1);
      missingObject.objects.splice(boundIndex, 1);
      await assertDomainPackageRejected(admin, buildSystemBackupPackage(missingObject), "missing R2 object");

      const corruptObject = clonePortableSnapshot(compactPackage);
      const corruptIndex = corruptObject.objects.findIndex((object) => object.boundKind === "stored_file");
      assert.notEqual(corruptIndex, -1);
      corruptObject.objects[corruptIndex]!.bytes[0] ^= 0xff;
      await assertDomainPackageRejected(admin, buildSystemBackupPackage(corruptObject), "corrupt R2 object");

      assert.deepEqual(await captureLiveState(database, bucket), liveBefore);
    });

    await context.test(
      "materialization, uncertain commit, bounded verification and cleanup retry preserve atomicity",
      async () => {
        const liveSentinel = "live-before-materialization-failure";
        await database.prepare("UPDATE users SET display_name = ? WHERE id = ?")
          .bind(liveSentinel, admin.id).run();
        const failedImportId = await uploadSystemBackupPackage(admin, compactPackage);
        const staged = await driveSystemBackupJob(admin, failedImportId, ["ready", "failed"]);
        assert.equal(staged.status, "ready", staged.error ?? staged.phase);
        await applySystemBackupImport(admin, {
          importId: failedImportId,
          sha256: staged.rootSha256!,
          confirmation: "RESTORE",
        });
        await driveUntilPhase(admin, failedImportId, "materializing");
        await advanceSystemBackupJob(admin, failedImportId);
        const secondObjectPart = await database.prepare(`SELECT p.object_key
          FROM system_backup_objects o
          JOIN system_backup_parts p ON p.job_id = o.job_id
            AND p.part_index = o.first_part_index
          WHERE o.job_id = ? AND o.ordinal = 1`).bind(failedImportId)
          .first<{ object_key: string }>();
        assert.ok(secondObjectPart);
        await bucket.delete(secondObjectPart.object_key);
        await assert.rejects(
          advanceSystemBackupJob(admin, failedImportId),
          /missing|object/i,
        );
        const failedRow = await database.prepare(`SELECT status, d1_committed_at
          FROM system_backup_jobs WHERE id = ?`).bind(failedImportId)
          .first<{ status: string; d1_committed_at: string | null }>();
        assert.deepEqual(failedRow, { status: "failed", d1_committed_at: null });
        assert.equal(
          (await database.prepare("SELECT display_name FROM users WHERE id = ?").bind(admin.id)
            .first<{ display_name: string }>())?.display_name,
          liveSentinel,
        );
        const stagedKey = await database.prepare(`SELECT materialized_object_key
          FROM system_backup_objects WHERE job_id = ? AND state = 'materialized' LIMIT 1`)
          .bind(failedImportId).first<{ materialized_object_key: string }>();
        assert.ok(stagedKey?.materialized_object_key);
        assert.equal(
          (await database.prepare(`SELECT COUNT(*) AS count FROM stored_files WHERE object_key = ?`)
            .bind(stagedKey.materialized_object_key).first<{ count: number }>())?.count,
          0,
        );

        const retryImportId = await uploadSystemBackupPackage(admin, compactPackage);
        const retryReady = await driveSystemBackupJob(admin, retryImportId, ["ready", "failed"]);
        assert.equal(retryReady.status, "ready", retryReady.error ?? retryReady.phase);
        await applySystemBackupImport(admin, {
          importId: retryImportId,
          sha256: retryReady.rootSha256!,
          confirmation: "RESTORE",
        });
        await driveUntilPhase(admin, retryImportId, "d1_cutover");

        const concurrent = await Promise.allSettled([
          advanceSystemBackupJob(admin, retryImportId),
          advanceSystemBackupJob(admin, retryImportId),
        ]);
        const commit = await database.prepare(`SELECT d1_committed_at, phase
          FROM system_backup_jobs WHERE id = ?`).bind(retryImportId)
          .first<{ d1_committed_at: string | null; phase: string }>();
        assert.ok(
          commit?.d1_committed_at,
          `cutover did not commit: ${concurrent.map((result) =>
            result.status === "fulfilled" ? "fulfilled" : String(result.reason)).join(" | ")}`,
        );
        assert.notEqual(commit?.phase, "d1_cutover");

        // Treat the first cutover response as lost: retrying apply/advance must
        // continue from the durable commit marker rather than replace twice.
        await applySystemBackupImport(admin, {
          importId: retryImportId,
          sha256: retryReady.rootSha256!,
          confirmation: "RESTORE",
        });
        let status = await getSystemBackupJobStatus(admin, retryImportId);
        let observedBoundedResume = false;
        while (status.phase !== "cleanup") {
          status = await advanceSystemBackupJob(admin, retryImportId);
          if (status.phase === "verifying_objects") {
            const partial = await database.prepare(`SELECT processed_bytes, byte_size
              FROM system_backup_objects WHERE job_id = ?
                AND processed_bytes > 0 AND processed_bytes < byte_size LIMIT 1`)
              .bind(retryImportId).first<{ processed_bytes: number; byte_size: number }>();
            observedBoundedResume ||= Boolean(partial);
          }
        }
        assert.equal(status.status, "cleanup_pending");
        assert.equal(observedBoundedResume, true);

        let injected = false;
        configureRuntimeEnvironment({
          ...environment,
          ATTACHMENTS: failOneLiveDelete(bucket, () => {
            injected = true;
          }),
        });
        const cleanupFailure = await advanceSystemBackupJob(admin, retryImportId);
        assert.equal(injected, true);
        assert.equal(cleanupFailure.status, "cleanup_pending");
        assert.equal(cleanupFailure.error, "cleanup_failed");

        configureRuntimeEnvironment(environment);
        const applied = await driveSystemBackupJob(admin, retryImportId, ["applied", "failed"]);
        assert.equal(applied.status, "applied", applied.error ?? applied.phase);
        const liveObject = await database.prepare(`SELECT object_key FROM stored_files
          WHERE id = 'sf-bound'`).first<{ object_key: string }>();
        assert.ok(liveObject);
        assert.ok(await bucket.head(liveObject.object_key));
        assert.equal(
          (await database.prepare(`SELECT COUNT(*) AS count FROM workspace_change_events
            WHERE operation = 'reset' AND entity_id = 'system-restore'`)
            .first<{ count: number }>())?.count,
          (await database.prepare("SELECT COUNT(*) AS count FROM users")
            .first<{ count: number }>())?.count,
        );
      },
    );

    await context.test("administrator and non-administrator guards cover both directions", async () => {
      await assert.rejects(createSystemBackupExportJob(outsider), /administrator/i);
      await assert.rejects(createSystemBackupImportJob(outsider, compactPackage.header), /administrator/i);
      await assert.rejects(
        getSystemBackupJobStatus(collaborator, compactPackage.manifest.rootSha256),
        /administrator/i,
      );
    });
  } finally {
    configureRuntimeEnvironment(environment);
    await harness.dispose();
  }
});

async function seedCompleteState(database: D1Database, bucket: R2Bucket) {
  const admin = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "backup-proof-admin",
    displayName: "Backup Proof Admin",
    email: "admin@example.test",
  });
  const collaborator = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "backup-proof-collaborator",
    displayName: "Backup Collaborator",
    email: "collaborator@example.test",
  });
  const outsider = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "backup-proof-outsider",
    displayName: "Backup Outsider",
    email: "outsider@example.test",
  });
  await database.batch([admin, collaborator, outsider].map((user) =>
    database.prepare("INSERT INTO task_sequences (owner_user_id, last_value) VALUES (?, 0)")
      .bind(user.id)));

  await createProject(admin, { name: "Complete backup", taskCode: "FULL", status: "active" });
  const project = await database.prepare("SELECT id FROM projects WHERE task_code = 'FULL'")
    .first<{ id: string }>();
  assert.ok(project);
  await grantAccess(admin, {
    resourceType: "project",
    resourceId: project.id,
    email: collaborator.email,
    permission: "manager",
  });
  const release = await createRelease(admin, {
    projectId: project.id,
    name: "Complete release",
    status: "active",
  });
  const root = await createTask(admin, {
    projectId: project.id,
    releaseId: release.id,
    title: "Complete root",
    assigneeUserId: collaborator.id,
  });
  const child = await createTask(admin, {
    projectId: project.id,
    title: "Complete child",
  });
  const completedStatus = await database.prepare(`SELECT id FROM workflow_statuses
    WHERE owner_user_id = ? AND category = 'completed' ORDER BY position LIMIT 1`)
    .bind(admin.id).first<{ id: string }>();
  assert.ok(completedStatus);
  const completed = await createTask(admin, {
    projectId: project.id,
    title: "Completed lifecycle",
    statusId: completedStatus.id,
  });
  await database.prepare("UPDATE tasks SET parent_task_id = ?, archived_at = ? WHERE id = ?")
    .bind(root.id, fixtureTime, child.id).run();

  await createProject(collaborator, { name: "Deleted owner state", taskCode: "DEL", status: "active" });
  const deletedProject = await database.prepare("SELECT id FROM projects WHERE task_code = 'DEL'")
    .first<{ id: string }>();
  assert.ok(deletedProject);
  const deletedRelease = await createRelease(collaborator, {
    projectId: deletedProject.id,
    name: "Deleted release",
  });
  const canceledStatus = await database.prepare(`SELECT id FROM workflow_statuses
    WHERE owner_user_id = ? AND category = 'canceled' ORDER BY position LIMIT 1`)
    .bind(collaborator.id).first<{ id: string }>();
  assert.ok(canceledStatus);
  const deletedTask = await createTask(collaborator, {
    projectId: deletedProject.id,
    releaseId: deletedRelease.id,
    title: "Deleted task",
    statusId: canceledStatus.id,
  });
  await database.batch([
    database.prepare(`UPDATE tasks SET archived_at = ?, deleted_at = ?, deleted_by_user_id = ?,
      purge_after = ? WHERE id = ?`).bind(fixtureTime, fixtureTime, collaborator.id, purgeAfter, deletedTask.id),
    database.prepare(`UPDATE releases SET deleted_at = ?, deleted_by_user_id = ?, purge_after = ?
      WHERE id = ?`).bind(fixtureTime, collaborator.id, purgeAfter, deletedRelease.id),
    database.prepare(`UPDATE projects SET archived_at = ?, deleted_at = ?, deleted_by_user_id = ?,
      purge_after = ? WHERE id = ?`).bind(fixtureTime, fixtureTime, collaborator.id, purgeAfter, deletedProject.id),
  ]);

  await createLabelGroup(admin, { name: "Effort", description: "Grouped label" });
  const group = await database.prepare("SELECT id FROM label_groups WHERE owner_user_id = ? AND name = 'Effort'")
    .bind(admin.id).first<{ id: string }>();
  assert.ok(group);
  await createLabel(admin, { name: "Large", color: "#335577", groupId: group.id });
  await createLabel(admin, { name: "Archived label", color: "#775533" });
  const labels = await database.prepare("SELECT id, name FROM labels WHERE owner_user_id = ? ORDER BY name")
    .bind(admin.id).all<{ id: string; name: string }>();
  const largeLabel = labels.results.find((label) => label.name === "Large")!;
  const archivedLabel = labels.results.find((label) => label.name === "Archived label")!;
  await setTaskLabel(admin, root.id, { labelId: largeLabel.id, active: true });
  await database.prepare("UPDATE labels SET archived_at = ? WHERE id = ?")
    .bind(fixtureTime, archivedLabel.id).run();

  const projectView = await createSavedView(admin, {
    name: "Project view",
    scopeProjectId: project.id,
    query: {},
    display: {},
  });
  const globalView = await createSavedView(admin, {
    name: "Global shared view",
    query: {},
    display: {},
  });
  await grantAccess(admin, {
    resourceType: "saved_view",
    resourceId: globalView.id,
    email: outsider.email,
    permission: "viewer",
  });
  await database.prepare(`INSERT INTO saved_views
    (id, public_id, owner_user_id, name, scope_project_id, query_json, display_json,
     archived_at, deleted_at, deleted_by_user_id, purge_after, version, created_at, updated_at)
    VALUES ('view-deleted', '99999999-0000-4000-8000-000000000001', ?, 'Deleted view', NULL,
      '{}', '{}', ?, ?, ?, ?, 4, ?, ?)`)
    .bind(collaborator.id, fixtureTime, fixtureTime, collaborator.id, purgeAfter, fixtureTime, fixtureTime).run();

  const boundBytes = encoder.encode("bound-file");
  const unboundBytes = Uint8Array.from({ length: 900_000 }, (_, index) => (index * 31) % 251);
  const deletedBytes = encoder.encode("deleted-file");
  const legacyBytes = encoder.encode("legacy-attachment");
  const orphanBytes = encoder.encode("orphan-object");
  const hashes = await Promise.all([
    digest(boundBytes), digest(unboundBytes), digest(deletedBytes), digest(legacyBytes), digest(orphanBytes),
    digest(new Uint8Array(0)), digest(encoder.encode("missing")),
  ]);
  const [boundSha, unboundSha, deletedSha, legacySha, orphanSha, emptySha, missingSha] = hashes;
  const storedFileSql = `INSERT INTO stored_files
    (id, public_id, uploader_user_id, original_filename, display_name, media_type,
     byte_size, checksum_sha256, object_key, kind, state, variant_metadata_json,
     idempotency_key, upload_expires_at, ready_expires_at, failure_code, version,
     created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, 'text/plain', ?, ?, ?, 'file', ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?)`;
  const storedRows = [
    ["sf-bound", "10000000-0000-4000-8000-000000000001", admin.id, "bound.txt", "bound.txt", boundBytes.byteLength, boundSha, "test/stored-files/bound", "ready", "sf-bound-key", null, null, null, 2, fixtureTime, fixtureTime, null],
    ["sf-unbound", "10000000-0000-4000-8000-000000000002", collaborator.id, "unbound.bin", "unbound.bin", unboundBytes.byteLength, unboundSha, "test/stored-files/unbound", "ready", "sf-unbound-key", null, "2099-01-01T00:00:00.000Z", null, 3, fixtureTime, fixtureTime, null],
    ["sf-uploading", "10000000-0000-4000-8000-000000000003", admin.id, "uploading.txt", "uploading.txt", 0, emptySha, "test/stored-files/uploading", "uploading", "sf-uploading-key", "2099-01-01T00:00:00.000Z", null, null, 1, fixtureTime, fixtureTime, null],
    ["sf-failed", "10000000-0000-4000-8000-000000000004", admin.id, "failed.txt", "failed.txt", 7, missingSha, "test/stored-files/failed", "failed", "sf-failed-key", null, null, "storage_write_failed", 4, fixtureTime, fixtureTime, null],
    ["sf-expired", "10000000-0000-4000-8000-000000000005", collaborator.id, "expired.txt", "expired.txt", 0, emptySha, "test/stored-files/expired", "expired", "sf-expired-key", fixtureTime, null, null, 2, fixtureTime, fixtureTime, null],
    ["sf-deleted", "10000000-0000-4000-8000-000000000006", admin.id, "deleted.txt", "deleted.txt", deletedBytes.byteLength, deletedSha, "test/stored-files/deleted", "deleted", "sf-deleted-key", null, null, null, 5, fixtureTime, fixtureTime, fixtureTime],
  ] as const;
  for (const row of storedRows) await database.prepare(storedFileSql).bind(...row).run();

  const attachmentSql = `INSERT INTO attachments
    (id, public_id, stored_file_id, task_id, uploader_user_id, original_filename,
     display_name, media_type, byte_size, checksum_sha256, object_key, kind, state,
     variant_metadata_json, idempotency_key, upload_expires_at, failure_code, version,
     created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'text/plain', ?, ?, ?, 'file', ?, '{}', ?, ?, ?, ?, ?, ?, ?)`;
  const attachmentRows = [
    ["attachment-bound", "20000000-0000-4000-8000-000000000001", "sf-bound", root.id, admin.id, "bound.txt", "bound.txt", boundBytes.byteLength, boundSha, "test/stored-files/bound", "ready", "attachment-bound-key", null, null, 2, fixtureTime, fixtureTime, null],
    ["attachment-legacy", "20000000-0000-4000-8000-000000000002", null, root.id, collaborator.id, "legacy.txt", "legacy.txt", legacyBytes.byteLength, legacySha, "test/attachments/legacy", "ready", "attachment-legacy-key", null, null, 3, fixtureTime, fixtureTime, null],
    ["attachment-failed", "20000000-0000-4000-8000-000000000003", null, child.id, admin.id, "failed.txt", "failed.txt", 7, missingSha, "test/attachments/failed", "failed", "attachment-failed-key", fixtureTime, "storage_write_failed", 4, fixtureTime, fixtureTime, null],
    ["attachment-deleted", "20000000-0000-4000-8000-000000000004", "sf-deleted", completed.id, admin.id, "deleted.txt", "deleted.txt", deletedBytes.byteLength, deletedSha, "test/stored-files/deleted", "deleted", "attachment-deleted-key", null, null, 5, fixtureTime, fixtureTime, fixtureTime],
  ] as const;
  for (const row of attachmentRows) await database.prepare(attachmentSql).bind(...row).run();
  await bucket.put("test/stored-files/bound", boundBytes);
  await bucket.put("test/stored-files/unbound", unboundBytes);
  await bucket.put("test/stored-files/deleted", deletedBytes);
  await bucket.put("test/attachments/legacy", legacyBytes);
  await bucket.put("test/attachments/orphan", orphanBytes, { customMetadata: { sha256: orphanSha } });

  const [relatedSourceTaskId, relatedTargetTaskId] = [child.id, deletedTask.id].sort();
  await database.batch([
    database.prepare(`INSERT INTO task_identifier_aliases (id, task_id, identifier, created_at)
      VALUES ('alias-root', ?, 'OLD-42', ?)`).bind(root.id, fixtureTime),
    database.prepare(`INSERT INTO task_relations
      (id, source_task_id, target_task_id, type, creator_user_id, idempotency_key, version, created_at, updated_at)
      VALUES ('relation-root-child', ?, ?, 'blocks', ?, 'relation-proof', 2, ?, ?)`)
      .bind(root.id, child.id, admin.id, fixtureTime, fixtureTime),
    database.prepare(`INSERT INTO task_relations
      (id, source_task_id, target_task_id, type, creator_user_id, idempotency_key, version, created_at, updated_at)
      VALUES ('relation-cross-project-blocks', ?, ?, 'blocks', ?, 'relation-cross-project-blocks-proof', 1, ?, ?)`)
      .bind(root.id, deletedTask.id, admin.id, fixtureTime, fixtureTime),
    database.prepare(`INSERT INTO task_relations
      (id, source_task_id, target_task_id, type, creator_user_id, idempotency_key, version, created_at, updated_at)
      VALUES ('relation-cross-project-related', ?, ?, 'related', ?, 'relation-cross-project-related-proof', 1, ?, ?)`)
      .bind(relatedSourceTaskId, relatedTargetTaskId, admin.id, fixtureTime, fixtureTime),
    database.prepare(`INSERT INTO external_records
      (id, owner_user_id, target_type, target_id, source, source_id, source_url, metadata_json, imported_at)
      VALUES ('external-root', ?, 'task', ?, 'linear', 'LIN-42', 'https://linear.example/LIN-42', '{"team":"proof"}', ?)`)
      .bind(admin.id, root.id, fixtureTime),
    database.prepare(`INSERT INTO access_grants
      (id, resource_type, resource_id, owner_user_id, grantee_user_id, granted_by_user_id,
       permission, revoked_at, created_at)
      VALUES ('revoked-task-grant', 'task', ?, ?, ?, ?, 'full_access', ?, ?)`)
      .bind(root.id, admin.id, outsider.id, admin.id, fixtureTime, fixtureTime),
  ]);

  await database.batch([
    database.prepare(`INSERT INTO comments
      (id, task_id, author_user_id, body, source, idempotency_key, created_at, updated_at, version)
      VALUES ('comment-root', ?, ?, 'Root comment', 'native', 'comment-root-key', ?, ?, 3)`)
      .bind(root.id, admin.id, fixtureTime, fixtureTime),
    database.prepare(`INSERT INTO comments
      (id, task_id, author_user_id, body, source, parent_comment_id, idempotency_key, created_at, updated_at, version)
      VALUES ('comment-reply', ?, ?, 'Reply', 'native', 'comment-root', 'comment-reply-key', ?, ?, 2)`)
      .bind(root.id, collaborator.id, fixtureTime, fixtureTime),
    database.prepare(`INSERT INTO comments
      (id, task_id, author_user_id, body, source, source_record_id, source_comment_id,
       historical_author_name, historical_created_at, historical_updated_at,
       historical_quoted_text, idempotency_key, created_at, updated_at, version)
      VALUES ('comment-history', ?, NULL, 'Imported history', 'linear', 'external-root', 'LIN-C-1',
       'Former teammate', ?, ?, 'Quoted context', 'history-key', ?, ?, 1)`)
      .bind(root.id, fixtureTime, fixtureTime, fixtureTime, fixtureTime),
    database.prepare(`INSERT INTO comments
      (id, task_id, author_user_id, body, source, idempotency_key, created_at, updated_at, deleted_at, version)
      VALUES ('comment-deleted', ?, ?, '', 'native', 'comment-deleted-key', ?, ?, ?, 4)`)
      .bind(root.id, admin.id, fixtureTime, fixtureTime, fixtureTime),
  ]);
  await database.batch([
    database.prepare(`INSERT INTO comment_reactions (comment_id, user_id, emoji, created_at)
      VALUES ('comment-root', ?, '👍', ?)`).bind(collaborator.id, fixtureTime),
    database.prepare(`INSERT INTO comment_attachment_refs (comment_id, task_id, attachment_id, created_at)
      VALUES ('comment-root', ?, 'attachment-bound', ?)`).bind(root.id, fixtureTime),
    database.prepare(`INSERT INTO comment_migration_outcomes
      (id, task_id, source, source_record_id, source_comment_id, source_index,
       outcome, reason, comment_id, raw_json, reconciled_at)
      VALUES ('comment-outcome', ?, 'linear', 'external-root', 'LIN-C-1', 0,
       'migrated', NULL, 'comment-history', '{"id":"LIN-C-1"}', ?)`)
      .bind(root.id, fixtureTime),
    database.prepare(`INSERT INTO attachment_migration_outcomes
      (id, task_id, source, source_record_id, source_attachment_id, source_index,
       outcome, reason, attachment_id, mapped_title, mapped_url, raw_json, reconciled_at)
      VALUES ('attachment-outcome', ?, 'linear', 'external-root', 'LIN-A-1', 0,
       'migrated', NULL, 'attachment-legacy', NULL, NULL, '{"id":"LIN-A-1"}', ?)`)
      .bind(root.id, fixtureTime),
    database.prepare(`UPDATE tasks SET comment_count = 3 WHERE id = ?`).bind(root.id),
  ]);

  await database.batch([
    database.prepare(`INSERT INTO activity_events
      (id, task_id, schema_version, event_type, actor_kind, actor_user_id, actor_name,
       payload_json, source, source_record_id, source_event_id, source_index, created_at)
      VALUES ('activity-history', ?, 1, 'status_changed', 'historical', NULL, 'Former teammate',
       '{"changes":{"status":{"before":"Todo","after":"Done"}}}', 'linear',
       'external-root', 'LIN-E-1', 1, ?)`)
      .bind(root.id, fixtureTime),
    database.prepare(`INSERT INTO activity_migration_outcomes
      (id, task_id, source, source_record_id, source_event_id, source_index,
       outcome, reason, activity_event_id, raw_json, reconciled_at)
      VALUES ('activity-outcome', ?, 'linear', 'external-root', 'LIN-E-1', 1,
       'migrated', NULL, 'activity-history', '{"id":"LIN-E-1"}', ?)`)
      .bind(root.id, fixtureTime),
  ]);

  const payload = "x".repeat(2_150);
  for (let offset = 0; offset < 5_101; offset += 100) {
    const statements: D1PreparedStatement[] = [];
    for (let index = offset; index < Math.min(offset + 100, 5_101); index += 1) {
      statements.push(database.prepare(`INSERT INTO activity_events
        (id, task_id, schema_version, event_type, actor_kind, actor_user_id,
         actor_name, payload_json, source, created_at)
        VALUES (?, ?, 1, 'fixture_evidence', 'system', NULL, 'System', ?, 'native', ?)`)
        .bind(
          `bulk-activity-${String(index).padStart(5, "0")}`,
          root.id,
          JSON.stringify({ index, payload }),
          fixtureTime,
        ));
    }
    await database.batch(statements);
  }

  assert.ok(projectView.id);
  return { admin, collaborator, outsider };
}

function assertLifecycleCoverage(source: PortableBackupSnapshot) {
  const storedStates = new Set(source.rows.stored_files!.map((row) => row.state));
  assert.deepEqual(
    [...storedStates].sort(),
    ["deleted", "expired", "failed", "ready", "uploading"],
  );
  assert.ok(source.rows.projects!.some((row) => row.deleted_at !== null && row.archived_at !== null));
  assert.ok(source.rows.releases!.some((row) => row.deleted_at !== null));
  assert.ok(source.rows.tasks!.some((row) => row.deleted_at !== null));
  assert.ok(source.rows.saved_views!.some((row) => row.deleted_at !== null));
  assert.ok(source.objects.some((object) => object.orphan));
  assert.ok(source.objects.some((object) => object.boundKind === "stored_file"));
  assert.ok(source.objects.some((object) => object.boundKind === "legacy_attachment"));
  assert.ok(source.rows.stored_files!.some((row) => row.state === "failed" && row.object_key));
  assert.ok(source.rows.stored_files!.some((row) => row.state === "expired" && row.object_key));
}

async function mutateRow(
  source: PortableBackupSnapshot,
  table: string,
  mutate: (rows: Record<string, string | number | null>[]) => void,
) {
  const clone = clonePortableSnapshot(source);
  mutate(clone.rows[table]!);
  return buildSystemBackupPackage(clone);
}

async function assertDomainPackageRejected(
  admin: UserRecord,
  sourcePromise: Promise<BuiltBackupPackage>,
  label: string,
) {
  const source = await sourcePromise;
  const jobId = await uploadSystemBackupPackage(admin, source);
  let rejected: unknown;
  for (let step = 0; step < 2_000; step += 1) {
    try {
      const status = await advanceSystemBackupJob(admin, jobId);
      if (status.status === "failed") break;
      if (status.status === "ready") {
        assert.fail(`${label} unexpectedly passed preflight`);
      }
    } catch (error) {
      rejected = error;
      break;
    }
  }
  assert.ok(rejected instanceof Error, `${label} did not produce a validation error`);
  assert.equal(
    (await getSystemBackupJobStatus(admin, jobId)).status,
    "failed",
    `${label} was not durably rejected`,
  );
}

async function driveUntilPhase(currentUser: UserRecord, jobId: string, phase: string) {
  let status = await getSystemBackupJobStatus(currentUser, jobId);
  for (let step = 0; step < 5_000 && status.phase !== phase; step += 1) {
    status = await advanceSystemBackupJob(currentUser, jobId);
    if (status.status === "failed") throw new Error(status.error ?? status.phase);
  }
  assert.equal(status.phase, phase);
  return status;
}

async function captureLiveState(database: D1Database, bucket: R2Bucket) {
  const rows: Record<string, string[]> = {};
  for (const table of tableDefinitions) {
    const result = await database.prepare(`SELECT * FROM ${table.name} ORDER BY ${table.orderBy}`)
      .all<Record<string, unknown>>();
    rows[table.name] = result.results.map(canonicalJson);
  }
  const objects: Array<{ key: string; size: number; sha256: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ limit: 250, ...(cursor ? { cursor } : {}) });
    for (const item of page.objects) {
      if (item.key.includes("/backup-staging/")) continue;
      const object = await bucket.get(item.key);
      assert.ok(object);
      objects.push({ key: item.key, size: item.size, sha256: await digest(await object.arrayBuffer()) });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  objects.sort((left, right) => left.key.localeCompare(right.key));
  return { rows, objects };
}

function failOneLiveDelete(bucket: R2Bucket, onFailure: () => void): R2Bucket {
  let failed = false;
  return new Proxy(bucket, {
    get(target, property) {
      if (property === "delete") {
        return async (keys: string | string[]) => {
          const values = Array.isArray(keys) ? keys : [keys];
          if (!failed && values.some((key) => !key.includes("/backup-staging/"))) {
            failed = true;
            onFailure();
            throw new Error("Injected cleanup object-storage delete failure");
          }
          return target.delete(keys);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function digest(value: Uint8Array | ArrayBuffer) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const result = await crypto.subtle.digest("SHA-256", input.buffer);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
