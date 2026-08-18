import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createD1TestHarness } from "./helpers/d1";

test("comment cutover migrates existing external archives with explicit reconciliation", async () => {
  const harness = await createD1TestHarness({}, {
    migrationsBefore: "0022_cheerful_sue_storm.sql",
  });
  try {
    const db = harness.database;
    const metadata = {
      comments: [
        {
          id: "nested",
          body: "Nested reply",
          author: { name: "Grace" },
          createdAt: "2025-01-03T00:00:00.000Z",
          updatedAt: "2025-01-03T01:00:00.000Z",
          parentId: "reply",
        },
        {
          id: "root",
          body: "Root body",
          author: { name: "Ada" },
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T01:00:00.000Z",
          quotedText: "Source quote",
        },
        {
          id: "reply",
          body: "Reply body",
          author: { name: "Linus" },
          createdAt: "2025-01-02T00:00:00.000Z",
          updatedAt: "2025-01-02T01:00:00.000Z",
          parentId: "root",
        },
        {
          id: "orphan",
          body: "Orphan body",
          createdAt: "2025-01-04T00:00:00.000Z",
          updatedAt: "2025-01-04T00:00:00.000Z",
          parentId: "missing",
        },
        "malformed",
      ],
    };
    await db.batch([
      db.prepare("INSERT INTO users (id, display_name, email) VALUES ('history-owner', 'Owner', 'owner@example.test')"),
      db.prepare(`INSERT INTO workflow_statuses
        (id, owner_user_id, name, category, color, position, is_default)
        VALUES ('history-status', 'history-owner', 'Todo', 'unstarted', '#888888', 0, 1)`),
      db.prepare(`INSERT INTO projects
        (id, public_id, owner_user_id, creator_user_id, name, task_code,
         task_sequence, code_locked_at, status, version, created_at, updated_at)
        VALUES ('history-project', '11111111-1111-4111-8111-111111111111',
          'history-owner', 'history-owner', 'History', 'HI', 1,
          '2025-01-01T00:00:00.000Z', 'active', 1,
          '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`),
      db.prepare(`INSERT INTO tasks
        (id, public_id, owner_user_id, creator_user_id, identifier,
         sequence_number, title, status_id, project_id, rank,
         created_at, updated_at)
        VALUES ('history-task', '22222222-2222-4222-8222-222222222222',
          'history-owner', 'history-owner', 'HI-1', 1, 'History task',
          'history-status', 'history-project', 1000,
          '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`),
      db.prepare(`INSERT INTO external_records
        (id, owner_user_id, target_type, target_id, source, source_id,
         metadata_json, imported_at)
        VALUES ('history-source', 'history-owner', 'task', 'history-task',
          'linear', 'LIN-1', ?, '2026-08-18T00:00:00.000Z')`).bind(JSON.stringify(metadata)),
    ]);

    const statements = readFileSync(
      new URL("../drizzle/0022_cheerful_sue_storm.sql", import.meta.url),
      "utf8",
    ).split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
    await db.batch(statements.map((statement) => db.prepare(statement)));

    const comments = await db.prepare(
      `SELECT id, source_comment_id, source_parent_comment_id, parent_comment_id,
         author_user_id, historical_author_name, historical_quoted_text
       FROM comments ORDER BY created_at, id`,
    ).all<Record<string, unknown>>();
    assert.equal(comments.results.length, 3);
    assert.deepEqual(comments.results.map((row) => row.source_comment_id), [
      "root",
      "reply",
      "nested",
    ]);
    const root = comments.results[0]!;
    assert.equal(root.author_user_id, null);
    assert.equal(root.historical_author_name, "Ada");
    assert.equal(root.historical_quoted_text, "Source quote");
    assert.equal(comments.results[1]?.parent_comment_id, root.id);
    assert.equal(comments.results[2]?.parent_comment_id, root.id);
    assert.equal(comments.results[2]?.source_parent_comment_id, "reply");

    const outcomes = await db.prepare(
      `SELECT source_index, outcome, reason, comment_id
       FROM comment_migration_outcomes ORDER BY source_index`,
    ).all<Record<string, unknown>>();
    assert.equal(outcomes.results.length, 5);
    assert.deepEqual(outcomes.results.map((row) => row.outcome), [
      "migrated",
      "migrated",
      "migrated",
      "exception",
      "exception",
    ]);
    assert.match(String(outcomes.results[0]?.reason), /nested_reply_flattened/);
    assert.equal(outcomes.results[3]?.reason, "invalid_parent_topology");
    assert.equal(outcomes.results[4]?.reason, "comment_not_object");
    assert.equal(
      (await db.prepare("SELECT comment_count FROM tasks WHERE id = 'history-task'").first<{ comment_count: number }>())?.comment_count,
      3,
    );
    await assert.rejects(
      db.prepare("UPDATE comments SET body = 'changed' WHERE source = 'linear'").run(),
      /historical comment facts are immutable/,
    );
    await assert.rejects(
      db.prepare(
        `INSERT INTO comments
          (id, task_id, author_user_id, body, source, idempotency_key)
         VALUES ('invalid-history-impersonation', 'history-task', 'history-owner',
           'invalid', 'linear', 'invalid-history-impersonation')`,
      ).run(),
      /check_comment_source_shape|CHECK constraint failed/i,
    );
    assert.equal((await db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
    const triggers = await db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN
        ('comments_historical_facts_immutable', 'workspace_sync_comments_insert',
         'workspace_sync_comment_reactions_insert') ORDER BY name`,
    ).all<{ name: string }>();
    assert.deepEqual(triggers.results.map((row) => row.name), [
      "comments_historical_facts_immutable",
      "workspace_sync_comment_reactions_insert",
      "workspace_sync_comments_insert",
    ]);
  } finally {
    await harness.dispose();
  }
});
