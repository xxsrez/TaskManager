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

test("scoped SavedView grant migration revokes only active direct grants that no longer define access", () => {
  const database = new DatabaseSync(":memory:");
  const migrations = readdirSync(new URL("../drizzle", import.meta.url))
    .filter((name) => name.endsWith(".sql") && name < "0025_revoke_scoped_view_grants.sql")
    .sort();
  for (const migration of migrations) database.exec(migrationSql(migration));
  database.exec(`
    INSERT INTO users (id, display_name, email)
      VALUES
      ('grant-owner', 'Owner', 'grant-owner@example.test'),
      ('grant-recipient', 'Recipient', 'grant-recipient@example.test');
    INSERT INTO projects
      (id, public_id, owner_user_id, creator_user_id, name, task_code, status, version)
      VALUES ('grant-project', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'grant-owner', 'grant-owner', 'Grant Project', 'GP', 'active', 1);
    INSERT INTO saved_views
      (id, public_id, owner_user_id, name, scope_project_id, query_json, display_json, version)
      VALUES
      ('scoped-active', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'grant-owner',
        'Scoped active', 'grant-project', '{}', '{}', 1),
      ('scoped-revoked', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'grant-owner',
        'Scoped revoked', 'grant-project', '{}', '{}', 1),
      ('global-active', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'grant-owner',
        'Global active', NULL, '{}', '{}', 1);
    INSERT INTO access_grants
      (id, resource_type, resource_id, owner_user_id, grantee_user_id,
       granted_by_user_id, permission, revoked_at)
      VALUES
      ('grant-scoped-active', 'saved_view', 'scoped-active', 'grant-owner',
        'grant-recipient', 'grant-owner', 'editor', NULL),
      ('grant-scoped-revoked', 'saved_view', 'scoped-revoked', 'grant-owner',
        'grant-recipient', 'grant-owner', 'editor', '2026-01-01T00:00:00.000Z'),
      ('grant-global-active', 'saved_view', 'global-active', 'grant-owner',
        'grant-recipient', 'grant-owner', 'editor', NULL);
  `);

  database.exec(migrationSql("0025_revoke_scoped_view_grants.sql"));

  const rows = database.prepare(
    "SELECT id, revoked_at FROM access_grants ORDER BY id",
  ).all();
  assert.equal(rows.find((row) => row.id === "grant-scoped-active")?.revoked_at !== null, true);
  assert.equal(rows.find((row) => row.id === "grant-scoped-revoked")?.revoked_at, "2026-01-01T00:00:00.000Z");
  assert.equal(rows.find((row) => row.id === "grant-global-active")?.revoked_at, null);
});

test("legacy users with only a reserved Duplicate status receive a complete default workflow catalog", () => {
  const database = new DatabaseSync(":memory:");
  const migrations = readdirSync(new URL("../drizzle", import.meta.url))
    .filter((name) => name.endsWith(".sql") && name < "0026_repair_legacy_workflow_catalogs.sql")
    .sort();
  for (const migration of migrations) database.exec(migrationSql(migration));
  database.exec(`
    INSERT INTO users (id, display_name, email)
      VALUES
      ('legacy-user', 'Legacy User', 'legacy@example.test'),
      ('valid-user', 'Valid User', 'valid@example.test');
    INSERT INTO workflow_statuses
      (id, owner_user_id, name, category, color, position, is_default,
       system_role, archived_at, version)
      VALUES
      ('legacy-duplicate', 'legacy-user', 'Duplicate', 'canceled', '#9ca3af', 0,
       0, 'duplicate', NULL, 1),
      ('valid-todo', 'valid-user', 'Todo', 'unstarted', '#94a3b8', 0,
       1, NULL, NULL, 1),
      ('valid-duplicate', 'valid-user', 'Duplicate', 'canceled', '#9ca3af', 1,
       0, 'duplicate', NULL, 1);
  `);

  const migration = migrationSql("0026_repair_legacy_workflow_catalogs.sql");
  database.exec(migration);
  database.exec(migration);

  const legacyRows = database.prepare(`
    SELECT name, category, is_default, system_role
    FROM workflow_statuses
    WHERE owner_user_id = 'legacy-user'
    ORDER BY position, name
  `).all();
  assert.deepEqual(legacyRows.map((row) => [row.name, row.category, row.is_default, row.system_role]), [
    ["Backlog", "backlog", 0, null],
    ["Duplicate", "canceled", 0, "duplicate"],
    ["Todo", "unstarted", 1, null],
    ["In Progress", "started", 0, null],
    ["Done", "completed", 0, null],
    ["Canceled", "canceled", 0, null],
  ]);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM workflow_statuses WHERE owner_user_id = 'valid-user'").get()?.count,
    2,
  );
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

test("StoredFile migration preserves every attachment ref, checksum, and object key", async () => {
  const harness = await createD1TestHarness({}, {
    migrationsBefore: "0030_absurd_blacklash.sql",
  });
  try {
    const db = harness.database;
    await db.batch([
      db.prepare(
        "INSERT INTO users (id, display_name, email) VALUES ('stored-migration-owner', 'Owner', 'stored-migration@example.test')",
      ),
      db.prepare(`INSERT INTO workflow_statuses
        (id, owner_user_id, name, category, color, position, is_default, system_role)
        VALUES ('stored-migration-status', 'stored-migration-owner', 'Todo',
          'unstarted', '#888888', 0, 1, 'todo')`),
      db.prepare(`INSERT INTO projects
        (id, public_id, owner_user_id, creator_user_id, name, task_code,
         status, lead_user_id, version)
        VALUES ('stored-migration-project', '10000000-0000-4000-8000-000000000001',
          'stored-migration-owner', 'stored-migration-owner', 'Stored migration',
          'SMG', 'active', 'stored-migration-owner', 1)`),
      db.prepare(`INSERT INTO tasks
        (id, public_id, owner_user_id, creator_user_id, identifier, sequence_number,
         title, status_id, project_id, rank, created_at, updated_at)
        VALUES ('stored-migration-task', '10000000-0000-4000-8000-000000000002',
          'stored-migration-owner', 'stored-migration-owner', 'SMG-1', 1,
          'Stored migration Task', 'stored-migration-status',
          'stored-migration-project', 1000,
          '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`),
      db.prepare(`INSERT INTO attachments
        (id, public_id, task_id, uploader_user_id, original_filename,
         display_name, media_type, byte_size, checksum_sha256, object_key,
         kind, state, idempotency_key, created_at, updated_at)
        VALUES ('stored-migration-attachment',
          '10000000-0000-4000-8000-000000000003',
          'stored-migration-task', 'stored-migration-owner', 'evidence.pdf',
          'evidence.pdf', 'application/pdf', 123,
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'uat/attachments/existing-object', 'file', 'ready',
          'existing-attachment-key', '2026-01-03T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z')`),
    ]);
    const statements = readFileSync(
      new URL("../drizzle/0030_absurd_blacklash.sql", import.meta.url),
      "utf8",
    ).split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
    await db.batch(statements.map((statement) => db.prepare(statement)));

    const attachment = await db.prepare(`SELECT public_id, stored_file_id,
      checksum_sha256, object_key FROM attachments
      WHERE id = 'stored-migration-attachment'`).first<{
        public_id: string;
        stored_file_id: string;
        checksum_sha256: string;
        object_key: string;
      }>();
    assert.equal(attachment?.public_id, "10000000-0000-4000-8000-000000000003");
    assert.equal(attachment?.checksum_sha256, "b".repeat(64));
    assert.equal(attachment?.object_key, "uat/attachments/existing-object");
    assert.ok(attachment?.stored_file_id);
    assert.deepEqual(
      await db.prepare(`SELECT uploader_user_id, checksum_sha256, object_key,
        state, created_at, updated_at FROM stored_files WHERE id = ?`)
        .bind(attachment!.stored_file_id).first(),
      {
        uploader_user_id: "stored-migration-owner",
        checksum_sha256: "b".repeat(64),
        object_key: "uat/attachments/existing-object",
        state: "ready",
        created_at: "2026-01-03T00:00:00.000Z",
        updated_at: "2026-01-04T00:00:00.000Z",
      },
    );
    assert.equal((await db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("a failed StoredFile forward migration rolls back schema and backfill together", async () => {
  const harness = await createD1TestHarness({}, {
    migrationsBefore: "0030_absurd_blacklash.sql",
  });
  try {
    const db = harness.database;
    const statements = readFileSync(
      new URL("../drizzle/0030_absurd_blacklash.sql", import.meta.url),
      "utf8",
    ).split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
    await assert.rejects(
      db.batch([
        ...statements.map((statement) => db.prepare(statement)),
        db.prepare("INSERT INTO stored_files (id) VALUES ('forced-failure')"),
      ]),
      /not null constraint/i,
    );
    assert.equal(
      await db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'stored_files'",
      ).first<{ count: number }>().then((row) => Number(row?.count ?? 0)),
      0,
    );
    assert.equal(
      (await db.prepare("PRAGMA table_info(attachments)").all<{ name: string }>())
        .results.some((column) => column.name === "stored_file_id"),
      false,
    );
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

test("comment attachment refs have bounded lifecycle and attachment delete indexes", () => {
  const database = migratedDatabase();
  const foreignKeys = database.prepare(
    "PRAGMA foreign_key_list(comment_attachment_refs)",
  ).all() as Array<Record<string, unknown>>;
  assert.deepEqual(
    new Set(foreignKeys.map((row) => String(row.table))),
    new Set(["attachments", "comments", "tasks"]),
  );
  assert.ok(
    planDetails(
      database,
      "SELECT comment_id FROM comment_attachment_refs WHERE task_id = 'task-1' AND attachment_id = 'attachment-1' LIMIT 1",
    ).some((detail) => detail.includes("idx_comment_attachment_refs_task_attachment")),
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
    "workspace_sync_label_groups_catalog_insert",
    "workspace_sync_label_groups_catalog_update",
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

test("native Label catalog migration preserves versioned archive metadata and active uniqueness", () => {
  const database = migratedDatabase();
  const columns = new Set(
    database.prepare("PRAGMA table_info(labels)").all().map((row) => row.name),
  );
  for (const column of ["description", "archived_at", "version", "updated_at"]) {
    assert.equal(columns.has(column), true, column);
  }
  const index = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_labels_owner_name_active'",
  ).get() as { sql: string };
  assert.match(index.sql, /owner_user_id[^)]*,\s*lower\("name"\)/i);
  assert.match(index.sql, /WHERE\s+"labels"\."archived_at" IS NULL/i);
  database.prepare(
    "INSERT INTO labels (id, owner_user_id, name) VALUES ('label-active', 'owner-label', 'Reusable')",
  ).run();
  database.prepare(
    "UPDATE labels SET archived_at = CURRENT_TIMESTAMP WHERE id = 'label-active'",
  ).run();
  assert.doesNotThrow(() => database.prepare(
    "INSERT INTO labels (id, owner_user_id, name) VALUES ('label-reused', 'owner-label', 'Reusable')",
  ).run());
});

test("Label catalog migration keeps imported IDs and assignments", () => {
  const database = new DatabaseSync(":memory:");
  const migrations = readdirSync(new URL("../drizzle", import.meta.url))
    .filter((name) => name.endsWith(".sql") && name < "0019_silky_drax.sql")
    .sort();
  for (const migration of migrations) database.exec(migrationSql(migration));
  database.prepare(
    `INSERT INTO labels (id, owner_user_id, name, color, created_at)
     VALUES ('label-imported', 'owner-imported', 'Imported', '#123456',
       '2026-08-18 03:00:00')`,
  ).run();
  database.prepare(
    "INSERT INTO task_labels (task_id, label_id) VALUES ('task-imported', 'label-imported')",
  ).run();
  database.exec(migrationSql("0019_silky_drax.sql"));
  const label = database.prepare(
    `SELECT id, name, color, description, archived_at, version,
      created_at, updated_at FROM labels WHERE id = 'label-imported'`,
  ).get() as Record<string, unknown>;
  assert.deepEqual({ ...label }, {
    id: "label-imported",
    name: "Imported",
    color: "#123456",
    description: "",
    archived_at: null,
    version: 1,
    created_at: "2026-08-18 03:00:00",
    updated_at: "2026-08-18 03:00:00",
  });
  assert.equal(
    (database.prepare(
      "SELECT COUNT(*) AS count FROM task_labels WHERE task_id = 'task-imported' AND label_id = 'label-imported'",
    ).get() as { count: number }).count,
    1,
  );
});
