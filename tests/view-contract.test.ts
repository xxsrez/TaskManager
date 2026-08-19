import assert from "node:assert/strict";
import test from "node:test";
import { ValidationError } from "../lib/domain";
import {
  defaultViewDisplay,
  validateViewDisplay,
  validateViewQuery,
} from "../lib/view-contract";
import {
  decodeTemporaryViewQuery,
  encodeTemporaryViewQuery,
} from "../lib/task-filter";

test("saved view input accepts the supported query and display contract", () => {
  assert.deepEqual(
    validateViewQuery({
      search: "release",
      priorities: ["urgent", "high"],
      archived: false,
      updatedWithinHours: 6,
    }),
    {
      version: 1,
      op: "all",
      conditions: [
        { field: "priority", operator: "in", value: ["urgent", "high"] },
        { field: "archived", operator: "is", value: false },
        { field: "updated_at", operator: "recent", value: 6 },
      ],
      search: "release",
    },
  );
  assert.equal(validateViewDisplay({ layout: "board" }).layout, "board");
  assert.equal(validateViewDisplay({ groupBy: "assignee" }).groupBy, "assignee");
});

test("built-in task surfaces default to priority order", () => {
  assert.deepEqual(defaultViewDisplay(), {
    layout: "list",
    groupBy: "status",
    orderBy: "priority",
    direction: "asc",
    showEmptyGroups: true,
    visibleFields: ["priority", "project", "release", "dueDate", "assignee"],
  });
});

test("saved view input validates every canonical filter family and reserves the query version", () => {
  const query = validateViewQuery({
    version: 1,
    op: "all",
    conditions: [
      { field: "status_category", operator: "in", value: ["started", "completed"] },
      { field: "assignee", operator: "is_empty" },
      { field: "label", operator: "not_in", value: ["label-a"] },
      { field: "estimate", operator: "gte", value: 3 },
      { field: "due_date", operator: "next_7_days" },
      { field: "parent", operator: "is", value: "task-parent" },
      { field: "subtasks", operator: "is", value: true },
      { field: "relation", operator: "is", value: { type: "blocks", direction: "outgoing" } },
      { field: "created_at", operator: "on_or_after", value: "2026-08-01" },
      { field: "archived", operator: "is", value: false },
    ],
  });
  assert.equal(query.conditions.length, 10);
  assert.throws(
    () => validateViewQuery({ version: 2, op: "all", conditions: [] }),
    ValidationError,
  );
  assert.throws(
    () => validateViewQuery({ version: 1, op: "any", conditions: [] }),
    ValidationError,
  );
  assert.throws(
    () => validateViewQuery({ version: 1, op: "all", conditions: [{ field: "due_date", operator: "recent", value: 4 }] }),
    ValidationError,
  );
  assert.throws(
    () => validateViewQuery({ version: 1, op: "all", conditions: [{ field: "due_date", operator: "on", value: "2026-02-30" }] }),
    ValidationError,
  );
});

test("saved view input rejects values that can poison the client snapshot", () => {
  assert.throws(
    () => validateViewQuery({ statusIds: { invalid: true } }),
    ValidationError,
  );
  assert.throws(
    () => validateViewQuery({ priorities: ["critical"] }),
    ValidationError,
  );
  assert.throws(
    () => validateViewDisplay({ groupBy: { invalid: true } }),
    ValidationError,
  );
  assert.throws(
    () => validateViewDisplay({ visibleFields: ["description"] }),
    ValidationError,
  );
});

test("temporary filters round-trip through one bounded URL value", () => {
  const query = validateViewQuery({
    version: 1,
    op: "all",
    conditions: [{ field: "priority", operator: "is", value: "high" }],
    search: "release candidate",
  });
  const encoded = encodeTemporaryViewQuery(query);
  assert.ok(encoded.length > 0);
  assert.deepEqual(decodeTemporaryViewQuery(encoded), query);
  assert.deepEqual(decodeTemporaryViewQuery("not-valid"), {
    version: 1,
    op: "all",
    conditions: [],
  });
});
