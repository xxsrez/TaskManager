import { assertAdmin } from "./admin";
import { ValidationError } from "./domain";
import type {
  AppliedSystemBackup,
  StagedSystemBackup,
  SystemBackupCounts,
  UserRecord,
} from "./types";
import { getD1 } from "@/db";
import {
  assertBackupContainsIdentity,
  authenticationCapabilityDeleteOrder,
  createSystemBackup,
  liveTableDeleteOrder,
  normalizeDbRow,
  restoreInsertSql,
  restoreTableDefinitions,
  tableDefinitions,
  validateSystemBackup,
  type BackupTables,
  type SystemBackup,
} from "./system-backup-format";
import { getRuntimeEnvironment } from "./runtime-environment";
import { attachmentStorageScope } from "./attachment-storage";
import {
  collectAttachmentBackupObjects,
  deleteAttachmentObjects,
  materializeStagedAttachmentObjects,
  parseStagedAttachmentObject,
  serializeStagedAttachmentObject,
  stageAttachmentBackupObjects,
} from "./attachment-backup";
import { restoreStoredFileStatements } from "./attachments";

export { maxSystemBackupBytes } from "./system-backup-format";

export async function exportSystemBackup(currentUser: UserRecord): Promise<SystemBackup> {
  assertConfiguredAdmin(currentUser);
  const db = getD1();
  const results = await db.batch(
    tableDefinitions.map((table) =>
      db.prepare(`SELECT ${table.columns.join(", ")} FROM ${table.name} ORDER BY ${table.orderBy}`),
    ),
  );
  const tables = {} as BackupTables;
  tableDefinitions.forEach((table, index) => {
    tables[table.name] = results[index].results.map((row) => normalizeDbRow(table, row as Record<string, unknown>));
  });
  const attachmentData = await collectAttachmentBackupObjects(
    tables.attachments,
  );
  tables.attachments = attachmentData.rows;
  return createSystemBackup(
    tables,
    undefined,
    attachmentData.objects,
    systemBackupSiteOrigin(),
    attachmentStorageScope(),
  );
}

export async function stageSystemBackup(
  currentUser: UserRecord,
  payload: unknown,
): Promise<StagedSystemBackup> {
  assertConfiguredAdmin(currentUser);
  const backup = await validateSystemBackup(payload);
  if (backup.siteOrigin && backup.siteOrigin !== systemBackupSiteOrigin()) {
    throw new ValidationError(
      "System backup belongs to another Task Manager Site",
    );
  }
  if (
    backup.environmentScope &&
    backup.environmentScope !== attachmentStorageScope()
  ) {
    throw new ValidationError(
      "System backup belongs to another attachment environment",
    );
  }
  const db = getD1();
  const identities = await db
    .prepare("SELECT provider, provider_account_key FROM user_identities WHERE user_id = ?")
    .bind(currentUser.id)
    .all<{ provider: string; provider_account_key: string }>();
  assertBackupContainsIdentity(backup, identities.results);

  const importId = `admin-import:${crypto.randomUUID()}`;
  const attachmentStage = await stageAttachmentBackupObjects(
    importId,
    backup.tables.attachments,
    backup.objects,
  );
  backup.tables.attachments = attachmentStage.rows;
  const statements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM admin_import_rows WHERE import_id IN (
      SELECT id FROM admin_import_sessions
      WHERE status = 'staged' AND datetime(created_at) < datetime('now', '-1 day')
    )`),
    db.prepare(`UPDATE admin_import_sessions SET status = 'expired'
      WHERE status = 'staged' AND datetime(created_at) < datetime('now', '-1 day')`),
    db.prepare(`INSERT INTO admin_import_sessions
      (id, created_by_user_id, source_exported_at, source_schema_version,
       payload_sha256, counts_json, status)
      VALUES (?, ?, ?, ?, ?, ?, 'staged')`)
      .bind(importId, currentUser.id, backup.exportedAt, backup.schemaVersion, backup.sha256, JSON.stringify(backup.counts)),
  ];
  const stagedRows: Array<{ table: string; ordinal: number; json: string }> = tableDefinitions.flatMap((table) =>
    backup.tables[table.name].map((row, ordinal) => ({ table: table.name, ordinal, json: JSON.stringify(row) })),
  );
  stagedRows.push(
    ...attachmentStage.staged.map((object, ordinal) => ({
      table: "__attachment_objects" as const,
      ordinal,
      json: serializeStagedAttachmentObject(object),
    })),
  );
  for (let offset = 0; offset < stagedRows.length; offset += 25) {
    const rows = stagedRows.slice(offset, offset + 25);
    const placeholders = rows.map(() => "(?, ?, ?, ?)").join(", ");
    const values = rows.flatMap((row) => [importId, row.table, row.ordinal, row.json]);
    statements.push(
      db.prepare(`INSERT INTO admin_import_rows (import_id, table_name, ordinal, row_json) VALUES ${placeholders}`).bind(...values),
    );
  }
  try {
    await db.batch(statements);
  } catch (error) {
    await deleteAttachmentObjects(
      attachmentStage.staged.map((object) => object.stagingKey),
    );
    throw error;
  }
  return { importId, exportedAt: backup.exportedAt, schemaVersion: backup.schemaVersion, sha256: backup.sha256, counts: backup.counts };
}

export async function applySystemBackup(
  currentUser: UserRecord,
  input: { importId: string; sha256: string; confirmation: string },
): Promise<AppliedSystemBackup> {
  assertConfiguredAdmin(currentUser);
  if (input.confirmation !== "RESTORE") throw new ValidationError("Type RESTORE to confirm replacement");
  if (!input.importId.startsWith("admin-import:") || !/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new ValidationError("Invalid staged backup reference");
  }
  const db = getD1();
  const session = await db
    .prepare(`SELECT source_exported_at, counts_json FROM admin_import_sessions
      WHERE id = ? AND created_by_user_id = ? AND payload_sha256 = ?
        AND status = 'staged' AND datetime(created_at) >= datetime('now', '-1 day')`)
    .bind(input.importId, currentUser.id, input.sha256)
    .first<{ source_exported_at: string; counts_json: string }>();
  if (!session) throw new ValidationError("Staged backup is missing, expired, or belongs to another administrator");

  const [descriptorRows, oldObjectRows] = await db.batch([
    db.prepare(`SELECT row_json FROM admin_import_rows
      WHERE import_id = ? AND table_name = '__attachment_objects'
      ORDER BY ordinal`).bind(input.importId),
    db.prepare("SELECT object_key FROM attachments"),
  ]);
  const stagedObjects = descriptorRows.results.map((row) =>
    parseStagedAttachmentObject((row as Record<string, unknown>).row_json),
  );
  const transition = await db.prepare(`UPDATE admin_import_sessions
    SET status = 'applying'
    WHERE id = ? AND created_by_user_id = ? AND payload_sha256 = ?
      AND status = 'staged' AND datetime(created_at) >= datetime('now', '-1 day')`)
    .bind(input.importId, currentUser.id, input.sha256).run();
  if (transition.meta.changes !== 1) {
    throw new ValidationError("System backup is already being applied");
  }
  let writtenObjects: string[] = [];
  try {
    writtenObjects = await materializeStagedAttachmentObjects(stagedObjects);
  } catch (error) {
    await db.prepare(`UPDATE admin_import_sessions SET status = 'staged'
      WHERE id = ? AND status = 'applying'`).bind(input.importId).run();
    throw error;
  }

  const statements: D1PreparedStatement[] = [];
  statements.push(db.prepare("DELETE FROM task_sequences"));
  // OAuth grants/tokens and personal API credentials are deliberately excluded
  // from logical backups. A full restore revokes every authentication
  // capability instead of carrying it into the restored state.
  for (const table of authenticationCapabilityDeleteOrder) {
    statements.push(db.prepare(`DELETE FROM ${table}`));
  }
  for (const table of liveTableDeleteOrder) statements.push(db.prepare(`DELETE FROM ${table}`));
  for (const table of restoreTableDefinitions) {
    statements.push(
      db.prepare(restoreInsertSql(table))
        .bind(input.importId, table.name),
    );
  }
  statements.push(...restoreStoredFileStatements(db));
  statements.push(
    db.prepare("UPDATE admin_import_sessions SET status = 'applied', applied_at = CURRENT_TIMESTAMP WHERE id = ?").bind(input.importId),
    db.prepare("DELETE FROM admin_import_rows WHERE import_id = ?").bind(input.importId),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    await deleteAttachmentObjects(writtenObjects);
    await db.prepare(`UPDATE admin_import_sessions SET status = 'staged'
      WHERE id = ? AND status = 'applying'`).bind(input.importId).run();
    throw error;
  }
  await deleteAttachmentObjects([
    ...oldObjectRows.results.map((row) =>
      String((row as Record<string, unknown>).object_key),
    ),
    ...stagedObjects.map((object) => object.stagingKey),
  ]);
  await db.prepare("PRAGMA optimize").run();
  return {
    applied: true,
    exportedAt: session.source_exported_at,
    counts: JSON.parse(session.counts_json) as SystemBackupCounts,
  };
}

function assertConfiguredAdmin(user: UserRecord) {
  const configured = getRuntimeEnvironment().TASK_MANAGER_ADMIN_EMAILS ?? "";
  assertAdmin(user, configured);
}

function systemBackupSiteOrigin() {
  return new URL(
    getRuntimeEnvironment().TASK_MANAGER_PUBLIC_ORIGIN ??
      "https://local.task-manager.invalid",
  ).origin;
}
