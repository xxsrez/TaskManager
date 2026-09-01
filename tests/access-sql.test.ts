import assert from "node:assert/strict";
import test from "node:test";
import {
  accessibleProjectWhere,
  accessibleSavedViewWhere,
  accessibleTaskWhere,
  editableProjectWhere,
  editableSavedViewWhere,
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
  assert.equal(placeholders(accessibleProjectWhere("project_row")), 2);
  assert.equal(placeholders(editableProjectWhere("project_row")), 2);
  assert.equal(placeholders(editableSavedViewWhere("view_row", "project_row")), 4);
  assert.equal(placeholders(accessibleSavedViewWhere("view_row", "project_row")), 4);
});

test("ACL SQL fragments accept identifiers only as aliases", () => {
  assert.match(accessibleTaskWhere("task_row"), /task_row\.project_id/);
  assert.throws(() => accessibleTaskWhere("tasks; DELETE FROM tasks"), /Invalid SQL alias/);
  assert.throws(() => taskAccessRoleSql("tasks", "projects p"), /Invalid SQL alias/);
});

test("legacy full_access grants normalize to the current effective roles", () => {
  assert.match(taskAccessRoleSql("task_row", "project_row"), /WHEN 'full_access' THEN 3/);
  assert.match(savedViewAccessRoleSql("view_row", "project_row"), /WHEN 'full_access' THEN 2/);
  assert.match(editableTaskWhere("task_row"), /WHEN 'editor' THEN 2/);
  assert.match(projectAccessRoleSql("project_row"), /team_memberships/);
  assert.match(taskAccessRoleSql("task_row", "project_row"), /resource_type = 'task'/);
  assert.match(savedViewAccessRoleSql("view_row", "project_row"), /MAX\(candidate\.role_rank\)/);
});

function placeholders(value: string): number {
  return value.match(/\?/g)?.length ?? 0;
}
