import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createProjectBackup,
  projectBackupRestoreTableDefinitions,
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
  assert.equal(backup.schemaVersion, 13);
  const validated = await validateProjectBackup(backup);
  assert.equal(validated.projectId, "project-1");
  assert.equal(validated.counts.tasks, 2);
  assert.equal(validated.counts.sharing, 1);
  assert.equal(validated.warnings.externalRelationsOmitted, 1);
  assert.equal("users" in validated.tables, false);
});

test("project backup validates and restores an expanded Project code", async () => {
  const tables = validProjectTables();
  tables.projects[0]!.task_code = "WEB-APP2";
  for (const task of tables.tasks) {
    task.identifier = `WEB-APP2-${String(task.sequence_number)}`;
  }
  const backup = await createProjectBackup({
    siteOrigin: "https://task-manager.example",
    tables,
    sharing: [],
    externalRelationsOmitted: 0,
    exportedAt: now,
  });
  const validated = await validateProjectBackup(backup);
  assert.equal(validated.tables.projects[0]?.task_code, "WEB-APP2");

  const database = migratedDatabase();
  database.prepare(
    "INSERT INTO users (id, display_name, email, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("user-owner", "Owner", "owner@example.test", "UTC", now, now);
  database.prepare(`INSERT INTO projects
    (id, public_id, owner_user_id, creator_user_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    "project-1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "user-owner",
    "user-owner", "Old project", now, now,
  );
  stageProjectRows(database, "user-import:expanded-code", validated.tables);
  applyProjectRows(database, "user-import:expanded-code");
  assert.equal(
    database.prepare("SELECT task_code FROM projects WHERE id = 'project-1'").get()?.task_code,
    "WEB-APP2",
  );
  assert.deepEqual(
    database.prepare("SELECT identifier FROM tasks ORDER BY sequence_number").all().map((row) => row.identifier),
    ["WEB-APP2-1", "WEB-APP2-2"],
  );
  database.close();
});

test("project bundles preserve historical comments, activity, and reconciliation outcomes", async () => {
  const tables = validProjectTables();
  tables.tasks[0]!.comment_count = 2;
  tables.comments.push({
    id: "comment-history-1", task_id: "task-1", author_user_id: null,
    body: "Imported decision", source: "linear", source_record_id: "external-1",
    source_comment_id: "linear-comment-1", source_parent_comment_id: null,
    historical_author_name: "Former teammate", historical_created_at: now,
    historical_updated_at: now, historical_quoted_text: "Original context",
    parent_comment_id: null, idempotency_key: "linear:linear-comment-1",
    created_at: now, updated_at: now, deleted_at: null, resolved_at: null,
    resolved_by_user_id: null, resolution_comment_id: null, version: 1,
  });
  tables.comment_migration_outcomes.push({
    id: "outcome-1", task_id: "task-1", source: "linear",
    source_record_id: "external-1", source_comment_id: "linear-comment-1",
    source_index: 0, outcome: "migrated", reason: null,
    comment_id: "comment-history-1", raw_json: '{"id":"linear-comment-1"}',
    reconciled_at: now,
  });
  tables.activity_events.push({
    id: "activity-history-1", task_id: "task-1", schema_version: 1,
    event_type: "status_changed", actor_kind: "historical", actor_user_id: null,
    actor_name: "Former teammate",
    payload_json: '{"changes":{"status":{"before":"Todo","after":"Done"}}}',
    source: "linear", source_record_id: "external-1",
    source_event_id: "linear-state-1", source_index: 0, created_at: now,
  });
  tables.activity_migration_outcomes.push({
    id: "activity-outcome-1", task_id: "task-1", source: "linear",
    source_record_id: "external-1", source_event_id: "linear-state-1",
    source_index: 0, outcome: "migrated", reason: null,
    activity_event_id: "activity-history-1", raw_json: '{"id":"linear-state-1"}',
    reconciled_at: now,
  });
  tables.attachment_migration_outcomes.push({
    id: "attachment-outcome-1", task_id: "task-1", source: "linear",
    source_record_id: "external-1", source_attachment_id: "linear-attachment-1",
    source_index: 0, outcome: "blocked", reason: "source_unavailable:404",
    attachment_id: null, mapped_title: null, mapped_url: null,
    raw_json: '{"id":"linear-attachment-1"}', reconciled_at: now,
  });
  const backup = await createProjectBackup({
    siteOrigin: "https://task-manager.example", tables, sharing: [],
    externalRelationsOmitted: 0, exportedAt: now,
  });
  const validated = await validateProjectBackup(backup);
  assert.equal(validated.tables.comments[1]?.author_user_id, null);
  assert.equal(validated.tables.comments[1]?.historical_quoted_text, "Original context");
  assert.equal(validated.tables.comment_migration_outcomes[0]?.outcome, "migrated");
  assert.equal(validated.tables.activity_events[0]?.actor_kind, "historical");
  assert.equal(validated.tables.activity_migration_outcomes[0]?.outcome, "migrated");
  assert.equal(validated.tables.attachment_migration_outcomes[0]?.outcome, "blocked");
});

test("a Project keeps its locked sequence after every current Task is gone", async () => {
  const tables = validProjectTables();
  tables.tasks = [];
  tables.task_identifier_aliases = [];
  tables.attachments = [];
  tables.attachment_migration_outcomes = [];
  tables.comments = [];
  tables.comment_migration_outcomes = [];
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
    Object.entries(current.tables).filter(([name]) => !["attachments", "attachment_migration_outcomes", "task_identifier_aliases", "comment_attachment_refs", "comment_migration_outcomes", "activity_events", "activity_migration_outcomes"].includes(name)),
  );
  tables.comments = current.tables.comments.map(legacyCommentRow);
  tables.projects = current.tables.projects.map(legacyProjectRow);
  tables.workflow_statuses = current.tables.workflow_statuses.map(legacyWorkflowRow);
  tables.task_relations = current.tables.task_relations.map(legacyRelationRow);
  tables.labels = current.tables.labels.map(legacyLabelRow);
  const counts = Object.fromEntries(
    Object.entries(current.counts).filter(([name]) => !["attachments", "attachment_migration_outcomes", "task_identifier_aliases", "comment_attachment_refs", "comment_migration_outcomes", "activity_events", "activity_migration_outcomes"].includes(name)),
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
  assert.equal(validated.tables.projects[0]?.task_code, "PRO");
  assert.deepEqual(
    validated.tables.tasks.map((task) => task.identifier),
    ["PRO-1", "PRO-2"],
  );
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
    ...Object.fromEntries(Object.entries(current.tables).filter(([name]) => !["attachment_migration_outcomes", "task_identifier_aliases", "comment_attachment_refs", "comment_migration_outcomes", "activity_events", "activity_migration_outcomes"].includes(name))),
    projects: current.tables.projects.map(legacyProjectRow),
    workflow_statuses: current.tables.workflow_statuses.map(legacyWorkflowRow),
    task_relations: current.tables.task_relations.map(legacyRelationRow),
    labels: current.tables.labels.map(legacyLabelRow),
    comments: current.tables.comments.map(legacyCommentRow),
  };
  const body = {
    ...current,
    schemaVersion: 3,
    counts: Object.fromEntries(Object.entries(current.counts).filter(([name]) => !["attachment_migration_outcomes", "task_identifier_aliases", "comment_attachment_refs", "comment_migration_outcomes", "activity_events", "activity_migration_outcomes"].includes(name))),
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
    ...Object.fromEntries(Object.entries(current.tables).filter(([name]) => !["attachment_migration_outcomes", "task_identifier_aliases", "comment_attachment_refs", "comment_migration_outcomes", "activity_events", "activity_migration_outcomes"].includes(name))),
    projects: current.tables.projects.map(legacyProjectRow),
    task_relations: current.tables.task_relations.map(legacyRelationRow),
    labels: current.tables.labels.map(legacyLabelRow),
    comments: current.tables.comments.map(legacyCommentRow),
  };
  const unsigned = {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => key !== "sha256")),
    schemaVersion: 4,
    counts: Object.fromEntries(Object.entries(current.counts).filter(([name]) => !["attachment_migration_outcomes", "task_identifier_aliases", "comment_attachment_refs", "comment_migration_outcomes", "activity_events", "activity_migration_outcomes"].includes(name))),
    tables,
  };
  const legacy = { ...unsigned, sha256: await checksum(JSON.stringify(unsigned)) };

  const validated = await validateProjectBackup(legacy);
  assert.equal(validated.schemaVersion, 4);
  assert.equal(validated.tables.task_relations[0]?.id, "relation_legacy:task-1:task-2:blocks");
  assert.equal(validated.tables.task_relations[0]?.version, 1);
  assert.equal(validated.tables.task_relations[0]?.updated_at, now);
});

test("schema 6 project bundles upgrade Label catalog metadata and keep assignments", async () => {
  const current = await createProjectBackup({
    siteOrigin: "https://task-manager.example",
    tables: validProjectTables(),
    sharing: [],
    externalRelationsOmitted: 0,
    exportedAt: now,
  });
  const unsigned = {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => key !== "sha256")),
    schemaVersion: 6,
    tables: {
      ...Object.fromEntries(Object.entries(current.tables).filter(([name]) => !["attachment_migration_outcomes", "comment_attachment_refs", "comment_migration_outcomes", "activity_events", "activity_migration_outcomes"].includes(name))),
      labels: current.tables.labels.map(legacyLabelRow),
      comments: current.tables.comments.map(legacyCommentRow),
    },
    counts: Object.fromEntries(Object.entries(current.counts).filter(([name]) => !["attachment_migration_outcomes", "comment_attachment_refs", "comment_migration_outcomes", "activity_events", "activity_migration_outcomes"].includes(name))),
  };
  const legacy = { ...unsigned, sha256: await checksum(JSON.stringify(unsigned)) };

  const validated = await validateProjectBackup(legacy);
  assert.equal(validated.schemaVersion, 6);
  assert.equal(validated.tables.labels[0]?.description, "");
  assert.equal(validated.tables.labels[0]?.archived_at, null);
  assert.equal(validated.tables.labels[0]?.version, 1);
  assert.equal(validated.tables.labels[0]?.updated_at, now);
  assert.deepEqual(validated.tables.task_labels, current.tables.task_labels);
});

test("schema 10 project bundles remain importable with empty attachment migration outcomes", async () => {
  const current = await createProjectBackup({
    siteOrigin: "https://task-manager.example",
    tables: validProjectTables(),
    sharing: [],
    externalRelationsOmitted: 0,
    exportedAt: now,
  });
  const tables = Object.fromEntries(
    Object.entries(current.tables).filter(([name]) => !["attachment_migration_outcomes", "comment_attachment_refs"].includes(name)),
  );
  const counts = Object.fromEntries(
    Object.entries(current.counts).filter(([name]) => !["attachment_migration_outcomes", "comment_attachment_refs"].includes(name)),
  );
  const body = {
    format: current.format,
    version: current.version,
    schemaVersion: 10,
    siteOrigin: current.siteOrigin,
    exportedAt: current.exportedAt,
    projectId: current.projectId,
    projectPublicId: current.projectPublicId,
    projectName: current.projectName,
    ownerUserId: current.ownerUserId,
    counts,
    warnings: current.warnings,
    tables,
    objects: current.objects,
    sharing: current.sharing,
  };
  const legacy = { ...body, sha256: await checksum(JSON.stringify(body)) };
  const validated = await validateProjectBackup(legacy);
  assert.equal(validated.schemaVersion, 10);
  assert.deepEqual(validated.tables.attachment_migration_outcomes, []);
  assert.deepEqual(validated.tables.activity_events, current.tables.activity_events);
});

test("schema 12 project bundles remain importable with an empty comment attachment index", async () => {
  const current = await createProjectBackup({
    siteOrigin: "https://task-manager.example",
    tables: validProjectTables(),
    sharing: [],
    externalRelationsOmitted: 0,
    exportedAt: now,
  });
  const tables = Object.fromEntries(
    Object.entries(current.tables).filter(([name]) => name !== "comment_attachment_refs"),
  );
  const counts = Object.fromEntries(
    Object.entries(current.counts).filter(([name]) => name !== "comment_attachment_refs"),
  );
  const body = {
    format: current.format,
    version: current.version,
    schemaVersion: 12,
    siteOrigin: current.siteOrigin,
    exportedAt: current.exportedAt,
    projectId: current.projectId,
    projectPublicId: current.projectPublicId,
    projectName: current.projectName,
    ownerUserId: current.ownerUserId,
    counts,
    warnings: current.warnings,
    tables,
    objects: current.objects,
    sharing: current.sharing,
  };
  const validated = await validateProjectBackup({
    ...body,
    sha256: await checksum(JSON.stringify(body)),
  });
  assert.equal(validated.schemaVersion, 12);
  assert.deepEqual(validated.tables.comment_attachment_refs, []);
});

test("schema 13 project bundles require the comment attachment index", async () => {
  const current = await createProjectBackup({
    siteOrigin: "https://task-manager.example",
    tables: validProjectTables(),
    sharing: [],
    externalRelationsOmitted: 0,
    exportedAt: now,
  });
  const tables = Object.fromEntries(
    Object.entries(current.tables).filter(([name]) => name !== "comment_attachment_refs"),
  );
  const counts = Object.fromEntries(
    Object.entries(current.counts).filter(([name]) => name !== "comment_attachment_refs"),
  );
  const body = { ...current, tables, counts };
  delete (body as Partial<typeof current>).sha256;
  await assert.rejects(
    validateProjectBackup({
      ...body,
      sha256: await checksum(JSON.stringify(body)),
    }),
    /comment_attachment_refs/i,
  );
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

test("project bundle rejects historical comment impersonation before staging", async () => {
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
    /cannot impersonate/i,
  );
});

test("staged project restore inserts provenance before historical activity outcomes", () => {
  const database = migratedDatabase();
  database.prepare(
    "INSERT INTO users (id, display_name, email, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("user-owner", "Owner", "owner@example.test", "UTC", now, now);
  database.prepare(`INSERT INTO projects
    (id, public_id, owner_user_id, creator_user_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("project-1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "user-owner", "user-owner", "Old project", now, now);
  const tables = validProjectTables();
  addHistoricalActivity(tables);
  stageProjectRows(database, "user-import:activity", tables);

  applyProjectRows(database, "user-import:activity");

  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM activity_events").get()!.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM activity_migration_outcomes").get()!.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM attachment_migration_outcomes").get()!.count, 1);
  database.close();
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
    attachment_migration_outcomes: [],
    comments: [{
      id: "comment-1", task_id: "task-1", author_user_id: "user-owner",
      body: "Native project comment", source: "native", source_record_id: null,
      source_comment_id: null, source_parent_comment_id: null,
      historical_author_name: null, historical_created_at: null,
      historical_updated_at: null, historical_quoted_text: null, parent_comment_id: null,
      idempotency_key: "backup-comment-1", created_at: now, updated_at: now,
      deleted_at: null, resolved_at: null, resolved_by_user_id: null,
      resolution_comment_id: null, version: 1,
    }],
    comment_attachment_refs: [],
    comment_migration_outcomes: [],
    activity_events: [],
    activity_migration_outcomes: [],
    comment_reactions: [{ comment_id: "comment-1", user_id: "user-owner", emoji: "👍", created_at: now }],
    label_groups: [],
    labels: [{ id: "label-1", owner_user_id: "user-owner", group_id: null, name: "Backup", color: "#6b7280", description: "Keep for restore", archived_at: null, version: 1, created_at: now, updated_at: now }],
    task_labels: [{ task_id: "task-2", label_id: "label-1" }],
    task_relations: [{
      id: "relation-1", source_task_id: "task-1", target_task_id: "task-2",
      type: "blocks", creator_user_id: "user-owner", idempotency_key: "backup-relation-1",
      version: 1, created_at: now, updated_at: now,
    }],
    saved_views: [{
      id: "view-1", public_id: "55555555-5555-4555-8555-555555555555",
      owner_user_id: "user-owner", name: "Project view", scope_project_id: "project-1",
      query_json: "{}", display_json: "{}", archived_at: null, version: 1, created_at: now, updated_at: now,
    }],
    external_records: [{
      id: "external-1", owner_user_id: "user-owner", target_type: "task",
      target_id: "task-1", source: "linear", source_id: "linear-uuid",
      source_url: "https://linear.app/example", metadata_json: "{}", imported_at: now,
    }],
  };
}

function addHistoricalActivity(tables: ProjectBackupTables) {
  tables.activity_events.push({
    id: "activity-history-restore", task_id: "task-1", schema_version: 1,
    event_type: "status_changed", actor_kind: "historical", actor_user_id: null,
    actor_name: "Former teammate", payload_json: '{"changes":{"status":{"before":"Todo","after":"Done"}}}',
    source: "linear", source_record_id: "external-1", source_event_id: "linear-state-restore",
    source_index: 0, created_at: now,
  });
  tables.activity_migration_outcomes.push({
    id: "activity-outcome-restore", task_id: "task-1", source: "linear",
    source_record_id: "external-1", source_event_id: "linear-state-restore", source_index: 0,
    outcome: "migrated", reason: null, activity_event_id: "activity-history-restore",
    raw_json: '{"id":"linear-state-restore"}', reconciled_at: now,
  });
  tables.attachment_migration_outcomes.push({
    id: "attachment-outcome-restore", task_id: "task-1", source: "linear",
    source_record_id: "external-1", source_attachment_id: "linear-attachment-restore",
    source_index: 0, outcome: "blocked", reason: "source_unavailable:404",
    attachment_id: null, mapped_title: null, mapped_url: null,
    raw_json: '{"id":"linear-attachment-restore"}', reconciled_at: now,
  });
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

function legacyLabelRow(row: Record<string, string | number | null>) {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) =>
      !["group_id", "description", "archived_at", "version", "updated_at"].includes(key),
    ),
  );
}

function legacyCommentRow(row: Record<string, string | number | null>) {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => ![
      "source_record_id", "source_comment_id", "source_parent_comment_id",
      "historical_author_name", "historical_created_at",
      "historical_updated_at", "historical_quoted_text",
    ].includes(key)),
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
    "0018_tearful_black_panther.sql", "0019_silky_drax.sql", "0020_giant_boom_boom.sql",
    "0021_freezing_preak.sql", "0022_cheerful_sue_storm.sql",
    "0023_tan_millenium_guard.sql",
    "0024_workable_zeigeist.sql",
    "0025_revoke_scoped_view_grants.sql",
    "0026_repair_legacy_workflow_catalogs.sql",
    "0027_busy_silver_sable.sql",
    "0028_hot_obadiah_stane.sql",
    "0029_steep_joseph.sql",
    "0032_expand_project_task_codes.sql",
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
    for (const table of projectBackupRestoreTableDefinitions) {
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
