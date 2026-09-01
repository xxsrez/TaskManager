import assert from "node:assert/strict";
import test from "node:test";
import {
  accessibleTaskWhere,
  editableProjectWhere,
  editableTaskWhere,
  projectAccessRoleSql,
  savedViewAccessRoleSql,
  taskAccessRoleSql,
} from "../lib/access-sql";

test("ACL SQL fragments preserve their principal placeholder contracts", () => {
  assert.equal(placeholders(accessibleTaskWhere("task_row")), 4);
  assert.equal(placeholders(editableTaskWhere("task_row")), 4);
  assert.equal(placeholders(editableProjectWhere("project_row")), 2);
  assert.equal(placeholders(taskAccessRoleSql("task_row", "project_row")), 4);
  assert.equal(placeholders(projectAccessRoleSql("project_row")), 2);
  assert.equal(placeholders(savedViewAccessRoleSql("view_row", "project_row")), 4);
});

test("ACL SQL fragments accept identifiers only as aliases", () => {
  assert.match(accessibleTaskWhere("task_row"), /task_row\.project_id/);
  assert.throws(() => accessibleTaskWhere("tasks; DELETE FROM tasks"), /Invalid SQL alias/);
  assert.throws(() => taskAccessRoleSql("tasks", "projects p"), /Invalid SQL alias/);
  assert.throws(() => editableProjectWhere("projects; DROP TABLE projects"), /Invalid SQL alias/);
});

test("legacy full_access grants normalize to the current effective roles", () => {
  assert.match(taskAccessRoleSql("task_row", "project_row"), /WHEN 'full_access' THEN 'manager'/);
  assert.match(savedViewAccessRoleSql("view_row", "project_row"), /WHEN 'full_access' THEN 'editor'/);
  assert.match(editableTaskWhere("task_row"), /'editor', 'manager', 'full_access'/);
});

function placeholders(value: string): number {
  return value.match(/\?/g)?.length ?? 0;
}
