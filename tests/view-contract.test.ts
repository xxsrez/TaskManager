import assert from "node:assert/strict";
import test from "node:test";
import { ValidationError } from "../lib/domain";
import {
  validateViewDisplay,
  validateViewQuery,
} from "../lib/view-contract";

test("saved view input accepts the supported query and display contract", () => {
  assert.deepEqual(
    validateViewQuery({
      search: "release",
      priorities: ["urgent", "high"],
      archived: false,
      updatedWithinHours: 6,
    }),
    {
      search: "release",
      priorities: ["urgent", "high"],
      archived: false,
      updatedWithinHours: 6,
    },
  );
  assert.equal(validateViewDisplay({ layout: "board" }).layout, "board");
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
