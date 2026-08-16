import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

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
