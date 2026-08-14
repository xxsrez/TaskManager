import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { linearApplyGuardBindings, linearApplyGuardSql } from "../lib/linear-migration-sql";
import { selectLinearScope } from "../lib/linear-scope";
import type { LoadedLinearSnapshot } from "../lib/linear-oauth";

test("Linear project scope keeps only selected project issues and dependencies", () => {
  const scoped = selectLinearScope(snapshot(), { mode: "projects", ids: ["project-a"] });
  assert.deepEqual(scoped.issues.map((issue) => issue.identifier), ["LIN-1"]);
  assert.deepEqual(scoped.projects.map((project) => project.id), ["project-a"]);
  assert.deepEqual(scoped.statuses.map((status) => status.id), ["status-todo"]);
  assert.deepEqual(scoped.labels.map((label) => label.id), ["label-bug"]);
});

test("Linear assignee scope means assigned issues, not creator, and external parent is warning-only", () => {
  const scoped = selectLinearScope(snapshot(), { mode: "assignees", ids: ["user-b"] });
  assert.deepEqual(scoped.issues.map((issue) => issue.identifier), ["LIN-2"]);
  assert.match(scoped.warnings.join(" "), /parent link/i);
  assert.match(scoped.warnings.join(" "), /custom views/i);
});

test("Linear apply guard rejects a staged target now owned by another user", () => {
  const database = migratedDatabase();
  database.prepare(`INSERT INTO projects
    (id, public_id, owner_user_id, creator_user_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("project-a", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "other-user", "other-user", "Foreign", "2026-08-14", "2026-08-14");
  database.prepare("INSERT INTO user_import_rows (import_id, row_type, ordinal, row_json) VALUES (?, 'projects', 0, ?)")
    .run("linear-import:test", JSON.stringify({ id: "project-a", lead_user_id: null }));
  assert.throws(
    () => database.prepare(linearApplyGuardSql).run(...linearApplyGuardBindings("linear-import:test", "user-owner")),
    /NOT NULL constraint failed/i,
  );
  database.close();
});

function snapshot(): LoadedLinearSnapshot {
  const connection = (nodes: Record<string, unknown>[]) => ({ nodes, pageInfo: { hasNextPage: false } });
  const baseIssue = {
    title: "Issue", description: "", priority: 0, priorityLabel: "No priority", estimate: null,
    sortOrder: 1, url: "https://linear.app/example", branchName: null,
    createdAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:00:00.000Z",
    archivedAt: null, startedAt: null, completedAt: null, canceledAt: null, dueDate: null,
    creator: { id: "user-a", name: "A", email: "a@example.com" },
    projectMilestone: null,
    relations: connection([]), inverseRelations: connection([]), attachments: connection([]),
    comments: connection([]), stateHistory: connection([]),
  };
  return {
    inventory: {
      sessionId: "linear-import:test",
      organization: { id: "org", name: "Workspace", urlKey: "workspace" },
      viewer: { id: "user-a", name: "A", email: "a@example.com" },
      users: [
        { id: "user-a", name: "A", email: "a@example.com", active: true },
        { id: "user-b", name: "B", email: "b@example.com", active: true },
      ],
      projects: [
        { id: "project-a", name: "A", archivedAt: null },
        { id: "project-b", name: "B", archivedAt: null },
      ],
      counts: { users: 2, projects: 2, statuses: 1, labels: 1, views: 1, issues: 2 },
      warnings: [], expiresAt: "2026-08-15T00:00:00.000Z",
    },
    users: [
      { id: "user-a", name: "A", email: "a@example.com", active: true },
      { id: "user-b", name: "B", email: "b@example.com", active: true },
    ],
    projects: [
      { id: "project-a", name: "A", description: "", status: { type: "started" }, projectMilestones: connection([]) },
      { id: "project-b", name: "B", description: "", status: { type: "started" }, projectMilestones: connection([]) },
    ],
    statuses: [{ id: "status-todo", name: "Todo", type: "unstarted", color: "#aaa", position: 1 }],
    labels: [{ id: "label-bug", name: "Bug", color: "#f00" }],
    views: [{ id: "view-a", name: "A board", projects: connection([{ id: "project-a", name: "A" }]), userViewPreferences: { preferences: { layout: "board" } } }],
    issues: [
      {
        ...baseIssue, id: "issue-1", identifier: "LIN-1", project: { id: "project-a", name: "A" },
        assignee: { id: "user-a", name: "A", email: "a@example.com" }, parent: null,
        state: { id: "status-todo", name: "Todo", type: "unstarted" },
        labels: connection([{ id: "label-bug", name: "Bug", color: "#f00" }]),
      },
      {
        ...baseIssue, id: "issue-2", identifier: "LIN-2", project: { id: "project-b", name: "B" },
        assignee: { id: "user-b", name: "B", email: "b@example.com" },
        parent: { id: "issue-1", identifier: "LIN-1" },
        state: { id: "status-todo", name: "Todo", type: "unstarted" }, labels: connection([]),
      },
    ],
  };
}

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "0000_chilly_malice.sql", "0001_wide_skreet.sql", "0002_stiff_madame_hydra.sql",
    "0003_green_white_queen.sql", "0004_large_rocket_racer.sql", "0005_mixed_bruce_banner.sql",
    "0006_polite_randall_flagg.sql",
  ]) database.exec(readFileSync(join(process.cwd(), "drizzle", migration), "utf8"));
  return database;
}
