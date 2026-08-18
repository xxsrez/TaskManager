import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  assertBackupContainsIdentity,
  authenticationCapabilityDeleteOrder,
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
  assert.equal(backup.schemaVersion, 6);
  const validated = await validateSystemBackup(backup);

  assert.equal(validated.sha256, backup.sha256);
  assert.equal(validated.counts.users, 2);
  assert.equal(validated.counts.tasks, 2);
  assert.equal(validated.tables.tasks[0]?.title, "Ship backup support");
  assert.equal(validated.tables.access_grants[0]?.permission, "full_access");
});

test("system validation accepts a locked Project whose allocated Tasks are gone", async () => {
  const tables = validTables();
  tables.projects.push({
    ...tables.projects[0]!,
    id: "project-empty-history",
    public_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "Archived number history",
    task_code: "AH",
    task_sequence: 7,
    lead_user_id: null,
  });
  const backup = await createSystemBackup(tables, now);
  assert.equal(
    (await validateSystemBackup(backup)).tables.projects.find(
      (project) => project.id === "project-empty-history",
    )?.task_sequence,
    7,
  );
});

test("the comment-aware system schema rejects an older backup explicitly", async () => {
  const backup = await createSystemBackup(validTables(), now);
  await assert.rejects(
    validateSystemBackup({ ...backup, schemaVersion: 1 }),
    /unsupported task manager backup format or version/i,
  );
});

test("schema 2 system backups without attachments remain importable", async () => {
  const current = await createSystemBackup(validTables(), now);
  const tables = Object.fromEntries(
    Object.entries(current.tables).filter(([name]) => !["attachments", "task_identifier_aliases"].includes(name)),
  );
  tables.projects = current.tables.projects.map(legacyProjectRow);
  tables.workflow_statuses = current.tables.workflow_statuses.map(legacyWorkflowRow);
  tables.task_relations = current.tables.task_relations.map(legacyRelationRow);
  const counts = Object.fromEntries(
    Object.entries(current.counts).filter(([name]) => !["attachments", "task_identifier_aliases"].includes(name)),
  );
  const body = {
    format: current.format,
    version: current.version,
    schemaVersion: 2,
    exportedAt: current.exportedAt,
    counts,
    tables,
  };
  const legacy = { ...body, sha256: await checksum(JSON.stringify(body)) };

  const validated = await validateSystemBackup(legacy);
  assert.equal(validated.schemaVersion, 2);
  assert.deepEqual(validated.tables.attachments, []);
});

test("schema 3 system backups synthesize reserved workflow metadata before restore", async () => {
  const current = await createSystemBackup(validTables(), now);
  const legacyStatuses = current.tables.workflow_statuses
    .filter((status) => status.system_role !== "duplicate")
    .map(legacyWorkflowRow);
  const tables = {
    ...Object.fromEntries(Object.entries(current.tables).filter(([name]) => name !== "task_identifier_aliases")),
    projects: current.tables.projects.map(legacyProjectRow),
    workflow_statuses: legacyStatuses,
    task_relations: current.tables.task_relations.map(legacyRelationRow),
  };
  const counts = {
    ...Object.fromEntries(Object.entries(current.counts).filter(([name]) => name !== "task_identifier_aliases")),
    workflow_statuses: legacyStatuses.length,
  };
  const body = {
    format: current.format,
    version: current.version,
    schemaVersion: 3,
    siteOrigin: current.siteOrigin,
    environmentScope: current.environmentScope,
    exportedAt: current.exportedAt,
    counts,
    tables,
    objects: current.objects,
  };
  const legacy = { ...body, sha256: await checksum(JSON.stringify(body)) };

  const validated = await validateSystemBackup(legacy);
  assert.equal(validated.schemaVersion, 3);
  assert.equal(validated.tables.workflow_statuses.filter((status) => status.system_role === "duplicate").length, 2);
  assert.equal(validated.counts.workflow_statuses, legacyStatuses.length + 2);
});

test("schema 4 system backups upgrade legacy relation identity and concurrency metadata", async () => {
  const current = await createSystemBackup(validTables(), now);
  const tables = {
    ...Object.fromEntries(Object.entries(current.tables).filter(([name]) => name !== "task_identifier_aliases")),
    projects: current.tables.projects.map(legacyProjectRow),
    task_relations: current.tables.task_relations.map(legacyRelationRow),
  };
  const unsigned = {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => key !== "sha256")),
    schemaVersion: 4,
    counts: Object.fromEntries(Object.entries(current.counts).filter(([name]) => name !== "task_identifier_aliases")),
    tables,
  };
  const legacy = { ...unsigned, sha256: await checksum(JSON.stringify(unsigned)) };

  const validated = await validateSystemBackup(legacy);
  assert.equal(validated.schemaVersion, 4);
  assert.equal(validated.tables.task_relations[0]?.id, "relation_legacy:task-1:task-2:blocks");
  assert.equal(validated.tables.task_relations[0]?.version, 1);
  assert.equal(validated.tables.task_relations[0]?.updated_at, now);
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

test("snapshot validation accepts transferred project ownership without rewriting child provenance", async () => {
  const tables = validTables();
  tables.projects[0]!.owner_user_id = "user-collaborator";
  tables.access_grants[0]!.owner_user_id = "user-collaborator";
  tables.access_grants[0]!.grantee_user_id = "user-admin";
  tables.access_grants[0]!.permission = "manager";
  const backup = await createSystemBackup(tables, now);

  const validated = await validateSystemBackup(backup);
  assert.equal(validated.tables.projects[0]?.owner_user_id, "user-collaborator");
  assert.equal(validated.tables.tasks[0]?.owner_user_id, "user-admin");
  assert.equal(validated.tables.access_grants[0]?.permission, "manager");
});

test("snapshot validation rejects Tasks without an explicit Project mapping", async () => {
  const tables = validTables();
  tables.projects[0]!.lead_user_id = null;
  tables.tasks[0]!.project_id = null;
  tables.tasks[0]!.release_id = null;
  tables.tasks[0]!.assignee_user_id = null;
  tables.task_relations = [];
  tables.access_grants[0]!.resource_type = "task";
  tables.access_grants[0]!.resource_id = "task-1";
  tables.access_grants[0]!.permission = "manager";
  const backup = await createSystemBackup(tables, now);

  await assert.rejects(validateSystemBackup(backup), /project_id cannot be null|explicit Project mapping/i);
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
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM api_credentials").get()!.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM oauth_grants").get()!.count, 1);

  applyStagedTables(database, importId);

  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users WHERE id = 'old-user'").get()!.count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get()!.count, 2);
  assert.equal(database.prepare("SELECT title FROM tasks WHERE id = 'task-1'").get()!.title, "Ship backup support");
  assert.equal(database.prepare("SELECT permission FROM access_grants WHERE id = 'grant-1'").get()!.permission, "full_access");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM api_credentials").get()!.count, 0);
  for (const table of authenticationCapabilityDeleteOrder) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count, 0);
  }
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
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM api_credentials").get()!.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM oauth_grants").get()!.count, 1);
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
        system_role: null,
        archived_at: null,
        version: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: "status-duplicate-admin",
        owner_user_id: "user-admin",
        name: "Duplicate",
        category: "canceled",
        color: "#9ca3af",
        position: 1,
        is_default: 0,
        system_role: "duplicate",
        archived_at: null,
        version: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: "status-todo-collaborator",
        owner_user_id: "user-collaborator",
        name: "Todo",
        category: "unstarted",
        color: "#94a3b8",
        position: 0,
        is_default: 1,
        system_role: null,
        archived_at: null,
        version: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: "status-duplicate-collaborator",
        owner_user_id: "user-collaborator",
        name: "Duplicate",
        category: "canceled",
        color: "#9ca3af",
        position: 1,
        is_default: 0,
        system_role: "duplicate",
        archived_at: null,
        version: 1,
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
        task_code: "TM",
        task_sequence: 2,
        code_locked_at: now,
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
        comment_count: 1,
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
        comment_count: 0,
        version: 1,
        created_at: now,
        updated_at: now,
      },
    ],
    task_identifier_aliases: [],
    attachments: [],
    comments: [
      {
        id: "comment-1",
        task_id: "task-1",
        author_user_id: "user-admin",
        body: "Native backup comment",
        source: "native",
        parent_comment_id: null,
        idempotency_key: "backup-comment-1",
        created_at: now,
        updated_at: now,
        deleted_at: null,
        resolved_at: null,
        resolved_by_user_id: null,
        resolution_comment_id: null,
        version: 1,
      },
    ],
    comment_reactions: [
      { comment_id: "comment-1", user_id: "user-collaborator", emoji: "👍", created_at: now },
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
        id: "relation-1",
        source_task_id: "task-1",
        target_task_id: "task-2",
        type: "blocks",
        creator_user_id: "user-admin",
        idempotency_key: "backup-relation-1",
        version: 1,
        created_at: now,
        updated_at: now,
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

async function checksum(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function legacyWorkflowRow(row: Record<string, string | number | null>) {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) =>
      !["system_role", "archived_at", "version"].includes(key),
    ),
  );
}

function legacyProjectRow(row: Record<string, string | number | null>) {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) =>
      !["task_code", "task_sequence", "code_locked_at"].includes(key),
    ),
  );
}

function legacyRelationRow(row: Record<string, string | number | null>) {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) =>
      !["id", "idempotency_key", "version", "updated_at"].includes(key),
    ),
  );
}

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "0000_chilly_malice.sql",
    "0001_wide_skreet.sql",
    "0002_stiff_madame_hydra.sql",
    "0003_green_white_queen.sql",
    "0004_large_rocket_racer.sql",
    "0005_mixed_bruce_banner.sql",
    "0006_complex_reavers.sql",
    "0007_curious_sharon_carter.sql",
    "0008_loose_the_fallen.sql",
    "0009_talented_otto_octavius.sql",
    "0010_crazy_puma.sql",
    "0011_conscious_paibok.sql",
    "0012_empty_saracen.sql",
    "0013_rapid_gravity.sql",
    "0014_puzzling_tana_nile.sql",
    "0015_attachments_sync.sql",
    "0016_abandoned_stellaris.sql",
    "0017_complex_epoch.sql",
    "0018_tearful_black_panther.sql",
  ]) {
    database.exec(readFileSync(join(process.cwd(), "drizzle", migration), "utf8"));
  }
  return database;
}

function insertOldState(database: DatabaseSync) {
  database.prepare(
    "INSERT INTO users (id, display_name, email, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("old-user", "Old state", "old@example.com", "UTC", now, now);
  database.prepare(
    `INSERT INTO api_credentials
      (id, owner_user_id, name, token_prefix, token_hash, scopes_json, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "api-old",
    "old-user",
    "Old token",
    "tm_pat_old",
    "old-hash",
    '["api:read"]',
    "2027-08-14T00:00:00.000Z",
  );
  database.prepare(
    `INSERT INTO oauth_grants
      (id, owner_user_id, client_id, client_name, resource, scopes_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "oauth-grant-old",
    "old-user",
    "https://chatgpt.com/client.json",
    "Codex Desktop",
    "https://tasks.example.test/api/mcp",
    '["api:read"]',
  );
  database.prepare(
    `INSERT INTO oauth_access_tokens
      (id, token_hash, grant_id, owner_user_id, client_id, resource,
       scopes_json, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "oauth-access-old",
    "oauth-access-hash",
    "oauth-grant-old",
    "old-user",
    "https://chatgpt.com/client.json",
    "https://tasks.example.test/api/mcp",
    '["api:read"]',
    "2027-08-14T00:00:00.000Z",
  );
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
    for (const table of authenticationCapabilityDeleteOrder) {
      database.exec(`DELETE FROM ${table}`);
    }
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
