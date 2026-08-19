import assert from "node:assert/strict";
import test from "node:test";
import {
  RECENT_NAVIGATION_LIMIT,
  selectRecentNavigation,
} from "../lib/recent-navigation";

const records = [
  { id: "b", updatedAt: "2026-08-19T12:00:00.000Z", archivedAt: null },
  { id: "d", updatedAt: "2026-08-19T11:00:00.000Z", archivedAt: null },
  { id: "c", updatedAt: "2026-08-19T12:00:00.000Z", archivedAt: null },
  { id: "a", updatedAt: "2026-08-19T10:00:00.000Z", archivedAt: null },
  { id: "z", updatedAt: "2026-08-20T12:00:00.000Z", archivedAt: "2026-08-20T13:00:00.000Z" },
];

test("recent navigation uses updatedAt DESC and id DESC with a hard limit", () => {
  assert.equal(RECENT_NAVIGATION_LIMIT, 3);
  assert.deepEqual(
    selectRecentNavigation(records).map((record) => record.id),
    ["c", "b", "d"],
  );
});

test("recent navigation injects an active record without exceeding the limit", () => {
  assert.deepEqual(
    selectRecentNavigation(records, { activeId: "a" }).map((record) => record.id),
    ["a", "c", "b"],
  );
});

test("recent navigation excludes archived and missing active records", () => {
  assert.deepEqual(
    selectRecentNavigation(records, { activeId: "z" }).map((record) => record.id),
    ["c", "b", "d"],
  );
  assert.deepEqual(
    selectRecentNavigation(records, { activeId: "removed" }).map((record) => record.id),
    ["c", "b", "d"],
  );
});
