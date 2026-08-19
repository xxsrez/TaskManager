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
  restoreTableDefinitions,
  tableDefinitions,
  validateSystemBackup,
  type BackupTables,
} from "../lib/system-backup-format";

const now = "2026-08-14T12:00:00.000Z";

test("a complete system snapshot validates and preserves application data", async () => {
  const backup = await createSystemBackup(validTables(), now);
  assert.equal(backup.schemaVersion, 13);
  const validated = await validateSystemBackup(backup);

  assert.equal(validated.sha256, backup.sha256);
  assert.equal(validated.counts.users, 2);
  assert.equal(validated.counts.tasks, 2);
  assert.equal(validated.tables.tasks[0]?.title, "Ship backup support");
  assert.equal(validated.tables.access_grants[0]?.permission, "full_access");
});

test("system backup preserves Label Group topology and rejects duplicate group values", async () => {
  const tables = validTables();
  tables.label_groups.push({
    id: "group-size", owner_user_id: "user-admin", name: "Size", description: "",
    position: 0, archived_at: null, version: 1, created_at: now, updated_at: now,
  });
  tables.labels[0]!.group_id = "group-size";
  const backup = await createSystemBackup(tables, now);
  const validated = await validateSystemBackup(backup);
  assert.equal(validated.tables.labels[0]?.group_id, "group-size");

  tables.labels.push({
    id: "label-2", owner_user_id: "user-admin", group_id: "group-size", name: "Large",
    color: "#993366", description: "", archived_at: null, version: 1,
    created_at: now, updated_at: now,
  });
  tables.task_labels.push({ task_id: "task-1", label_id: "label-2" });
  const conflicting = await createSystemBackup(tables, now);
  await assert.rejects(validateSystemBackup(conflicting), /at most one Label/i);
});

test("system snapshots preserve historical comments, activity, and reconciliation outcomes", async () => {
  const tables = validTables();
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
  const backup = await createSystemBackup(tables, now);
  const validated = await validateSystemBackup(backup);
  assert.equal(validated.tables.comments[1]?.author_user_id, null);
  assert.equal(validated.tables.comments[1]?.historical_quoted_text, "Original context");
  assert.equal(validated.tables.comment_migration_outcomes[0]?.outcome, "migrated");
  assert.equal(validated.tables.activity_events[0]?.actor_kind, "historical");
  assert.equal(validated.tables.activity_migration_outcomes[0]?.outcome, "migrated");
  assert.equal(validated.tables.attachment_migration_outcomes[0]?.outcome, "blocked");
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
    ...Object.fromEntries(Object.entries(current.tables).filter(([name]) => !["attachment_migration_outcomes", "task_identifier_aliases", "comment_attachment_refs", "comment_migration_outcomes", "activity_events", "activity_migration_outcomes"].includes(name))),
    projects: current.tables.projects.map(legacyProjectRow),
    workflow_statuses: legacyStatuses,
    task_relations: current.tables.task_relations.map(legacyRelationRow),
    labels: current.tables.labels.map(legacyLabelRow),
    comments: current.tables.comments.map(legacyCommentRow),
  };
  const counts = {
    ...Object.fromEntries(Object.entries(current.counts).filter(([name]) => !["attachment_migration_outcomes", "task_identifier_aliases", "comment_attachment_refs", "comment_migration_outcomes", "activity_events", "activity_migration_outcomes"].includes(name))),
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

  const validated = await validateSystemBackup(legacy);
  assert.equal(validated.schemaVersion, 4);
  assert.equal(validated.tables.task_relations[0]?.id, "relation_legacy:task-1:task-2:blocks");
  assert.equal(validated.tables.task_relations[0]?.version, 1);
  assert.equal(validated.tables.task_relations[0]?.updated_at, now);
});

test("schema 6 system backups upgrade Label catalog metadata and keep assignments", async () => {
  const current = await createSystemBackup(validTables(), now);
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

  const validated = await validateSystemBackup(legacy);
  assert.equal(validated.schemaVersion, 6);
  assert.equal(validated.tables.labels[0]?.description, "");
  assert.equal(validated.tables.labels[0]?.archived_at, null);
  assert.equal(validated.tables.labels[0]?.version, 1);
  assert.equal(validated.tables.labels[0]?.updated_at, now);
  assert.deepEqual(validated.tables.task_labels, current.tables.task_labels);
});

test("schema 10 system backups remain importable with empty attachment migration outcomes", async () => {
  const current = await createSystemBackup(validTables(), now);
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
    environmentScope: current.environmentScope,
    exportedAt: current.exportedAt,
    counts,
    tables,
    objects: current.objects,
  };
  const legacy = { ...body, sha256: await checksum(JSON.stringify(body)) };
  const validated = await validateSystemBackup(legacy);
  assert.equal(validated.schemaVersion, 10);
  assert.deepEqual(validated.tables.attachment_migration_outcomes, []);
  assert.deepEqual(validated.tables.activity_events, current.tables.activity_events);
});

test("schema 12 system backups remain importable with an empty comment attachment index", async () => {
  const current = await createSystemBackup(validTables(), now);
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
    environmentScope: current.environmentScope,
    exportedAt: current.exportedAt,
    counts,
    tables,
    objects: current.objects,
  };
  const validated = await validateSystemBackup({
    ...body,
    sha256: await checksum(JSON.stringify(body)),
  });
  assert.equal(validated.schemaVersion, 12);
  assert.deepEqual(validated.tables.comment_attachment_refs, []);
});

test("schema 13 system backups require the comment attachment index", async () => {
  const current = await createSystemBackup(validTables(), now);
  const tables = Object.fromEntries(
    Object.entries(current.tables).filter(([name]) => name !== "comment_attachment_refs"),
  );
  const counts = Object.fromEntries(
    Object.entries(current.counts).filter(([name]) => name !== "comment_attachment_refs"),
  );
  const body = { ...current, tables, counts };
  delete (body as Partial<typeof current>).sha256;
  await assert.rejects(
    validateSystemBackup({
      ...body,
      sha256: await checksum(JSON.stringify(body)),
    }),
    /comment_attachment_refs/i,
  );
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

test("snapshot validation preserves revoked direct grants after a SavedView becomes project-scoped", async () => {
  const tables = validTables();
  tables.access_grants.push({
    ...tables.access_grants[0]!,
    id: "grant-revoked-view",
    resource_type: "saved_view",
    resource_id: "view-1",
    permission: "editor",
    revoked_at: now,
  });
  const backup = await createSystemBackup(tables, now);

  const validated = await validateSystemBackup(backup);
  assert.equal(validated.tables.access_grants[1]?.revoked_at, now);
});

test("snapshot validation rejects active direct grants on project-scoped SavedViews", async () => {
  const tables = validTables();
  tables.access_grants.push({
    ...tables.access_grants[0]!,
    id: "grant-active-view",
    resource_type: "saved_view",
    resource_id: "view-1",
    permission: "editor",
  });
  const backup = await createSystemBackup(tables, now);

  await assert.rejects(
    validateSystemBackup(backup),
    /Project-scoped views inherit project access/i,
  );
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

test("snapshot validation rejects relations across Projects", async () => {
  const tables = validTables();
  tables.projects.push({
    ...tables.projects[0]!,
    id: "project-2",
    public_id: "66666666-6666-4666-8666-666666666666",
    name: "Other Project",
    task_code: "OP",
    task_sequence: 1,
    lead_user_id: null,
  });
  tables.tasks[1]!.project_id = "project-2";
  tables.tasks[1]!.identifier = "OP-1";
  tables.tasks[1]!.sequence_number = 1;
  const backup = await createSystemBackup(tables, now);

  await assert.rejects(
    validateSystemBackup(backup),
    /same Project/i,
  );
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
  const tables = validTables();
  addHistoricalActivity(tables);
  const importId = stageTables(database, tables);
  assert.equal(database.prepare("SELECT display_name FROM users WHERE id = 'old-user'").get()!.display_name, "Old state");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM tasks").get()!.count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM api_credentials").get()!.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM oauth_grants").get()!.count, 1);

  applyStagedTables(database, importId);

  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users WHERE id = 'old-user'").get()!.count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get()!.count, 2);
  assert.equal(database.prepare("SELECT title FROM tasks WHERE id = 'task-1'").get()!.title, "Ship backup support");
  assert.equal(database.prepare("SELECT permission FROM access_grants WHERE id = 'grant-1'").get()!.permission, "full_access");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM activity_events").get()!.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM activity_migration_outcomes").get()!.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM attachment_migration_outcomes").get()!.count, 1);
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
        theme: "system",
        sidebar_preference: "expanded",
        version: 1,
        created_at: now,
        updated_at: now,
      },
      {
        id: "user-collaborator",
        display_name: "Collaborator",
        email: "collaborator@example.com",
        timezone: "UTC",
        theme: "dark",
        sidebar_preference: "collapsed",
        version: 2,
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
    attachment_migration_outcomes: [],
    comments: [
      {
        id: "comment-1",
        task_id: "task-1",
        author_user_id: "user-admin",
        body: "Native backup comment",
        source: "native",
        source_record_id: null,
        source_comment_id: null,
        source_parent_comment_id: null,
        historical_author_name: null,
        historical_created_at: null,
        historical_updated_at: null,
        historical_quoted_text: null,
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
    comment_attachment_refs: [],
    comment_migration_outcomes: [],
    activity_events: [],
    activity_migration_outcomes: [],
    comment_reactions: [
      { comment_id: "comment-1", user_id: "user-collaborator", emoji: "👍", created_at: now },
    ],
    label_groups: [],
    labels: [
      {
        id: "label-1",
        owner_user_id: "user-admin",
        group_id: null,
        name: "Infrastructure",
        color: "#6b7280",
        description: "Infrastructure work",
        archived_at: null,
        version: 1,
        created_at: now,
        updated_at: now,
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
        archived_at: null,
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

function addHistoricalActivity(tables: BackupTables) {
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
    "0019_silky_drax.sql",
    "0020_giant_boom_boom.sql",
    "0021_freezing_preak.sql",
    "0022_cheerful_sue_storm.sql",
    "0023_tan_millenium_guard.sql",
    "0024_workable_zeigeist.sql",
    "0025_revoke_scoped_view_grants.sql",
    "0026_repair_legacy_workflow_catalogs.sql",
    "0027_busy_silver_sable.sql",
    "0028_hot_obadiah_stane.sql",
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
    for (const table of restoreTableDefinitions) {
      database.prepare(restoreInsertSql(table)).run(importId, table.name);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
