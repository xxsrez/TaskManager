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
