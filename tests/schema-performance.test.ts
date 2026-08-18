import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { createD1TestHarness } from "./helpers/d1";

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  const migrations = readdirSync(new URL("../drizzle", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    const sql = readFileSync(
      new URL(`../drizzle/${migration}`, import.meta.url),
      "utf8",
    ).replaceAll("--> statement-breakpoint", "");
    database.exec(sql);
  }
  return database;
}

function migrationSql(name: string) {
  return readFileSync(
    new URL(`../drizzle/${name}`, import.meta.url),
    "utf8",
  ).replaceAll("--> statement-breakpoint", "");
}

function planDetails(database: DatabaseSync, sql: string): string[] {
  return database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => String(row.detail));
}

test("task hierarchy and release lookups use dedicated indexes", () => {
  const database = migratedDatabase();

  assert.ok(
    planDetails(
      database,
      "SELECT id FROM tasks WHERE parent_task_id = 'task-1'",
    ).some((detail) => detail.includes("idx_tasks_parent")),
  );
  assert.ok(
    planDetails(
      database,
      "SELECT id FROM tasks WHERE release_id = 'release-1' AND archived_at IS NULL",
    ).some((detail) => detail.includes("idx_tasks_release_archived")),
  );
});

test("prefix search and task sequence allocation have dedicated schema support", () => {
  const database = migratedDatabase();

  assert.ok(
    planDetails(
      database,
      "SELECT id FROM tasks WHERE lower(title) >= 'ship' AND lower(title) < 'ship￿'",
    ).some((detail) => detail.includes("idx_tasks_title_search")),
  );
  assert.ok(
    planDetails(
      database,
      "SELECT id FROM projects WHERE lower(name) >= 'launch' AND lower(name) < 'launch￿'",
    ).some((detail) => detail.includes("idx_projects_name_search")),
  );
  const columns = database.prepare("PRAGMA table_info(task_sequences)").all();
  assert.deepEqual(columns.map((column) => column.name), ["owner_user_id", "last_value"]);
});

test("project-scoped identifier migration preserves legacy lookup and assigns standalone Tasks deterministically", () => {
  const database = new DatabaseSync(":memory:");
  const migrations = readdirSync(new URL("../drizzle", import.meta.url))
    .filter((name) => name.endsWith(".sql") && name < "0018_tearful_black_panther.sql")
    .sort();
  for (const migration of migrations) database.exec(migrationSql(migration));
  database.exec(`
    INSERT INTO users (id, display_name, email)
      VALUES ('owner-1', 'Owner', 'owner@example.test');
    INSERT INTO workflow_statuses
      (id, owner_user_id, name, category, color, position, is_default)
      VALUES ('todo-1', 'owner-1', 'Todo', 'unstarted', '#888888', 0, 1);
    INSERT INTO projects
      (id, public_id, owner_user_id, creator_user_id, name, status, version)
      VALUES
      ('project-tm', '11111111-1111-4111-8111-111111111111', 'owner-1', 'owner-1', 'Task Manager', 'active', 1),
      ('project-md', '22222222-2222-4222-8222-222222222222', 'owner-1', 'owner-1', 'Mind Diary', 'active', 1),
      ('project-tm-copy', '77777777-7777-4777-8777-777777777777', 'owner-1', 'owner-1', 'Task Manager', 'active', 1);
    INSERT INTO tasks
      (id, public_id, owner_user_id, creator_user_id, identifier, sequence_number,
       title, status_id, project_id, rank, created_at, updated_at)
      VALUES
      ('task-tm', '33333333-3333-4333-8333-333333333333', 'owner-1', 'owner-1',
       'AND-12', 12, 'Existing project Task', 'todo-1', 'project-tm', 1000,
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('task-md', '44444444-4444-4444-8444-444444444444', 'owner-1', 'owner-1',
       'AND-91', 91, 'Mind Diary migration Task', 'todo-1', NULL, 2000,
       '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
      ('task-mi', '55555555-5555-4555-8555-555555555555', 'owner-1', 'owner-1',
       'AND-1', 1, 'Provider onboarding Task', 'todo-1', NULL, 3000,
       '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
    INSERT INTO comments
      (id, task_id, author_user_id, body, idempotency_key, created_at, updated_at)
      VALUES ('comment-tm', 'task-tm', 'owner-1', 'Preserved comment',
        'comment-tm-key', '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z');
    INSERT INTO attachments
      (id, public_id, task_id, uploader_user_id, original_filename,
       display_name, media_type, byte_size, checksum_sha256, object_key,
       kind, state, idempotency_key, created_at, updated_at)
      VALUES ('attachment-tm', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'task-tm', 'owner-1', 'evidence.txt', 'evidence.txt', 'text/plain', 1,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'test/migration-object', 'file', 'ready', 'attachment-tm-key',
        '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z');
  `);

  database.exec(migrationSql("0018_tearful_black_panther.sql"));

  const projects = database.prepare(
    "SELECT name, task_code, task_sequence, code_locked_at FROM projects ORDER BY name, id",
  ).all();
  assert.deepEqual(projects.map((row) => [row.name, row.task_code, row.task_sequence]), [
    ["Migration Inbox", "MI", 1],
    ["Mind Diary", "MD", 91],
    ["Task Manager", "TM", 12],
    ["Task Manager", "ZAC", 0],
  ]);
  assert.ok(projects.slice(0, 3).every((row) => row.code_locked_at));
  assert.equal(projects[3]?.code_locked_at, null);
  const tasks = database.prepare(
    `SELECT t.id, t.identifier, p.task_code
     FROM tasks t JOIN projects p ON p.id = t.project_id ORDER BY t.id`,
  ).all();
  assert.deepEqual(tasks.map((row) => [row.id, row.identifier, row.task_code]), [
    ["task-md", "MD-91", "MD"],
    ["task-mi", "MI-1", "MI"],
    ["task-tm", "TM-12", "TM"],
  ]);
  assert.deepEqual(
    database.prepare(
      "SELECT task_id, identifier FROM task_identifier_aliases ORDER BY task_id",
    ).all().map((row) => [row.task_id, row.identifier]),
    [["task-md", "AND-91"], ["task-mi", "AND-1"], ["task-tm", "AND-12"]],
  );
  const projectColumn = database.prepare("PRAGMA table_info(tasks)").all()
    .find((column) => column.name === "project_id");
  assert.equal(projectColumn?.notnull, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM comments WHERE id = 'comment-tm'").get()?.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM attachments WHERE id = 'attachment-tm'").get()?.count, 1);
  assert.ok(database.prepare("PRAGMA foreign_key_list(task_identifier_aliases)").all()
    .some((foreignKey) =>
      foreignKey.table === "tasks" &&
      foreignKey.from === "task_id" &&
      foreignKey.on_delete === "CASCADE"));
  assert.throws(() => database.exec(`
    INSERT INTO tasks
      (id, public_id, owner_user_id, creator_user_id, identifier, sequence_number,
       title, status_id, project_id)
      VALUES ('invalid', '66666666-6666-4666-8666-666666666666', 'owner-1',
        'owner-1', 'XX-1', 1, 'Invalid', 'todo-1', NULL);
  `), /NOT NULL/);
});

test("project-scoped identifier migration preserves dependent rows in an atomic D1 batch", async () => {
  const harness = await createD1TestHarness({}, {
    migrationsBefore: "0018_tearful_black_panther.sql",
  });
  try {
    const db = harness.database;
    await db.batch([
      db.prepare("INSERT INTO users (id, display_name, email) VALUES ('migration-owner', 'Owner', 'migration@example.test')"),
      db.prepare(`INSERT INTO workflow_statuses
        (id, owner_user_id, name, category, color, position, is_default)
        VALUES ('migration-status', 'migration-owner', 'Todo', 'unstarted', '#888888', 0, 1)`),
      db.prepare(`INSERT INTO projects
        (id, public_id, owner_user_id, creator_user_id, name, status, version)
        VALUES ('migration-project', '88888888-8888-4888-8888-888888888888',
          'migration-owner', 'migration-owner', 'Task Manager', 'active', 1)`),
      db.prepare(`INSERT INTO tasks
        (id, public_id, owner_user_id, creator_user_id, identifier, sequence_number,
         title, status_id, project_id, rank, created_at, updated_at)
        VALUES ('migration-task', '99999999-9999-4999-8999-999999999999',
          'migration-owner', 'migration-owner', 'AND-41', 41, 'Preserved Task',
          'migration-status', 'migration-project', 1000,
          '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`),
      db.prepare(`INSERT INTO comments
        (id, task_id, author_user_id, body, idempotency_key, created_at, updated_at)
        VALUES ('migration-comment', 'migration-task', 'migration-owner',
          'Preserved comment', 'migration-comment-key',
          '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')`),
      db.prepare(`INSERT INTO comment_reactions
        (comment_id, user_id, emoji, created_at)
        VALUES ('migration-comment', 'migration-owner', '👍',
          '2026-01-04T00:00:00.000Z')`),
      db.prepare(`INSERT INTO attachments
        (id, public_id, task_id, uploader_user_id, original_filename,
         display_name, media_type, byte_size, checksum_sha256, object_key,
         kind, state, idempotency_key, created_at, updated_at)
        VALUES ('migration-attachment', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          'migration-task', 'migration-owner', 'evidence.txt', 'evidence.txt',
          'text/plain', 1,
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'uat/migration-object', 'file', 'ready', 'migration-attachment-key',
          '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z')`),
    ]);
    const statements = readFileSync(
      new URL("../drizzle/0018_tearful_black_panther.sql", import.meta.url),
      "utf8",
    ).split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
    await db.batch(statements.map((statement) => db.prepare(statement)));

    assert.deepEqual(
      (await db.prepare(`SELECT identifier, title, created_at, updated_at
        FROM tasks WHERE id = 'migration-task'`).first()),
      {
        identifier: "TM-41",
        title: "Preserved Task",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      },
    );
    assert.deepEqual(
      (await db.prepare(`SELECT task_id, body, created_at
        FROM comments WHERE id = 'migration-comment'`).first()),
      {
        task_id: "migration-task",
        body: "Preserved comment",
        created_at: "2026-01-03T00:00:00.000Z",
      },
    );
    assert.deepEqual(
      await db.prepare(`SELECT user_id, emoji FROM comment_reactions
        WHERE comment_id = 'migration-comment'`).first(),
      { user_id: "migration-owner", emoji: "👍" },
    );
    assert.deepEqual(
      await db.prepare(`SELECT task_id, object_key, state FROM attachments
        WHERE id = 'migration-attachment'`).first(),
      {
        task_id: "migration-task",
        object_key: "uat/migration-object",
        state: "ready",
      },
    );
    assert.equal((await db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("a failed project assignment migration rolls its D1 schema batch back", async () => {
  const harness = await createD1TestHarness({}, {
    migrationsBefore: "0018_tearful_black_panther.sql",
  });
  try {
    const db = harness.database;
    await db.batch([
      db.prepare("INSERT INTO users (id, display_name, email) VALUES ('rollback-owner', 'Owner', 'rollback@example.test')"),
      db.prepare(`INSERT INTO workflow_statuses
        (id, owner_user_id, name, category, color, position, is_default)
        VALUES ('rollback-status', 'rollback-owner', 'Todo', 'unstarted', '#888888', 0, 1)`),
      db.prepare(`INSERT INTO tasks
        (id, public_id, owner_user_id, creator_user_id, identifier, sequence_number,
         title, status_id, project_id)
        VALUES ('rollback-task', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          'rollback-owner', 'rollback-owner', 'AND-999', 999,
          'Unmapped Task', 'rollback-status', NULL)`),
    ]);
    const statements = readFileSync(
      new URL("../drizzle/0018_tearful_black_panther.sql", import.meta.url),
      "utf8",
    ).split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
    await assert.rejects(
      db.batch(statements.map((statement) => db.prepare(statement))),
    );
    const projectColumns = (await db.prepare("PRAGMA table_info(projects)").all()).results;
    assert.equal(projectColumns.some((column) => column.name === "task_code"), false);
    assert.deepEqual(
      await db.prepare("SELECT identifier, project_id FROM tasks WHERE id = 'rollback-task'").first(),
      { identifier: "AND-999", project_id: null },
    );
  } finally {
    await harness.dispose();
  }
});

test("native comments have task counters, relational integrity, and lookup indexes", () => {
  const database = migratedDatabase();
  const taskColumns = database.prepare("PRAGMA table_info(tasks)").all();
  assert.ok(taskColumns.some((column) => column.name === "comment_count"));

  const commentForeignKeys = database
    .prepare("PRAGMA foreign_key_list(comments)")
    .all();
  assert.ok(
    commentForeignKeys.some(
      (foreignKey) =>
        foreignKey.table === "tasks" &&
        foreignKey.from === "task_id" &&
        foreignKey.on_delete === "CASCADE",
    ),
  );
  assert.ok(
    commentForeignKeys.some(
      (foreignKey) =>
        foreignKey.table === "comments" &&
        foreignKey.from === "parent_comment_id" &&
        foreignKey.on_delete === "CASCADE",
    ),
  );
  const reactionForeignKeys = database
    .prepare("PRAGMA foreign_key_list(comment_reactions)")
    .all();
  assert.ok(
    reactionForeignKeys.some(
      (foreignKey) =>
        foreignKey.table === "comments" &&
        foreignKey.from === "comment_id" &&
        foreignKey.on_delete === "CASCADE",
    ),
  );
  assert.ok(
    planDetails(
      database,
      "SELECT id FROM comments WHERE task_id = 'task-1' ORDER BY created_at, id",
    ).some((detail) => detail.includes("idx_comments_task_created")),
  );
  assert.ok(
    planDetails(
      database,
      "SELECT id FROM comments WHERE parent_comment_id = 'comment-1' ORDER BY created_at, id",
    ).some((detail) => detail.includes("idx_comments_parent")),
  );
});

test("native attachments enforce task ownership shape and use lifecycle indexes", () => {
  const database = migratedDatabase();
  const foreignKeys = database.prepare("PRAGMA foreign_key_list(attachments)").all();
  assert.ok(
    foreignKeys.some(
      (foreignKey) =>
        foreignKey.table === "tasks" &&
        foreignKey.from === "task_id" &&
        foreignKey.on_delete === "CASCADE",
    ),
  );
  assert.ok(
    planDetails(
      database,
      "SELECT id FROM attachments WHERE task_id = 'task-1' AND state = 'ready' ORDER BY created_at, id",
    ).some((detail) => detail.includes("idx_attachments_task_state_created")),
  );
  assert.ok(
    planDetails(
      database,
      "SELECT id FROM attachments WHERE state = 'deleted' AND deleted_at < CURRENT_TIMESTAMP",
    ).some((detail) => detail.includes("idx_attachments_cleanup")),
  );
  const syncTriggers = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'workspace_sync_attachments_%'")
    .all();
  assert.deepEqual(
    syncTriggers.map((trigger) => trigger.name).sort(),
    [
      "workspace_sync_attachments_delete",
      "workspace_sync_attachments_insert",
      "workspace_sync_attachments_update",
    ],
  );
});

test("workspace synchronization has per-principal ordering and mutation triggers", () => {
  const database = migratedDatabase();
  const sequencePrimaryKey = database
    .prepare("PRAGMA table_info(workspace_sync_sequences)")
    .all()
    .find((column) => column.name === "audience_user_id");
  assert.equal(sequencePrimaryKey?.pk, 1);

  const eventPrimaryKey = database
    .prepare("PRAGMA table_info(workspace_change_events)")
    .all()
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk));
  assert.deepEqual(
    eventPrimaryKey.map((column) => column.name),
    ["audience_user_id", "sequence"],
  );

  const triggers = new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((row) => row.name),
  );
  for (const trigger of [
    "workspace_sync_tasks_insert",
    "workspace_sync_tasks_update",
    "workspace_sync_tasks_delete",
    "workspace_sync_projects_update",
    "workspace_sync_releases_update",
    "workspace_sync_views_update",
    "workspace_sync_views_move",
    "workspace_sync_access_update",
    "workspace_sync_task_labels_insert",
    "workspace_sync_task_relations_insert",
    "workspace_sync_labels_update",
    "workspace_sync_labels_delete",
    "workspace_sync_lazy_invalidation_fanout",
    "workspace_sync_comments_insert",
    "workspace_sync_comments_update",
    "workspace_sync_comments_delete",
    "workspace_sync_comment_reactions_insert",
    "workspace_sync_comment_reactions_delete",
    "workspace_sync_external_records_insert",
    "workspace_sync_external_records_update",
    "workspace_sync_external_records_delete",
  ]) {
    assert.equal(triggers.has(trigger), true, `${trigger} should exist`);
  }
  assert.equal(triggers.has("workspace_sync_labels_insert"), false);
  assert.ok(
    planDetails(
      database,
      "DELETE FROM workspace_change_events WHERE created_at < CURRENT_TIMESTAMP",
    ).some((detail) => detail.includes("idx_workspace_change_events_created")),
  );
});

test("the selective sync migration tolerates missing legacy reset triggers", () => {
  const database = new DatabaseSync(":memory:");
  const migrations = readdirSync(new URL("../drizzle", import.meta.url))
    .filter((name) => name.endsWith(".sql") && name < "0013_rapid_gravity.sql")
    .sort();
  for (const migration of migrations) database.exec(migrationSql(migration));
  database.exec(`
    DROP TRIGGER workspace_sync_labels_insert;
    DROP TRIGGER workspace_sync_labels_update;
    DROP TRIGGER workspace_sync_labels_delete;
  `);

  assert.doesNotThrow(() => database.exec(migrationSql("0013_rapid_gravity.sql")));
  const triggers = new Set(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((row) => row.name),
  );
  assert.equal(triggers.has("workspace_sync_labels_insert"), false);
  assert.equal(triggers.has("workspace_sync_labels_update"), true);
  assert.equal(triggers.has("workspace_sync_labels_delete"), true);
});
