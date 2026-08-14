import assert from "node:assert/strict";
import test from "node:test";
import {
  canAssignRole,
  canEditContent,
  canManageGrant,
  canTransferOwnership,
  hasMinimumRole,
  normalizeGrantRole,
} from "../lib/access";

test("role hierarchy includes every weaker capability", () => {
  assert.equal(hasMinimumRole("owner", "manager"), true);
  assert.equal(hasMinimumRole("manager", "editor"), true);
  assert.equal(hasMinimumRole("editor", "viewer"), true);
  assert.equal(hasMinimumRole("viewer", "editor"), false);
  assert.equal(canEditContent("viewer"), false);
  assert.equal(canEditContent("editor"), true);
});

test("owner and manager observe their role ceilings", () => {
  assert.equal(canAssignRole("owner", "project", "manager"), true);
  assert.equal(canAssignRole("manager", "project", "editor"), true);
  assert.equal(canAssignRole("manager", "project", "viewer"), true);
  assert.equal(canAssignRole("manager", "project", "manager"), false);
  assert.equal(canManageGrant("manager", "project", "manager"), false);
  assert.equal(canAssignRole("editor", "project", "viewer"), false);
  assert.equal(canTransferOwnership("owner"), true);
  assert.equal(canTransferOwnership("manager"), false);
});

test("standalone resources allow only editor and viewer", () => {
  assert.equal(canAssignRole("owner", "task", "editor"), true);
  assert.equal(canAssignRole("owner", "saved_view", "viewer"), true);
  assert.equal(canAssignRole("owner", "task", "manager"), false);
  assert.equal(canAssignRole("manager", "saved_view", "viewer"), false);
});

test("legacy full_access fails closed into the intended role", () => {
  assert.equal(normalizeGrantRole("project", "full_access"), "manager");
  assert.equal(normalizeGrantRole("task", "full_access"), "editor");
  assert.equal(normalizeGrantRole("saved_view", "full_access"), "editor");
  assert.equal(normalizeGrantRole("task", "manager"), null);
  assert.equal(normalizeGrantRole("project", "unknown"), null);
});
