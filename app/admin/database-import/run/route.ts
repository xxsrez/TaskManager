import { env } from "cloudflare:workers";

import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getD1 } from "@/db";
import { isAdminEmail } from "@/lib/admin";
import { ensureDatabase } from "@/lib/repository";

export const dynamic = "force-dynamic";

type Cell = string | number | null;
type Row = Record<string, Cell>;
type SnapshotTable = {
  columns: string[];
  rows: Row[];
  count: number;
  sha256: string;
};
type DatabaseSnapshot = {
  schemaVersion: number;
  exportedAt: string;
  tables: Record<string, SnapshotTable>;
  totalRows: number;
  sha256: string;
};

const tables = {
  users: [
    "id",
    "display_name",
    "email",
    "timezone",
    "created_at",
    "updated_at",
  ],
  user_identities: [
    "user_id",
    "provider",
    "provider_account_key",
    "verified_email",
    "created_at",
  ],
  workflow_statuses: [
    "id",
    "owner_user_id",
    "name",
    "category",
    "color",
    "position",
    "is_default",
    "created_at",
    "updated_at",
  ],
  projects: [
    "id",
    "owner_user_id",
    "creator_user_id",
    "name",
    "summary",
    "description",
    "status",
    "lead_user_id",
    "start_date",
    "target_date",
    "icon",
    "color",
    "archived_at",
    "version",
    "created_at",
    "updated_at",
    "public_id",
  ],
  releases: [
    "id",
    "project_id",
    "owner_user_id",
    "creator_user_id",
    "name",
    "description",
    "status",
    "target_date",
    "released_at",
    "release_notes",
    "version",
    "created_at",
    "updated_at",
    "public_id",
  ],
  tasks: [
    "id",
    "owner_user_id",
    "creator_user_id",
    "identifier",
    "sequence_number",
    "title",
    "description",
    "status_id",
    "priority",
    "assignee_user_id",
    "project_id",
    "release_id",
    "estimate",
    "due_date",
    "parent_task_id",
    "rank",
    "started_at",
    "completed_at",
    "canceled_at",
    "archived_at",
    "version",
    "created_at",
    "updated_at",
    "public_id",
  ],
  labels: ["id", "owner_user_id", "name", "color", "created_at"],
  task_labels: ["task_id", "label_id"],
  task_relations: [
    "source_task_id",
    "target_task_id",
    "type",
    "creator_user_id",
    "created_at",
  ],
  saved_views: [
    "id",
    "owner_user_id",
    "name",
    "scope_project_id",
    "query_json",
    "display_json",
    "version",
    "created_at",
    "updated_at",
    "public_id",
  ],
  external_records: [
    "id",
    "owner_user_id",
    "target_type",
    "target_id",
    "source",
    "source_id",
    "source_url",
    "metadata_json",
    "imported_at",
  ],
  access_grants: [
    "id",
    "resource_type",
    "resource_id",
    "owner_user_id",
    "grantee_user_id",
    "granted_by_user_id",
    "permission",
    "revoked_at",
    "created_at",
  ],
} as const;

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  const configuredEmails = (
    env as unknown as { TASK_MANAGER_ADMIN_EMAILS?: string }
  ).TASK_MANAGER_ADMIN_EMAILS;
  if (!user || !isAdminEmail(user.email, configuredEmails)) {
    return htmlResult(403, { error: "Not found" });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 20_000_000) {
    return htmlResult(413, { error: "Snapshot is too large" });
  }

  try {
    const form = await request.formData();
    const rawSnapshot = form.get("snapshot");
    if (typeof rawSnapshot !== "string") {
      return htmlResult(400, { error: "Snapshot is required" });
    }
    const snapshot = await validateSnapshot(JSON.parse(rawSnapshot));
    const result = await importSnapshot(snapshot);
    return htmlResult(200, result);
  } catch (error) {
    console.error(error);
    return htmlResult(400, {
      error: error instanceof Error ? error.message : "Database import failed",
    });
  }
}

async function validateSnapshot(value: unknown): Promise<DatabaseSnapshot> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Snapshot must be an object");
  }
  const snapshot = value as Partial<DatabaseSnapshot>;
  if (snapshot.schemaVersion !== 1 || !snapshot.tables) {
    throw new Error("Unsupported snapshot schema");
  }

  const expectedNames = Object.keys(tables).sort();
  const actualNames = Object.keys(snapshot.tables).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Snapshot table set does not match the application schema");
  }

  let totalRows = 0;
  const tableHashes: Record<string, string> = {};
  for (const [tableName, expectedColumns] of Object.entries(tables)) {
    const table = snapshot.tables[tableName];
    if (
      !table ||
      JSON.stringify(table.columns) !== JSON.stringify(expectedColumns) ||
      !Array.isArray(table.rows) ||
      table.count !== table.rows.length
    ) {
      throw new Error(`Snapshot table ${tableName} is malformed`);
    }
    for (const row of table.rows) validateRow(tableName, expectedColumns, row);
    const hash = await sha256(canonicalRows(table.rows));
    if (hash !== table.sha256) {
      throw new Error(`Snapshot hash mismatch for ${tableName}`);
    }
    totalRows += table.count;
    tableHashes[tableName] = hash;
  }

  const fullHash = await snapshotHash(tableHashes);
  if (snapshot.totalRows !== totalRows || snapshot.sha256 !== fullHash) {
    throw new Error("Snapshot checksum mismatch");
  }
  return snapshot as DatabaseSnapshot;
}

function validateRow(
  tableName: string,
  expectedColumns: readonly string[],
  value: unknown,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Snapshot row in ${tableName} is malformed`);
  }
  const row = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(row).sort()) !==
    JSON.stringify([...expectedColumns].sort())
  ) {
    throw new Error(`Snapshot columns in ${tableName} do not match`);
  }
  for (const cell of Object.values(row)) {
    if (
      cell !== null &&
      typeof cell !== "string" &&
      !(typeof cell === "number" && Number.isFinite(cell))
    ) {
      throw new Error(`Snapshot value in ${tableName} is invalid`);
    }
  }
}

async function importSnapshot(snapshot: DatabaseSnapshot) {
  await ensureDatabase();
  const db = getD1();

  for (const tableName of Object.keys(tables)) {
    const row = await db
      .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
      .first<{ count: number }>();
    if (Number(row?.count ?? 0) !== 0) {
      throw new Error(`Target table ${tableName} is not empty`);
    }
  }

  const statements: D1PreparedStatement[] = [];
  for (const [tableName, columns] of Object.entries(tables)) {
    const rows = snapshot.tables[tableName].rows;
    for (let offset = 0; offset < rows.length; offset += 20) {
      const chunk = rows.slice(offset, offset + 20);
      const rowPlaceholders = `(${columns.map(() => "?").join(", ")})`;
      const sql = `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES ${chunk
        .map(() => rowPlaceholders)
        .join(", ")}`;
      const values = chunk.flatMap((row) => columns.map((column) => row[column]));
      statements.push(db.prepare(sql).bind(...values));
    }
  }

  await db.batch(statements);
  await db.prepare("PRAGMA optimize").run();

  const importedTables: Record<string, { count: number; sha256: string }> = {};
  for (const [tableName, columns] of Object.entries(tables)) {
    const result = await db
      .prepare(`SELECT ${columns.join(", ")} FROM ${tableName}`)
      .all<Row>();
    importedTables[tableName] = {
      count: result.results.length,
      sha256: await sha256(canonicalRows(result.results)),
    };
  }

  const importedHashes = Object.fromEntries(
    Object.entries(importedTables).map(([name, table]) => [name, table.sha256]),
  );
  const importedHash = await snapshotHash(importedHashes);
  const mismatchedTables = Object.entries(importedTables)
    .filter(
      ([name, table]) =>
        table.count !== snapshot.tables[name].count ||
        table.sha256 !== snapshot.tables[name].sha256,
    )
    .map(([name]) => name);

  if (mismatchedTables.length || importedHash !== snapshot.sha256) {
    throw new Error(
      `Imported database verification failed: ${mismatchedTables.join(", ")}`,
    );
  }

  return {
    imported: true,
    totalRows: Object.values(importedTables).reduce(
      (total, table) => total + table.count,
      0,
    ),
    sha256: importedHash,
    tables: importedTables,
  };
}

function canonicalRows(rows: Row[]): string {
  return JSON.stringify(
    rows
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      )
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
  );
}

async function snapshotHash(hashes: Record<string, string>) {
  return sha256(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(hashes).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    ),
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function htmlResult(status: number, value: unknown) {
  const json = JSON.stringify(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return new Response(
    `<!doctype html><meta charset="utf-8"><pre id="database-import-result">${json}</pre>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
