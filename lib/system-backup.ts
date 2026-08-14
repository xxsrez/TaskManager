import { env } from "cloudflare:workers";
import { assertAdmin } from "./admin";
import { ValidationError } from "./domain";
import type {
  AppliedSystemBackup,
  StagedSystemBackup,
  SystemBackupCounts,
  UserRecord,
} from "./types";
import { getD1 } from "@/db";
import { ensureDatabase } from "./repository";
import {
  assertBackupContainsIdentity,
  createSystemBackup,
  liveTableDeleteOrder,
  normalizeDbRow,
  restoreInsertSql,
  tableDefinitions,
  validateSystemBackup,
  type BackupTables,
  type SystemBackup,
} from "./system-backup-format";

export { maxSystemBackupBytes } from "./system-backup-format";

export async function exportSystemBackup(currentUser: UserRecord): Promise<SystemBackup> {
  assertConfiguredAdmin(currentUser);
  await ensureDatabase();
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
  return createSystemBackup(tables);
}

export async function stageSystemBackup(
  currentUser: UserRecord,
  payload: unknown,
): Promise<StagedSystemBackup> {
  assertConfiguredAdmin(currentUser);
  await ensureDatabase();
  const backup = await validateSystemBackup(payload);
  const db = getD1();
  const identities = await db
    .prepare("SELECT provider, provider_account_key FROM user_identities WHERE user_id = ?")
    .bind(currentUser.id)
    .all<{ provider: string; provider_account_key: string }>();
  assertBackupContainsIdentity(backup, identities.results);

  const importId = `admin-import:${crypto.randomUUID()}`;
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
  const stagedRows = tableDefinitions.flatMap((table) =>
    backup.tables[table.name].map((row, ordinal) => ({ table: table.name, ordinal, json: JSON.stringify(row) })),
  );
  for (let offset = 0; offset < stagedRows.length; offset += 25) {
    const rows = stagedRows.slice(offset, offset + 25);
    const placeholders = rows.map(() => "(?, ?, ?, ?)").join(", ");
    const values = rows.flatMap((row) => [importId, row.table, row.ordinal, row.json]);
    statements.push(
      db.prepare(`INSERT INTO admin_import_rows (import_id, table_name, ordinal, row_json) VALUES ${placeholders}`).bind(...values),
    );
  }
  await db.batch(statements);
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
  await ensureDatabase();
  const db = getD1();
  const session = await db
    .prepare(`SELECT source_exported_at, counts_json FROM admin_import_sessions
      WHERE id = ? AND created_by_user_id = ? AND payload_sha256 = ?
        AND status = 'staged' AND datetime(created_at) >= datetime('now', '-1 day')`)
    .bind(input.importId, currentUser.id, input.sha256)
    .first<{ source_exported_at: string; counts_json: string }>();
  if (!session) throw new ValidationError("Staged backup is missing, expired, or belongs to another administrator");

  const statements: D1PreparedStatement[] = [];
  // API credentials are deliberately excluded from logical backups. A full
  // restore revokes them instead of carrying authentication capabilities into
  // the restored state.
  statements.push(db.prepare("DELETE FROM api_credentials"));
  for (const table of liveTableDeleteOrder) statements.push(db.prepare(`DELETE FROM ${table}`));
  for (const table of tableDefinitions) {
    statements.push(
      db.prepare(restoreInsertSql(table))
        .bind(input.importId, table.name),
    );
  }
  statements.push(
    db.prepare("UPDATE admin_import_sessions SET status = 'applied', applied_at = CURRENT_TIMESTAMP WHERE id = ?").bind(input.importId),
    db.prepare("DELETE FROM admin_import_rows WHERE import_id = ?").bind(input.importId),
  );
  await db.batch(statements);
  await db.prepare("PRAGMA optimize").run();
  return {
    applied: true,
    exportedAt: session.source_exported_at,
    counts: JSON.parse(session.counts_json) as SystemBackupCounts,
  };
}

function assertConfiguredAdmin(user: UserRecord) {
  const configured = (env as unknown as { TASK_MANAGER_ADMIN_EMAILS?: string }).TASK_MANAGER_ADMIN_EMAILS ?? "";
  assertAdmin(user, configured);
}
