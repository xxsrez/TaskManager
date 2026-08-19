import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLinearImportPlan,
  decodeLinearImportPayload,
  importLinearWorkspace,
  maxLinearImportBytes,
  type LinearImportPlan,
} from "../lib/linear-import";
import { ValidationError } from "../lib/domain";
import { getOrCreateUser } from "../lib/repository";
import { createD1TestHarness } from "./helpers/d1";

const exportedAt = "2026-08-14T07:30:00.000Z";

function fixture(): Record<string, unknown> {
  return {
    version: 1,
    source: {
      provider: "linear",
      exportedAt,
    },
    statuses: [
      { id: "s1", name: "Todo", type: "unstarted" },
      { id: "s2", name: "Done", type: "completed" },
      { id: "s3", name: "Duplicate", type: "duplicate" },
    ],
    labels: [{ id: "l1", name: "Bug", color: "#eb5757" }],
    projects: [
      {
        id: "p1",
        name: "Project",
        summary: "Summary",
        description: "Description",
        status: { type: "started" },
        lead: { id: "linear-user" },
        startDate: "2026-08-01",
        targetDate: null,
        icon: null,
        color: "#123456",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        milestones: [
          {
            id: "m1",
            name: "0.1",
            description: "Release scope",
            targetDate: null,
          },
        ],
      },
    ],
    issues: [
      {
        id: "AND-2",
        title: "Child",
        description: "Child description",
        status: "Done",
        statusType: "completed",
        priority: { value: 1, name: "Urgent" },
        projectId: "p1",
        projectMilestone: { id: "m1", name: "0.1" },
        parentId: "AND-1",
        assigneeId: "linear-user",
        labels: ["Bug"],
        relations: {
          blocks: [],
          blockedBy: [],
          relatedTo: [{ id: "AND-1", title: "Parent" }],
          duplicateOf: null,
        },
        attachments: [
          { title: "Evidence", subtitle: null, url: "https://example.com" },
        ],
        stateHistory: [
          {
            id: "history-1",
            fromState: { name: "Todo" },
            state: { name: "Done" },
            actor: { name: "Historical Operator" },
            createdAt: "2026-08-03T00:00:00.000Z",
          },
          { id: "history-invalid", state: { name: "Done" } },
        ],
        url: "https://linear.app/example/AND-2",
        gitBranchName: "and-2-child",
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
        completedAt: "2026-08-03T00:00:00.000Z",
        startedAt: "2026-08-02T12:00:00.000Z",
        canceledAt: null,
        archivedAt: null,
        dueDate: null,
      },
      {
        id: "AND-1",
        title: "Parent",
        description: "Parent description",
        status: "Todo",
        statusType: "unstarted",
        priority: { value: 0, name: "No priority" },
        projectId: "p1",
        projectMilestone: { id: "m1", name: "0.1" },
        parentId: null,
        assigneeId: null,
        labels: [],
        relations: {
          blocks: [{ id: "AND-2", title: "Child" }],
          blockedBy: [],
          relatedTo: [{ id: "AND-2", title: "Child" }],
          duplicateOf: null,
        },
        attachments: [],
        stateHistory: [],
        url: "https://linear.app/example/AND-1",
        gitBranchName: "and-1-parent",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T01:00:00.000Z",
        completedAt: null,
        startedAt: null,
        canceledAt: null,
        archivedAt: null,
        dueDate: null,
      },
    ],
    views: [
      {
        sourceId: "v1",
        name: "Project board",
        sourceProjectId: "p1",
        sourceMilestoneId: "m1",
        query: {},
        display: {
          layout: "board",
          groupBy: "status",
          orderBy: "priority",
          direction: "asc",
          showEmptyGroups: false,
          visibleFields: ["priority", "project", "release"],
        },
        url: "https://linear.app/example/view",
      },
    ],
    commentsByIssue: {
      "AND-2": [{
        id: "c1",
        body: "Imported discussion",
        author: { name: "Historical Author" },
        createdAt: "2026-08-01T03:00:00.000Z",
        updatedAt: "2026-08-01T04:00:00.000Z",
        quotedText: "Historical quote",
      }],
      "AND-1": [],
    },
  };
}

test("Linear import preserves identifiers, hierarchy, labels, relations and views", () => {
  const plan: LinearImportPlan = buildLinearImportPlan(
    "usr_test",
    fixture(),
  );
  assert.equal(plan.projects.length, 1);
  assert.equal(plan.releases.length, 1);
  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.taskLabels.length, 1);
  assert.equal(plan.relations.length, 2);
  assert.equal(plan.views.length, 1);

  const child = plan.tasks.find((task) => task.sourceId === "AND-2");
  const parent = plan.tasks.find((task) => task.sourceId === "AND-1");
  assert.ok(child);
  assert.ok(parent);
  assert.equal(child.identifier, "PRO-2");
  assert.equal(parent.identifier, "PRO-1");
  assert.equal(plan.projects[0].taskCode, "PRO");
  assert.equal(plan.projects[0].taskSequence, 2);
  assert.equal(plan.projects[0].codeLockedAt, "2026-08-01T00:00:00.000Z");
  assert.equal(child.parentTaskId, parent.id);
  assert.equal(child.priority, "urgent");
  assert.equal(child.releaseId, plan.releases[0].id);
  assert.equal(plan.views[0].display.layout, "board");
  assert.ok(plan.views[0].query.conditions?.some(
    (condition) => condition.field === "project" && condition.value === plan.projects[0].id,
  ));
  assert.ok(plan.views[0].query.conditions?.some(
    (condition) => condition.field === "release" && condition.value === plan.releases[0].id,
  ));
  assert.equal(
    plan.statuses.find((status) => status.name === "Duplicate")?.category,
    "canceled",
  );

  const childSource = plan.externalRecords.find(
    (record) => record.targetType === "task" && record.sourceId === "AND-2",
  );
  assert.ok(childSource);
  assert.match(childSource.metadataJson, /"stateHistory"/);
  assert.match(childSource.metadataJson, /"Evidence"/);
  assert.match(childSource.metadataJson, /"Imported discussion"/);
  assert.equal(plan.historicalComments.length, 1);
  assert.equal(plan.historicalComments[0]?.authorName, "Historical Author");
  assert.equal(plan.historicalComments[0]?.quotedText, "Historical quote");
  assert.equal(plan.commentMigrationOutcomes[0]?.outcome, "migrated");
  assert.equal(plan.historicalActivityEvents.length, 1);
  assert.equal(plan.historicalActivityEvents[0]?.actorName, "Historical Operator");
  assert.equal(plan.historicalActivityEvents[0]?.eventType, "status_changed");
  assert.equal(plan.activityMigrationOutcomes[0]?.outcome, "migrated");
  assert.equal(plan.activityMigrationOutcomes[1]?.outcome, "exception");
  assert.equal(
    plan.activityMigrationOutcomes[1]?.reason,
    "activity_timestamp_missing",
  );
});

test("Linear import rejects relations across Projects", () => {
  const payload = fixture();
  const projects = payload.projects as Array<Record<string, unknown>>;
  projects.push({
    ...projects[0]!,
    id: "p2",
    name: "Other Project",
    milestones: [],
  });
  const issues = payload.issues as Array<Record<string, unknown>>;
  issues[0]!.projectId = "p2";
  issues[0]!.projectMilestone = null;
  issues[0]!.parentId = null;

  assert.throws(
    () => buildLinearImportPlan("usr_test", payload),
    /crosses Projects/,
  );
});

test("Linear import writes Project identifiers and aliases idempotently", async () => {
  const harness = await createD1TestHarness();
  try {
    const owner = await getOrCreateUser({
      provider: "chatgpt",
      providerAccountKey: "linear-import-owner",
      displayName: "Linear Import Owner",
      email: "linear-import-owner@example.test",
    });
    const first = await importLinearWorkspace(owner, fixture());
    const second = await importLinearWorkspace(owner, fixture());
    assert.equal(first.tasks, 2);
    assert.equal(first.activityMigrated, 1);
    assert.equal(first.activityExceptions, 1);
    assert.deepEqual(second, first);

    const project = await harness.database.prepare(
      `SELECT task_code, task_sequence, code_locked_at
       FROM projects WHERE owner_user_id = ?`,
    ).bind(owner.id).first<{
      task_code: string;
      task_sequence: number;
      code_locked_at: string | null;
    }>();
    assert.deepEqual(project, {
      task_code: "PRO",
      task_sequence: 2,
      code_locked_at: "2026-08-01T00:00:00.000Z",
    });
    const tasks = await harness.database.prepare(
      `SELECT t.identifier, alias.identifier AS alias_identifier
       FROM tasks t JOIN task_identifier_aliases alias ON alias.task_id = t.id
       WHERE t.owner_user_id = ? ORDER BY t.identifier`,
    ).bind(owner.id).all<{ identifier: string; alias_identifier: string }>();
    assert.deepEqual(
      tasks.results.map((row) => [row.identifier, row.alias_identifier]),
      [["PRO-1", "AND-1"], ["PRO-2", "AND-2"]],
    );
    const historical = await harness.database.prepare(
      `SELECT c.source, c.author_user_id, c.historical_author_name,
         c.historical_quoted_text, c.created_at, t.comment_count
       FROM comments c JOIN tasks t ON t.id = c.task_id
       WHERE c.source = 'linear'`,
    ).all<Record<string, unknown>>();
    assert.deepEqual(historical.results, [{
      source: "linear",
      author_user_id: null,
      historical_author_name: "Historical Author",
      historical_quoted_text: "Historical quote",
      created_at: "2026-08-01T03:00:00.000Z",
      comment_count: 1,
    }]);
    const outcomes = await harness.database.prepare(
      `SELECT outcome, reason, comment_id FROM comment_migration_outcomes`,
    ).all<Record<string, unknown>>();
    assert.equal(outcomes.results.length, 1);
    assert.equal(outcomes.results[0]?.outcome, "migrated");
    assert.ok(outcomes.results[0]?.comment_id);
    const activity = await harness.database.prepare(
      `SELECT ae.source, ae.actor_kind, ae.actor_name, ae.event_type,
         ae.payload_json, amo.outcome, amo.reason
       FROM activity_migration_outcomes amo
       LEFT JOIN activity_events ae ON ae.id = amo.activity_event_id
       ORDER BY amo.source_index`,
    ).all<Record<string, unknown>>();
    assert.equal(activity.results.length, 2);
    assert.deepEqual(activity.results[0], {
      source: "linear",
      actor_kind: "historical",
      actor_name: "Historical Operator",
      event_type: "status_changed",
      payload_json: JSON.stringify({
        changes: { status: { before: "Todo", after: "Done" } },
        sourceTimestamp: "2026-08-03T00:00:00.000Z",
      }),
      outcome: "migrated",
      reason: null,
    });
    assert.equal(activity.results[1]?.outcome, "exception");
    assert.equal(activity.results[1]?.reason, "activity_timestamp_missing");
    const eventCount = await harness.database.prepare(
      "SELECT COUNT(*) AS count FROM activity_events WHERE source = 'linear'",
    ).first<{ count: number }>();
    assert.equal(eventCount?.count, 1);
  } finally {
    await harness.dispose();
  }
});

test("Linear import rejects missing hierarchy targets before writing", () => {
  const value = fixture();
  const issues = value.issues as Array<Record<string, unknown>>;
  issues[0].parentId = "AND-999";
  assert.throws(
    () => buildLinearImportPlan("usr_test", value),
    ValidationError,
  );
});

test("Linear import rejects an issue without an explicit Project mapping", () => {
  const value = fixture();
  const issues = value.issues as Array<Record<string, unknown>>;
  issues[0].projectId = null;
  assert.throws(
    () => buildLinearImportPlan("usr_test", value),
    /explicit Project mapping/,
  );
});

test("Linear import rejects cyclic parent hierarchies before writing", () => {
  const value = fixture();
  const issues = value.issues as Array<Record<string, unknown>>;
  issues[1].parentId = "AND-2";
  assert.throws(
    () => buildLinearImportPlan("usr_test", value),
    ValidationError,
  );
});

test("Linear import rejects impossible calendar dates", () => {
  const value = fixture();
  const projects = value.projects as Array<Record<string, unknown>>;
  projects[0].targetDate = "2026-02-29";
  assert.throws(
    () => buildLinearImportPlan("usr_test", value),
    ValidationError,
  );
});

test("Linear import enforces its limit on the bytes actually received", () => {
  assert.deepEqual(
    decodeLinearImportPayload(new TextEncoder().encode('{"version":1}')),
    { tooLarge: false, payload: { version: 1 } },
  );
  assert.deepEqual(
    decodeLinearImportPayload(new TextEncoder().encode("not json")),
    { tooLarge: false, payload: null },
  );
  assert.deepEqual(
    decodeLinearImportPayload(new Uint8Array(maxLinearImportBytes + 1)),
    { tooLarge: true, payload: null },
  );
});
