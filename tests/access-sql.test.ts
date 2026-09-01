import assert from "node:assert/strict";
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

function placeholders(value: string): number {
  return value.match(/\?/g)?.length ?? 0;
}
