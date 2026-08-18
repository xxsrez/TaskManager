import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createD1TestHarness } from "./helpers/d1";

test("activity cutover migrates Linear state history with explicit reconciliation", async () => {
  const harness = await createD1TestHarness({}, {
    migrationsBefore: "0023_tan_millenium_guard.sql",
  });
  try {
    const db = harness.database;
    await db.batch([
      db.prepare("INSERT INTO users (id, display_name, email) VALUES ('activity-owner', 'Owner', 'activity-owner@example.test')"),
      db.prepare(`INSERT INTO workflow_statuses
        (id, owner_user_id, name, category, color, position, is_default)
        VALUES ('activity-status', 'activity-owner', 'Todo', 'unstarted', '#888888', 0, 1)`),
      db.prepare(`INSERT INTO projects
        (id, public_id, owner_user_id, creator_user_id, name, task_code,
         task_sequence, code_locked_at, status, version, created_at, updated_at)
        VALUES ('activity-project', '11111111-1111-4111-8111-111111111111',
          'activity-owner', 'activity-owner', 'Activity', 'AC', 1,
          '2025-01-01T00:00:00.000Z', 'active', 1,
          '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`),
      db.prepare(`INSERT INTO tasks
        (id, public_id, owner_user_id, creator_user_id, identifier,
         sequence_number, title, status_id, project_id, rank,
         created_at, updated_at)
        VALUES ('activity-task', '22222222-2222-4222-8222-222222222222',
          'activity-owner', 'activity-owner', 'AC-1', 1, 'Activity task',
          'activity-status', 'activity-project', 1000,
          '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`),
      db.prepare(`INSERT INTO external_records
        (id, owner_user_id, target_type, target_id, source, source_id,
         metadata_json, imported_at)
        VALUES ('activity-source', 'activity-owner', 'task', 'activity-task',
          'linear', 'LIN-1', ?, '2026-08-18T00:00:00.000Z')`).bind(JSON.stringify({
            stateHistory: [
              {
                id: "state-1",
                fromState: { name: "Todo" },
                state: { name: "In Progress" },
                actor: { name: "Ada" },
                createdAt: "2025-01-02T00:00:00.000Z",
              },
              {
                id: "state-2",
                fromState: { name: "In Progress" },
                state: { name: "Done" },
                createdAt: "2025-01-03T00:00:00.000Z",
              },
              { id: "state-invalid", state: { name: "Done" } },
              "not-an-object",
            ],
          })),
      db.prepare(`INSERT INTO external_records
        (id, owner_user_id, target_type, target_id, source, source_id,
         metadata_json, imported_at)
        VALUES ('activity-source-invalid', 'activity-owner', 'task', 'activity-task',
          'linear', 'LIN-2', ?, '2026-08-18T00:00:00.000Z')`).bind(JSON.stringify({
            stateHistory: "invalid collection",
          })),
    ]);

    const statements = readFileSync(
      new URL("../drizzle/0023_tan_millenium_guard.sql", import.meta.url),
      "utf8",
    ).split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
    await db.batch(statements.map((statement) => db.prepare(statement)));

    const events = await db.prepare(
      `SELECT event_type, actor_kind, actor_name, source_event_id, source_index,
         payload_json, created_at
       FROM activity_events ORDER BY source_record_id, source_index`,
    ).all<Record<string, unknown>>();
    assert.equal(events.results.length, 2);
    assert.deepEqual(events.results.map((row) => row.actor_name), [
      "Ada",
      "Unknown Linear user",
    ]);
    assert.deepEqual(events.results.map((row) => row.event_type), [
      "status_changed",
      "status_changed",
    ]);
    assert.match(String(events.results[0]?.payload_json), /"before":"Todo"/);
    assert.equal(events.results[0]?.created_at, "2025-01-02T00:00:00.000Z");

    const outcomes = await db.prepare(
      `SELECT source_record_id, source_index, outcome, reason, activity_event_id,
         json_valid(raw_json) AS raw_json_valid
       FROM activity_migration_outcomes ORDER BY source_record_id, source_index`,
    ).all<Record<string, unknown>>();
    assert.equal(outcomes.results.length, 5);
    assert.deepEqual(outcomes.results.map((row) => row.outcome), [
      "migrated",
      "migrated",
      "exception",
      "exception",
      "exception",
    ]);
    assert.equal(outcomes.results[0]?.reason, null);
    assert.equal(outcomes.results[1]?.reason, "actor_name_missing");
    assert.equal(outcomes.results[2]?.reason, "activity_timestamp_missing");
    assert.equal(outcomes.results[3]?.reason, "activity_not_object");
    assert.equal(outcomes.results[4]?.reason, "invalid_activity_collection");
    assert.ok(outcomes.results.every((row) => row.raw_json_valid === 1));
    assert.ok(outcomes.results[0]?.activity_event_id);
    assert.equal(outcomes.results[2]?.activity_event_id, null);

    await assert.rejects(
      db.prepare(`INSERT INTO activity_events
        (id, task_id, event_type, actor_kind, actor_user_id, actor_name,
         payload_json, source, source_record_id, source_index, created_at)
        VALUES ('activity-impersonation', 'activity-task', 'status_changed',
          'user', 'activity-owner', 'Owner', '{}', 'linear',
          'activity-source', 100, '2025-01-04T00:00:00.000Z')`).run(),
      /check_activity_event_source|constraint/i,
    );
    await assert.rejects(
      db.prepare("UPDATE activity_events SET actor_name = 'Changed'").run(),
      /activity events are immutable/,
    );
    assert.equal((await db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
    const triggers = await db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN
        ('activity_events_immutable', 'workspace_sync_activity_insert')
       ORDER BY name`,
    ).all<{ name: string }>();
    assert.deepEqual(triggers.results.map((row) => row.name), [
      "activity_events_immutable",
      "workspace_sync_activity_insert",
    ]);
  } finally {
    await harness.dispose();
  }
});
