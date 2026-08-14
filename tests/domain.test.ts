import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReleaseProject,
  priority,
  requireTitle,
  statusTimestamps,
  ValidationError,
} from "../lib/domain";

test("a task title is trimmed and required", () => {
  assert.equal(requireTitle("  Ship first release  "), "Ship first release");
  assert.throws(() => requireTitle("  "), ValidationError);
});

test("priority rejects values outside the stable catalog", () => {
  assert.equal(priority("urgent"), "urgent");
  assert.throws(() => priority("critical"), ValidationError);
});

test("status transitions update terminal timestamps atomically", () => {
  const now = "2026-08-14T00:00:00.000Z";
  const current = {
    startedAt: "2026-08-13T12:00:00.000Z",
    completedAt: "2026-08-13T16:00:00.000Z",
    canceledAt: null,
  };
  assert.deepEqual(statusTimestamps("canceled", current, now), {
    startedAt: current.startedAt,
    completedAt: null,
    canceledAt: now,
  });
  assert.deepEqual(statusTimestamps("unstarted", current, now), {
    startedAt: current.startedAt,
    completedAt: null,
    canceledAt: null,
  });
});

test("release and task project must match", () => {
  assert.doesNotThrow(() => assertReleaseProject("project_a", "project_a"));
  assert.throws(
    () => assertReleaseProject("project_a", "project_b"),
    ValidationError,
  );
});
