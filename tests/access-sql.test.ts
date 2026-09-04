import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  accessibleTaskWhere,
  editableTaskWhere,
  projectAccessRoleSql,
  savedViewAccessRoleSql,
  taskAccessRoleSql,
} from "../lib/access-sql";

test("ACL SQL fragments preserve their principal placeholder contracts", () => {
  assert.equal(placeholders(accessibleTaskWhere("task_row")), 4);
  assert.equal(placeholders(editableTaskWhere("task_row")), 4);
  assert.equal(placeholders(taskAccessRoleSql("task_row", "project_row")), 4);
  assert.equal(placeholders(projectAccessRoleSql("project_row")), 2);
  assert.equal(placeholders(savedViewAccessRoleSql("view_row", "project_row")), 4);
});

test("ACL SQL fragments accept identifiers only as aliases", () => {
  assert.match(accessibleTaskWhere("task_row"), /task_row\.project_id/);
  assert.throws(() => accessibleTaskWhere("tasks; DELETE FROM tasks"), /Invalid SQL alias/);
  assert.throws(() => taskAccessRoleSql("tasks", "projects p"), /Invalid SQL alias/);
});

test("legacy full_access grants normalize to the current effective roles", () => {
  assert.match(taskAccessRoleSql("task_row", "project_row"), /WHEN 'full_access' THEN 3/);
  assert.match(savedViewAccessRoleSql("view_row", "project_row"), /WHEN 'full_access' THEN 2/);
  assert.match(editableTaskWhere("task_row"), /WHEN 'full_access' THEN 3/);
});

test("Team role fragments require active membership, active Team, and active grant routes", () => {
  const task = taskAccessRoleSql("task_row", "project_row");
  assert.match(task, /team_task_grant\.resource_type = 'project'/);
  assert.match(task, /team_task_grant\.resource_type = 'task'/);
  assert.match(task, /access_membership\.status = 'active'/);
  assert.match(task, /access_membership\.deactivated_at IS NULL/);
  assert.match(task, /access_team\.archived_at IS NULL/);
  assert.match(task, /team_task_grant\.revoked_at IS NULL/);
  assert.match(projectAccessRoleSql("project_row"), /MAX\(/);
});

test("legacy standalone Task owner and direct grants remain queryable and mutable", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, owner_user_id TEXT, deleted_at TEXT);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT, owner_user_id TEXT,
      title TEXT, deleted_at TEXT
    );
    CREATE TABLE access_grants (
      resource_type TEXT, resource_id TEXT, grantee_user_id TEXT,
      permission TEXT, revoked_at TEXT
    );
    CREATE TABLE teams (id TEXT PRIMARY KEY, archived_at TEXT);
    CREATE TABLE team_memberships (
      team_id TEXT, user_id TEXT, status TEXT, deactivated_at TEXT
    );
    CREATE TABLE team_grants (
      team_id TEXT, resource_type TEXT, resource_id TEXT,
      permission TEXT, revoked_at TEXT
    );
    INSERT INTO tasks (id, project_id, owner_user_id, title, deleted_at)
    VALUES ('standalone', NULL, 'owner', 'Legacy standalone', NULL);
    INSERT INTO access_grants
      (resource_type, resource_id, grantee_user_id, permission, revoked_at)
    VALUES ('task', 'standalone', 'collaborator', 'editor', NULL);
  `);

  const owner = ["owner", "owner", "owner", "owner"];
  const collaborator = ["collaborator", "collaborator", "collaborator", "collaborator"];
  assert.equal(database.prepare(
    `SELECT id FROM tasks WHERE id = ? AND ${accessibleTaskWhere("tasks")}`,
  ).get("standalone", ...owner)?.id, "standalone");
  assert.equal(database.prepare(
    `SELECT id FROM tasks WHERE id = ? AND ${editableTaskWhere("tasks")}`,
  ).get("standalone", ...collaborator)?.id, "standalone");
  assert.equal(database.prepare(
    `SELECT ${taskAccessRoleSql("task", "project")} AS role
     FROM tasks task LEFT JOIN projects project ON project.id = task.project_id
     WHERE task.id = ?`,
  ).get(...collaborator, "standalone")?.role, "editor");

  const mutation = database.prepare(
    `UPDATE tasks SET title = ?
     WHERE id = ? AND ${editableTaskWhere("tasks")}`,
  ).run("Edited through legacy direct ACL", "standalone", ...collaborator);
  assert.equal(mutation.changes, 1);
  database.exec("UPDATE access_grants SET permission = 'viewer'");
  assert.equal(database.prepare(
    `SELECT id FROM tasks WHERE id = ? AND ${accessibleTaskWhere("tasks")}`,
  ).get("standalone", ...collaborator)?.id, "standalone");
  assert.equal(database.prepare(
    `SELECT id FROM tasks WHERE id = ? AND ${editableTaskWhere("tasks")}`,
  ).get("standalone", ...collaborator), undefined);
});

test("repository fallback and Agent catalogs preserve ACL-scoped Tasks", () => {
  const repository = [
    "../lib/repository.ts",
    "../lib/repository-views.ts",
    "../lib/repository-workspace.ts",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
  const agent = readFileSync(
    new URL("../lib/agent-api-repository.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    repository,
    /CASE WHEN t\.project_id IS NOT NULL THEN p\.owner_user_id\s+ELSE t\.owner_user_id END AS workspace_owner_user_id/,
  );
  assert.match(repository, /FROM tasks t\s+LEFT JOIN projects p ON p\.id = t\.project_id\s+LEFT JOIN releases r/);
  assert.match(repository, /LEFT JOIN projects catalog_task_project\s+ON catalog_task_project\.id = catalog_task\.project_id/);
  assert.match(agent, /SELECT 1 FROM tasks t\s+LEFT JOIN projects p ON p\.id = t\.project_id\s+WHERE t\.status_id = s\.id/);
  const catalogScopeStart = agent.indexOf("const agentCatalogScopeCte = `");
  const catalogScopeEnd = agent.indexOf("`;", catalogScopeStart);
  assert.ok(catalogScopeStart >= 0 && catalogScopeEnd > catalogScopeStart);
  const catalogScope = agent.slice(catalogScopeStart, catalogScopeEnd);
  assert.match(catalogScope, /visible_catalog_tasks\(id\) AS MATERIALIZED/);
  assert.match(
    catalogScope,
    /FROM tasks t\s+LEFT JOIN projects p ON p\.id = t\.project_id\s+CROSS JOIN agent_actor/,
  );
  assert.match(
    catalogScope,
    /\$\{taskEffectiveRoleRankSql\("t", "p", "agent_actor\.id"\)\} > 0/,
  );
});

function placeholders(value: string): number {
  return value.match(/\?/g)?.length ?? 0;
}
