import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createProjectBackup,
  projectBackupTableDefinitions,
  projectRestoreInsertSql,
  validateProjectBackup,
  type ProjectBackupTables,
} from "../lib/project-backup-format";

const now = "2026-08-14T12:00:00.000Z";

test("project bundle validates one exact subtree without user identities", async () => {
  const backup = await createProjectBackup({
    siteOrigin: "https://task-manager.example",
    tables: validProjectTables(),
    sharing: [{
      granteeUserId: "user-editor",
      email: "editor@example.com",
      displayName: "Editor",
      permission: "editor",
    }],
    externalRelationsOmitted: 1,
    exportedAt: now,
  });
  assert.equal(backup.schemaVersion, 6);
  const validated = await validateProjectBackup(backup);
  assert.equal(validated.projectId, "project-1");
  assert.equal(validated.counts.tasks, 2);
  assert.equal(validated.counts.sharing, 1);
  assert.equal(validated.warnings.externalRelationsOmitted, 1);
  assert.equal("users" in validated.tables, false);
});

test("a Project keeps its locked sequence after every current Task is gone", async () => {
  const tables = validProjectTables();
  tables.tasks = [];
  tables.task_identifier_aliases = [];
  tables.attachments = [];
  tables.comments = [];
  tables.comment_reactions = [];
  tables.task_labels = [];
  tables.task_relations = [];
  tables.external_records = [];
  const backup = await createProjectBackup({
    siteOrigin: "https://task-manager.example",
    tables,
    sharing: [],
    externalRelationsOmitted: 0,
    exportedAt: now,
  });
  assert.equal((await validateProjectBackup(backup)).tables.projects[0]?.task_sequence, 2);
});

test("the comment-aware project schema rejects an older bundle explicitly", async () => {
  const backup = await createProjectBackup({
    siteOrigin: "https://task-manager.example",
    tables: validProjectTables(),
    sharing: [],
    externalRelationsOmitted: 0,
    exportedAt: now,
  });
  await assert.rejects(
    validateProjectBackup({ ...backup, schemaVersion: 1 }),
    /unsupported task manager project backup format or version/i,
  );
});

test("schema 2 project bundles without attachments remain importable", async () => {
  const current = await createProjectBackup({
    siteOrigin: "https://task-manager.example",
    tables: validProjectTables(),
    sharing: [],
    externalRelationsOmitted: 0,
    exportedAt: now,
  });
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
    siteOrigin: current.siteOrigin,
    exportedAt: current.exportedAt,
    projectId: current.projectId,
    projectPublicId: current.projectPublicId,
    projectName: current.projectName,
    ownerUserId: current.ownerUserId,
    counts,
    warnings: current.warnings,
    tables,
    sharing: current.sharing,
  };
  const legacy = { ...body, sha256: await checksum(JSON.stringify(body)) };

  const validated = await validateProjectBackup(legacy);
  assert.equal(validated.schemaVersion, 2);
  assert.deepEqual(validated.tables.attachments, []);
});

test("schema 3 project bundles upgrade workflow metadata without changing their checksum body", async () => {
  const current = await createProjectBackup({
    siteOrigin: "https://task-manager.example",
    tables: validProjectTables(),
    sharing: [],
    externalRelationsOmitted: 0,
    exportedAt: now,
  });
  const tables = {
    ...Object.fromEntries(Object.entries(current.tables).filter(([name]) => name !== "task_identifier_aliases")),
    projects: current.tables.projects.map(legacyProjectRow),
    workflow_statuses: current.tables.workflow_statuses.map(legacyWorkflowRow),
    task_relations: current.tables.task_relations.map(legacyRelationRow),
  };
  const body = {
    ...current,
    schemaVersion: 3,
    counts: Object.fromEntries(Object.entries(current.counts).filter(([name]) => name !== "task_identifier_aliases")),
    tables,
  };
  const unsigned = Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== "sha256"),
  );
  const legacy = { ...unsigned, sha256: await checksum(JSON.stringify(unsigned)) };

  const validated = await validateProjectBackup(legacy);
  assert.equal(validated.schemaVersion, 3);
  assert.equal(validated.tables.workflow_statuses[0]?.version, 1);
  assert.equal(validated.tables.workflow_statuses[0]?.archived_at, null);
});

test("schema 4 project bundles upgrade legacy relation identity and concurrency metadata", async () => {
  const current = await createProjectBackup({
    siteOrigin: "https://task-manager.example",
    tables: validProjectTables(),
    sharing: [],
    externalRelationsOmitted: 0,
    exportedAt: now,
  });
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

  const validated = await validateProjectBackup(legacy);
  assert.equal(validated.schemaVersion, 4);
  assert.equal(validated.tables.task_relations[0]?.id, "relation_legacy:task-1:task-2:blocks");
  assert.equal(validated.tables.task_relations[0]?.version, 1);
  assert.equal(validated.tables.task_relations[0]?.updated_at, now);
});

test("project bundle rejects tampering after checksum", async () => {
  const backup = await createProjectBackup({
    siteOrigin: "https://task-manager.example",
    tables: validProjectTables(),
    sharing: [],
    externalRelationsOmitted: 0,
    exportedAt: now,
  });
  backup.tables.tasks[0]!.title = "Tampered";
  await assert.rejects(validateProjectBackup(backup), /checksum/i);
});

test("project bundle rejects hierarchy and relations outside the subtree", async () => {
  const tables = validProjectTables();
  tables.tasks[0]!.parent_task_id = "task-outside";
  await assert.rejects(
    createProjectBackup({
      siteOrigin: "https://task-manager.example",
      tables,
      sharing: [],
      externalRelationsOmitted: 0,
      exportedAt: now,
    }),
    /parent is outside/i,
  );
});

test("project bundle rejects invalid native comment state before staging", async () => {
  const tables = validProjectTables();
  tables.comments[0]!.source = "linear";
  await assert.rejects(
    createProjectBackup({
      siteOrigin: "https://task-manager.example",
      tables,
      sharing: [],
      externalRelationsOmitted: 0,
      exportedAt: now,
    }),
    /non-native comment/i,
  );
});

test("staged project replace rolls back when one inserted row is invalid", () => {
  const database = migratedDatabase();
  database.prepare(`INSERT INTO projects
    (id, public_id, owner_user_id, creator_user_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("project-1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "user-owner", "user-owner", "Old project", now, now);
  const tables = validProjectTables();
  tables.projects[0]!.name = null;
  stageProjectRows(database, "user-import:test", tables);

  assert.throws(() => applyProjectRows(database, "user-import:test"), /NOT NULL constraint failed/i);
  assert.equal(database.prepare("SELECT name FROM projects WHERE id = 'project-1'").get()!.name, "Old project");
  database.close();
});

function validProjectTables(): ProjectBackupTables {
  return {
    workflow_statuses: [{
      id: "status-todo", owner_user_id: "user-owner", name: "Todo",
      category: "unstarted", color: "#94a3b8", position: 0, is_default: 1,
      system_role: null, archived_at: null, version: 1,
      created_at: now, updated_at: now,
    }],
    projects: [{
      id: "project-1", public_id: "11111111-1111-4111-8111-111111111111",
      owner_user_id: "user-owner", creator_user_id: "user-owner", name: "Project",
      task_code: "TM", task_sequence: 2, code_locked_at: now,
      summary: "", description: "", status: "active", lead_user_id: null,
      start_date: null, target_date: null, icon: "cube", color: "#8b7cf6",
      archived_at: null, version: 1, created_at: now, updated_at: now,
    }],
    releases: [{
      id: "release-1", public_id: "22222222-2222-4222-8222-222222222222",
      project_id: "project-1", owner_user_id: "user-owner", creator_user_id: "user-owner",
      name: "UAT", description: "", status: "active", target_date: null,
      released_at: null, release_notes: "", version: 1, created_at: now, updated_at: now,
    }],
    tasks: [
      {
        id: "task-1", public_id: "33333333-3333-4333-8333-333333333333",
        owner_user_id: "user-owner", creator_user_id: "user-owner", identifier: "TM-1",
        sequence_number: 1, title: "Parent", description: "", status_id: "status-todo",
        priority: "none", assignee_user_id: null, project_id: "project-1",
        release_id: "release-1", estimate: null, due_date: null, parent_task_id: null,
        rank: 1000, started_at: null, completed_at: null, canceled_at: null,
        archived_at: null, comment_count: 1, version: 1, created_at: now, updated_at: now,
      },
      {
        id: "task-2", public_id: "44444444-4444-4444-8444-444444444444",
        owner_user_id: "user-owner", creator_user_id: "user-owner", identifier: "TM-2",
        sequence_number: 2, title: "Child", description: "", status_id: "status-todo",
        priority: "high", assignee_user_id: null, project_id: "project-1",
        release_id: null, estimate: 3, due_date: null, parent_task_id: "task-1",
        rank: 2000, started_at: null, completed_at: null, canceled_at: null,
        archived_at: null, comment_count: 0, version: 1, created_at: now, updated_at: now,
      },
    ],
    task_identifier_aliases: [],
    attachments: [],
    comments: [{
      id: "comment-1", task_id: "task-1", author_user_id: "user-owner",
      body: "Native project comment", source: "native", parent_comment_id: null,
      idempotency_key: "backup-comment-1", created_at: now, updated_at: now,
      deleted_at: null, resolved_at: null, resolved_by_user_id: null,
      resolution_comment_id: null, version: 1,
    }],
    comment_reactions: [{ comment_id: "comment-1", user_id: "user-owner", emoji: "👍", created_at: now }],
    labels: [{ id: "label-1", owner_user_id: "user-owner", name: "Backup", color: "#6b7280", created_at: now }],
    task_labels: [{ task_id: "task-2", label_id: "label-1" }],
    task_relations: [{
      id: "relation-1", source_task_id: "task-1", target_task_id: "task-2",
      type: "blocks", creator_user_id: "user-owner", idempotency_key: "backup-relation-1",
      version: 1, created_at: now, updated_at: now,
    }],
    saved_views: [{
      id: "view-1", public_id: "55555555-5555-4555-8555-555555555555",
      owner_user_id: "user-owner", name: "Project view", scope_project_id: "project-1",
      query_json: "{}", display_json: "{}", version: 1, created_at: now, updated_at: now,
    }],
    external_records: [{
      id: "external-1", owner_user_id: "user-owner", target_type: "task",
      target_id: "task-1", source: "linear", source_id: "linear-uuid",
      source_url: "https://linear.app/example", metadata_json: "{}", imported_at: now,
    }],
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
    "0000_chilly_malice.sql", "0001_wide_skreet.sql", "0002_stiff_madame_hydra.sql",
    "0003_green_white_queen.sql", "0004_large_rocket_racer.sql", "0005_mixed_bruce_banner.sql",
    "0006_complex_reavers.sql", "0007_curious_sharon_carter.sql",
    "0008_loose_the_fallen.sql", "0009_talented_otto_octavius.sql",
    "0010_crazy_puma.sql", "0011_conscious_paibok.sql", "0012_empty_saracen.sql",
    "0013_rapid_gravity.sql", "0014_puzzling_tana_nile.sql", "0015_attachments_sync.sql",
    "0016_abandoned_stellaris.sql", "0017_complex_epoch.sql",
    "0018_tearful_black_panther.sql",
  ]) database.exec(readFileSync(join(process.cwd(), "drizzle", migration), "utf8"));
  return database;
}

function stageProjectRows(database: DatabaseSync, importId: string, tables: ProjectBackupTables) {
  const insert = database.prepare("INSERT INTO user_import_rows (import_id, row_type, ordinal, row_json) VALUES (?, ?, ?, ?)");
  for (const table of projectBackupTableDefinitions) {
    tables[table.name].forEach((row, ordinal) => insert.run(importId, table.name, ordinal, JSON.stringify(row)));
  }
}

function applyProjectRows(database: DatabaseSync, importId: string) {
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM projects WHERE id = ?").run("project-1");
    for (const table of projectBackupTableDefinitions) {
      const sql = table.name === "workflow_statuses" || table.name === "labels"
        ? projectRestoreInsertSql(table, true)
        : projectRestoreInsertSql(table);
      database.prepare(sql).run(importId, table.name);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
