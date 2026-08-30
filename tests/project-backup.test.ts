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
  type ProjectExternalTaskRelationDescriptor,
  type ProjectBackupTables,
} from "../lib/project-backup-format";
import {
  projectRestorePurgeJobCleanupParameters,
  projectRestorePurgeJobCleanupSql,
} from "../lib/system-backup-contract";
import {
  projectExternalRelationRestoreGuardParameters,
  projectExternalRelationRestoreGuardSql,
  projectInternalRelationDeleteParameters,
  projectInternalRelationDeleteSql,
} from "../lib/project-backup";

const now = "2026-08-14T12:00:00.000Z";

test("project bundle validates one exact subtree without user identities", async () => {
  const externalTaskRelations: ProjectExternalTaskRelationDescriptor[] = [{
    relation: {
      id: "relation-external-1",
      sourceTaskId: "task-1",
      targetTaskId: "peer-task-1",
      type: "blocks",
      creatorUserId: "user-owner",
      idempotencyKey: "backup-external-relation-1",
      version: 2,
      createdAt: now,
      updatedAt: now,
    },
    internalTaskId: "task-1",
    internalEndpoint: "source",
    restorePolicy: "not_restored",
  }];
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
    externalTaskRelations,
    exportedAt: now,
  });
  assert.equal(backup.schemaVersion, 15);
  const validated = await validateProjectBackup(backup);
  assert.equal(validated.projectId, "project-1");
  assert.equal(validated.counts.tasks, 2);
  assert.equal(validated.counts.sharing, 1);
  assert.equal(validated.warnings.externalRelationsOmitted, 1);
  assert.deepEqual(validated.externalTaskRelations, externalTaskRelations);
  assert.equal("users" in validated.tables, false);
});

test("project backup external relation provenance is checksum-protected and never embeds the peer Task", async () => {
  const backup = await createProjectBackup({
    siteOrigin: "https://task-manager.example",
    tables: validProjectTables(),
    sharing: [],
    externalRelationsOmitted: 1,
    externalTaskRelations: [{
      relation: {
        id: "relation-external-related",
        sourceTaskId: "peer-task-2",
        targetTaskId: "task-2",
        type: "related",
        creatorUserId: "user-editor",
        idempotencyKey: "backup-external-related",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      internalTaskId: "task-2",
      internalEndpoint: "target",
      restorePolicy: "not_restored",
    }],
    exportedAt: now,
  });

  assert.deepEqual(backup.tables.tasks.map((task) => task.id), ["task-1", "task-2"]);
  await assert.rejects(
    validateProjectBackup({
      ...backup,
      externalTaskRelations: backup.externalTaskRelations.map((descriptor) => ({
        ...descriptor,
        restorePolicy: "restore" as "not_restored",
      })),
    }),
    /restore policy|checksum/i,
  );
  await assert.rejects(
    createProjectBackup({
      siteOrigin: "https://task-manager.example",
      tables: validProjectTables(),
      sharing: [],
      externalRelationsOmitted: 0,
      externalTaskRelations: [{
        ...backup.externalTaskRelations[0]!,
        relation: {
          ...backup.externalTaskRelations[0]!.relation,
          sourceTaskId: "task-1",
          targetTaskId: "task-2",
        },
      }],
      exportedAt: now,
    }),
    /exactly one endpoint|bundle boundary/i,
  );
  await assert.rejects(
    createProjectBackup({
      siteOrigin: "https://task-manager.example",
      tables: validProjectTables(),
      sharing: [],
      externalRelationsOmitted: 0,
      externalTaskRelations: backup.externalTaskRelations,
      exportedAt: now,
    }),
    /omitted count.*descriptor count/i,
  );
});

test("project restore clears live and incoming subtree purge jobs but preserves unrelated jobs", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE releases (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE saved_views (id TEXT PRIMARY KEY, scope_project_id TEXT);
    CREATE TABLE user_import_rows (
      import_id TEXT NOT NULL,
      row_type TEXT NOT NULL,
      row_json TEXT NOT NULL
    );
    CREATE TABLE entity_purge_jobs (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      PRIMARY KEY (entity_type, entity_id)
    );
    INSERT INTO projects (id) VALUES ('project-1'), ('project-other');
    INSERT INTO releases (id, project_id) VALUES
      ('release-live', 'project-1'), ('release-other', 'project-other');
    INSERT INTO tasks (id, project_id) VALUES
      ('task-live', 'project-1'), ('task-other', 'project-other');
    INSERT INTO saved_views (id, scope_project_id) VALUES
      ('view-live', 'project-1'), ('view-other', 'project-other');
  `);
  const importId = "user-import:purge-cleanup";
  const insertIncoming = database.prepare(
    "INSERT INTO user_import_rows (import_id, row_type, row_json) VALUES (?, ?, ?)",
  );
  for (const [rowType, id] of [
    ["projects", "project-1"],
    ["releases", "release-incoming"],
    ["tasks", "task-incoming"],
    ["saved_views", "view-incoming"],
  ]) {
    insertIncoming.run(importId, rowType, JSON.stringify({ id }));
  }
  const insertJob = database.prepare(
    "INSERT INTO entity_purge_jobs (entity_type, entity_id) VALUES (?, ?)",
  );
  for (const [entityType, entityId] of [
    ["project", "project-1"],
    ["release", "release-live"],
    ["release", "release-incoming"],
    ["task", "task-live"],
    ["task", "task-incoming"],
    ["saved_view", "view-live"],
    ["saved_view", "view-incoming"],
    ["project", "project-other"],
    ["release", "release-other"],
    ["task", "task-other"],
    ["saved_view", "view-other"],
  ]) {
    insertJob.run(entityType, entityId);
  }

  database.prepare(projectRestorePurgeJobCleanupSql).run(
    ...projectRestorePurgeJobCleanupParameters("project-1", importId),
  );

  assert.deepEqual(
    database.prepare(
      "SELECT entity_type, entity_id FROM entity_purge_jobs ORDER BY entity_type, entity_id",
    ).all().map((row) => ({ ...row })),
    [
      { entity_type: "project", entity_id: "project-other" },
      { entity_type: "release", entity_id: "release-other" },
      { entity_type: "saved_view", entity_id: "view-other" },
      { entity_type: "task", entity_id: "task-other" },
    ],
  );
  database.close();
});

test("project restore preserves safe live external relations and atomically rejects a dangling cutover", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      deleted_at TEXT
    );
    CREATE TABLE task_relations (
      id TEXT PRIMARY KEY,
      source_task_id TEXT NOT NULL,
      target_task_id TEXT NOT NULL,
      type TEXT NOT NULL
    );
    CREATE TABLE user_import_rows (
      import_id TEXT NOT NULL,
      row_type TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      row_json TEXT NOT NULL,
      PRIMARY KEY (import_id, row_type, ordinal)
    );
    INSERT INTO projects (id) VALUES ('project-1'), ('project-peer');
    INSERT INTO tasks (id, project_id, deleted_at) VALUES
      ('task-local', 'project-1', NULL),
      ('task-local-2', 'project-1', NULL),
      ('task-peer', 'project-peer', NULL);
    INSERT INTO task_relations (id, source_task_id, target_task_id, type) VALUES
      ('relation-external', 'task-local', 'task-peer', 'blocks'),
      ('relation-internal', 'task-local', 'task-local-2', 'related');
    INSERT INTO user_import_rows (import_id, row_type, ordinal, row_json) VALUES
      ('user-import:safe', 'tasks', 0, '{"id":"task-local"}'),
      ('user-import:safe', 'tasks', 1, '{"id":"task-local-2"}');
  `);

  database.prepare(projectExternalRelationRestoreGuardSql).run(
    ...projectExternalRelationRestoreGuardParameters("project-1", "user-import:safe"),
  );
  database.prepare(projectInternalRelationDeleteSql).run(
    ...projectInternalRelationDeleteParameters("project-1"),
  );
  assert.deepEqual(
    database.prepare("SELECT id FROM task_relations ORDER BY id").all().map((row) => row.id),
    ["relation-external"],
  );

  database.prepare("UPDATE tasks SET deleted_at = ? WHERE id IN (?, ?)")
    .run(now, "task-local", "task-peer");
  database.prepare(projectExternalRelationRestoreGuardSql).run(
    ...projectExternalRelationRestoreGuardParameters("project-1", "user-import:safe"),
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM task_relations WHERE id = 'relation-external'").get()!.count,
    1,
  );

  database.prepare("DELETE FROM user_import_rows WHERE import_id = ?")
    .run("user-import:safe");
  assert.throws(
    () => database.prepare(projectExternalRelationRestoreGuardSql).run(
      ...projectExternalRelationRestoreGuardParameters("project-1", "user-import:safe"),
    ),
    /NOT NULL constraint failed/i,
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM task_relations WHERE id = 'relation-external'").get()!.count,
    1,
  );
  database.close();
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
  stripDeletionState(tables);
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
  stripDeletionState(tables);
  const body = {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => key !== "externalTaskRelations")),
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
  stripDeletionState(tables);
  const unsigned = {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => key !== "sha256" && key !== "externalTaskRelations")),
    schemaVersion: 4,
    counts: Object.fromEntries(Object.entries(current.counts).filter(([name]) => !["attachment_migration_outcomes", "task_identifier_aliases", "comment_attachment_refs", "comment_migration_outcomes", "activity_events", "activity_migration_outcomes"].includes(name))),
    tables,
  };
  stripDeletionState(unsigned.tables);
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
    ...Object.fromEntries(Object.entries(current).filter(([key]) => key !== "sha256" && key !== "externalTaskRelations")),
    schemaVersion: 6,
    tables: {
      ...Object.fromEntries(Object.entries(current.tables).filter(([name]) => !["attachment_migration_outcomes", "comment_attachment_refs", "comment_migration_outcomes", "activity_events", "activity_migration_outcomes"].includes(name))),
      labels: current.tables.labels.map(legacyLabelRow),
      comments: current.tables.comments.map(legacyCommentRow),
    },
    counts: Object.fromEntries(Object.entries(current.counts).filter(([name]) => !["attachment_migration_outcomes", "comment_attachment_refs", "comment_migration_outcomes", "activity_events", "activity_migration_outcomes"].includes(name))),
  };
  stripDeletionState(unsigned.tables);
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
  stripDeletionState(tables);
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
  stripDeletionState(tables);
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
  stripDeletionState(body.tables);
  delete (body as Partial<typeof current>).sha256;
  await assert.rejects(
    validateProjectBackup({
      ...body,
      sha256: await checksum(JSON.stringify(body)),
    }),
    /comment_attachment_refs/i,
  );
});

test("schema 15 project bundles preserve shadow deletion without reviving deleted children", async () => {
  const tables = validProjectTables();
  const purgeAfter = "2026-09-13T12:00:00.000Z";
  tables.projects[0]!.deleted_at = now;
  tables.projects[0]!.deleted_by_user_id = "user-owner";
  tables.projects[0]!.purge_after = purgeAfter;
  tables.tasks[0]!.deleted_at = now;
  tables.tasks[0]!.deleted_by_user_id = "user-owner";
  tables.tasks[0]!.purge_after = purgeAfter;

  const validated = await validateProjectBackup(await createProjectBackup({
    siteOrigin: "https://task-manager.example",
    tables,
    sharing: [],
    externalRelationsOmitted: 0,
    exportedAt: now,
  }));

  assert.equal(validated.schemaVersion, 15);
  assert.equal(validated.tables.projects[0]?.deleted_at, now);
  assert.equal(validated.tables.tasks[0]?.deleted_at, now);
  assert.equal(validated.tables.tasks[1]?.deleted_at, null);
});

test("schema 15 project bundles reject incomplete or invalid deletion tuples", async () => {
  const incomplete = validProjectTables();
  incomplete.releases[0]!.deleted_at = now;
  await assert.rejects(
    createProjectBackup({
      siteOrigin: "https://task-manager.example", tables: incomplete,
      sharing: [], externalRelationsOmitted: 0, exportedAt: now,
    }),
    /deletion state must be entirely empty or complete/i,
  );

  const invalidCutoff = validProjectTables();
  invalidCutoff.saved_views[0]!.deleted_at = now;
  invalidCutoff.saved_views[0]!.deleted_by_user_id = "user-owner";
  invalidCutoff.saved_views[0]!.purge_after = now;
  await assert.rejects(
    createProjectBackup({
      siteOrigin: "https://task-manager.example", tables: invalidCutoff,
      sharing: [], externalRelationsOmitted: 0, exportedAt: now,
    }),
    /purge_after must be later than deleted_at/i,
  );
});

test("schema 13 project bundles gain empty deletion tuples only after checksum validation", async () => {
  const current = await createProjectBackup({
    siteOrigin: "https://task-manager.example",
    tables: validProjectTables(),
    sharing: [],
    externalRelationsOmitted: 0,
    exportedAt: now,
  });
  const tables = structuredClone(current.tables) as unknown as Record<string, unknown>;
  stripDeletionState(tables);
  const body = {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => key !== "sha256" && key !== "externalTaskRelations")),
    schemaVersion: 13,
    tables,
  };
  const legacy = { ...body, sha256: await checksum(JSON.stringify(body)) };
  const validated = await validateProjectBackup(legacy);

  assert.equal(validated.schemaVersion, 13);
  for (const tableName of ["projects", "releases", "tasks", "saved_views"] as const) {
    for (const row of validated.tables[tableName]) {
      assert.equal(row.deleted_at, null);
      assert.equal(row.deleted_by_user_id, null);
      assert.equal(row.purge_after, null);
    }
  }

  (legacy.tables as Record<string, Array<Record<string, unknown>>>).tasks[0]!.title = "Tampered";
  await assert.rejects(validateProjectBackup(legacy), /checksum/i);
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
      archived_at: null, deleted_at: null, deleted_by_user_id: null,
      purge_after: null, version: 1, created_at: now, updated_at: now,
    }],
    releases: [{
      id: "release-1", public_id: "22222222-2222-4222-8222-222222222222",
      project_id: "project-1", owner_user_id: "user-owner", creator_user_id: "user-owner",
      name: "UAT", description: "", status: "active", target_date: null,
      released_at: null, release_notes: "", deleted_at: null,
      deleted_by_user_id: null, purge_after: null, version: 1,
      created_at: now, updated_at: now,
    }],
    tasks: [
      {
        id: "task-1", public_id: "33333333-3333-4333-8333-333333333333",
        owner_user_id: "user-owner", creator_user_id: "user-owner", identifier: "TM-1",
        sequence_number: 1, title: "Parent", description: "", status_id: "status-todo",
        priority: "none", assignee_user_id: null, project_id: "project-1",
        release_id: "release-1", estimate: null, due_date: null, parent_task_id: null,
        rank: 1000, started_at: null, completed_at: null, canceled_at: null,
        archived_at: null, deleted_at: null, deleted_by_user_id: null,
        purge_after: null, comment_count: 1, version: 1, created_at: now, updated_at: now,
      },
      {
        id: "task-2", public_id: "44444444-4444-4444-8444-444444444444",
        owner_user_id: "user-owner", creator_user_id: "user-owner", identifier: "TM-2",
        sequence_number: 2, title: "Child", description: "", status_id: "status-todo",
        priority: "high", assignee_user_id: null, project_id: "project-1",
        release_id: null, estimate: 3, due_date: null, parent_task_id: "task-1",
        rank: 2000, started_at: null, completed_at: null, canceled_at: null,
        archived_at: null, deleted_at: null, deleted_by_user_id: null,
        purge_after: null, comment_count: 0, version: 1, created_at: now, updated_at: now,
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
      query_json: "{}", display_json: "{}", archived_at: null,
      deleted_at: null, deleted_by_user_id: null, purge_after: null,
      version: 1, created_at: now, updated_at: now,
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

function stripDeletionState(tables: Record<string, unknown>) {
  for (const tableName of ["projects", "releases", "tasks", "saved_views"]) {
    const rows = tables[tableName];
    if (!Array.isArray(rows)) continue;
    tables[tableName] = rows.map((row) => Object.fromEntries(
      Object.entries(row as Record<string, unknown>).filter(
        ([key]) => !["deleted_at", "deleted_by_user_id", "purge_after"].includes(key),
      ),
    ));
  }
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
    "0033_amused_catseye.sql",
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
