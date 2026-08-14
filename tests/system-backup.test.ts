import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  assertBackupContainsIdentity,
  createSystemBackup,
  liveTableDeleteOrder,
  restoreInsertSql,
  tableDefinitions,
  validateSystemBackup,
  type BackupTables,
} from "../lib/system-backup-format";

const now = "2026-08-14T12:00:00.000Z";

test("a complete system snapshot validates and preserves application data", async () => {
  const backup = await createSystemBackup(validTables(), now);
  const validated = await validateSystemBackup(backup);

  assert.equal(validated.sha256, backup.sha256);
  assert.equal(validated.counts.users, 2);
  assert.equal(validated.counts.tasks, 2);
  assert.equal(validated.tables.tasks[0]?.title, "Ship backup support");
  assert.equal(validated.tables.access_grants[0]?.permission, "full_access");
});

test("snapshot validation rejects content changed after export", async () => {
  const backup = await createSystemBackup(validTables(), now);
  backup.tables.tasks[0]!.title = "Changed after signing";

  await assert.rejects(
    validateSystemBackup(backup),
    /checksum does not match/i,
  );
});

test("snapshot validation rejects an empty mandatory task title", async () => {
  const tables = validTables();
  tables.tasks[0]!.title = "  ";
  const backup = await createSystemBackup(tables, now);

  await assert.rejects(validateSystemBackup(backup), /Task title cannot be empty/i);
});

test("snapshot validation rejects an assignee without active access", async () => {
  const tables = validTables();
  tables.projects[0]!.lead_user_id = null;
  tables.access_grants[0]!.revoked_at = now;
  const backup = await createSystemBackup(tables, now);

  await assert.rejects(
    validateSystemBackup(backup),
    /assignee must have access/i,
  );
});

test("snapshot validation rejects cyclic task hierarchy", async () => {
  const tables = validTables();
  tables.tasks[0]!.parent_task_id = "task-2";
  tables.tasks[1]!.parent_task_id = "task-1";
  const backup = await createSystemBackup(tables, now);

  await assert.rejects(validateSystemBackup(backup), /contains a cycle/i);
});

test("restore requires the current administrator identity in the snapshot", async () => {
  const backup = await createSystemBackup(validTables(), now);

  assert.doesNotThrow(() =>
    assertBackupContainsIdentity(backup, [
      { provider: "chatgpt", provider_account_key: "admin-account" },
    ]),
  );
  assert.throws(
    () =>
      assertBackupContainsIdentity(backup, [
        { provider: "chatgpt", provider_account_key: "missing-account" },
      ]),
    /current administrator identity/i,
  );
});

test("staged restore SQL replaces every live table on the current schema", () => {
  const database = migratedDatabase();
  insertOldState(database);
  const importId = stageTables(database, validTables());
  assert.equal(database.prepare("SELECT display_name FROM users WHERE id = 'old-user'").get()!.display_name, "Old state");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM tasks").get()!.count, 0);

  applyStagedTables(database, importId);

  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users WHERE id = 'old-user'").get()!.count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get()!.count, 2);
  assert.equal(database.prepare("SELECT title FROM tasks WHERE id = 'task-1'").get()!.title, "Ship backup support");
  assert.equal(database.prepare("SELECT permission FROM access_grants WHERE id = 'grant-1'").get()!.permission, "full_access");
  database.close();
});

test("restore SQL rolls back deletion if any staged insert fails", () => {
  const database = migratedDatabase();
  insertOldState(database);
  const tables = validTables();
  tables.users[0]!.display_name = null;
  const importId = stageTables(database, tables);

  assert.throws(() => applyStagedTables(database, importId), /NOT NULL constraint failed/i);
  assert.equal(database.prepare("SELECT display_name FROM users WHERE id = 'old-user'").get()!.display_name, "Old state");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM tasks").get()!.count, 0);
  database.close();
});

function validTables(): BackupTables {
  return {
    users: [
      {
        id: "user-admin",
        display_name: "Admin",
        email: "admin@example.com",
        timezone: "UTC",
        created_at: now,
        updated_at: now,
      },
      {
        id: "user-collaborator",
        display_name: "Collaborator",
        email: "collaborator@example.com",
        timezone: "UTC",
        created_at: now,
        updated_at: now,
      },
    ],
    user_identities: [
      {
        user_id: "user-admin",
        provider: "chatgpt",
        provider_account_key: "admin-account",
        verified_email: "admin@example.com",
        created_at: now,
      },
      {
        user_id: "user-collaborator",
        provider: "chatgpt",
        provider_account_key: "collaborator-account",
        verified_email: "collaborator@example.com",
        created_at: now,
      },
    ],
    workflow_statuses: [
      {
        id: "status-todo",
        owner_user_id: "user-admin",
        name: "Todo",
        category: "unstarted",
        color: "#94a3b8",
        position: 0,
        is_default: 1,
        created_at: now,
        updated_at: now,
      },
    ],
    projects: [
      {
        id: "project-1",
        public_id: "11111111-1111-4111-8111-111111111111",
        owner_user_id: "user-admin",
        creator_user_id: "user-admin",
        name: "Task Manager",
        summary: "",
        description: "",
        status: "active",
        lead_user_id: "user-collaborator",
        start_date: null,
        target_date: null,
        icon: "cube",
        color: "#8b7cf6",
        archived_at: null,
        version: 1,
        created_at: now,
        updated_at: now,
      },
    ],
    releases: [
      {
        id: "release-1",
        public_id: "22222222-2222-4222-8222-222222222222",
        project_id: "project-1",
        owner_user_id: "user-admin",
        creator_user_id: "user-admin",
        name: "UAT",
        description: "",
        status: "active",
        target_date: null,
        released_at: null,
        release_notes: "",
        version: 1,
        created_at: now,
        updated_at: now,
      },
    ],
    tasks: [
      {
        id: "task-1",
        public_id: "33333333-3333-4333-8333-333333333333",
        owner_user_id: "user-admin",
        creator_user_id: "user-admin",
        identifier: "TM-1",
        sequence_number: 1,
        title: "Ship backup support",
        description: "",
        status_id: "status-todo",
        priority: "high",
        assignee_user_id: "user-collaborator",
        project_id: "project-1",
        release_id: "release-1",
        estimate: 3,
        due_date: null,
        parent_task_id: null,
        rank: 1000,
        started_at: null,
        completed_at: null,
        canceled_at: null,
        archived_at: null,
        version: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: "task-2",
        public_id: "44444444-4444-4444-8444-444444444444",
        owner_user_id: "user-admin",
        creator_user_id: "user-admin",
        identifier: "TM-2",
        sequence_number: 2,
        title: "Verify backup support",
        description: "",
        status_id: "status-todo",
        priority: "none",
        assignee_user_id: null,
        project_id: "project-1",
        release_id: null,
        estimate: null,
        due_date: null,
        parent_task_id: null,
        rank: 2000,
        started_at: null,
        completed_at: null,
        canceled_at: null,
        archived_at: null,
        version: 1,
        created_at: now,
        updated_at: now,
      },
    ],
    labels: [
      {
        id: "label-1",
        owner_user_id: "user-admin",
        name: "Infrastructure",
        color: "#6b7280",
        created_at: now,
      },
    ],
    task_labels: [{ task_id: "task-1", label_id: "label-1" }],
    task_relations: [
      {
        source_task_id: "task-1",
        target_task_id: "task-2",
        type: "blocks",
        creator_user_id: "user-admin",
        created_at: now,
      },
    ],
    saved_views: [
      {
        id: "view-1",
        public_id: "55555555-5555-4555-8555-555555555555",
        owner_user_id: "user-admin",
        name: "Backup work",
        scope_project_id: "project-1",
        query_json: "{}",
        display_json: "{}",
        version: 1,
        created_at: now,
        updated_at: now,
      },
    ],
    external_records: [
      {
        id: "external-1",
        owner_user_id: "user-admin",
        target_type: "task",
        target_id: "task-1",
        source: "linear",
        source_id: "linear-task-1",
        source_url: "https://linear.example/task-1",
        metadata_json: "{}",
        imported_at: now,
      },
    ],
    access_grants: [
      {
        id: "grant-1",
        resource_type: "project",
        resource_id: "project-1",
        owner_user_id: "user-admin",
        grantee_user_id: "user-collaborator",
        granted_by_user_id: "user-admin",
        permission: "full_access",
        revoked_at: null,
        created_at: now,
      },
    ],
  };
}

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "0000_chilly_malice.sql",
    "0001_wide_skreet.sql",
    "0002_stiff_madame_hydra.sql",
    "0003_green_white_queen.sql",
  ]) {
    database.exec(readFileSync(join(process.cwd(), "drizzle", migration), "utf8"));
  }
  return database;
}

function insertOldState(database: DatabaseSync) {
  database.prepare(
    "INSERT INTO users (id, display_name, email, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("old-user", "Old state", "old@example.com", "UTC", now, now);
}

function stageTables(database: DatabaseSync, tables: BackupTables) {
  const importId = "admin-import:test";
  const insert = database.prepare(
    "INSERT INTO admin_import_rows (import_id, table_name, ordinal, row_json) VALUES (?, ?, ?, ?)",
  );
  for (const table of tableDefinitions) {
    tables[table.name].forEach((row, ordinal) => {
      insert.run(importId, table.name, ordinal, JSON.stringify(row));
    });
  }
  return importId;
}

function applyStagedTables(database: DatabaseSync, importId: string) {
  database.exec("BEGIN");
  try {
    for (const table of liveTableDeleteOrder) database.exec(`DELETE FROM ${table}`);
    for (const table of tableDefinitions) {
      database.prepare(restoreInsertSql(table)).run(importId, table.name);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
