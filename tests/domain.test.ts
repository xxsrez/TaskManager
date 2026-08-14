import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReleaseProject,
  optionalDate,
  optionalEstimate,
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

test("editing a terminal task preserves its original terminal timestamp", () => {
  const completedAt = "2026-08-13T16:00:00.000Z";
  const canceledAt = "2026-08-13T17:00:00.000Z";

  assert.deepEqual(
    statusTimestamps(
      "completed",
      { startedAt: null, completedAt, canceledAt: null },
      "2026-08-14T00:00:00.000Z",
    ),
    { startedAt: null, completedAt, canceledAt: null },
  );
  assert.deepEqual(
    statusTimestamps(
      "canceled",
      { startedAt: null, completedAt: null, canceledAt },
      "2026-08-14T00:00:00.000Z",
    ),
    { startedAt: null, completedAt: null, canceledAt },
  );
});

test("local dates reject impossible calendar values", () => {
  assert.equal(optionalDate("2024-02-29"), "2024-02-29");
  assert.throws(() => optionalDate("2026-02-29"), ValidationError);
  assert.throws(() => optionalDate("2026-13-01"), ValidationError);
  assert.throws(() => optionalDate("2026-04-31"), ValidationError);
});

test("estimates are either absent or positive integer points", () => {
  assert.equal(optionalEstimate(null), null);
  assert.equal(optionalEstimate(1), 1);
  assert.throws(() => optionalEstimate(0), ValidationError);
  assert.throws(() => optionalEstimate(1.5), ValidationError);
  assert.throws(() => optionalEstimate(true), ValidationError);
});

test("release and task project must match", () => {
  assert.doesNotThrow(() => assertReleaseProject("project_a", "project_a"));
  assert.throws(
    () => assertReleaseProject("project_a", "project_b"),
    ValidationError,
  );
});
