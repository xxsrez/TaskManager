import assert from "node:assert/strict";
import test from "node:test";
import { ValidationError } from "../lib/domain";
import {
  isProjectTaskCode,
  normalizeProjectTaskCode,
  suggestProjectTaskCode,
} from "../lib/project-task-code";

test("Project task codes share one 1-12 character validation and normalization contract", () => {
  const valid = [
    ["a", "A"],
    ["  web-2  ", "WEB-2"],
    ["A1", "A1"],
    ["ABC-DEF-123", "ABC-DEF-123"],
    ["123456789012", "123456789012"],
  ] as const;
  for (const [input, expected] of valid) {
    assert.equal(normalizeProjectTaskCode(input), expected);
    assert.equal(isProjectTaskCode(expected), true);
  }

  for (const input of [
    "",
    "-ABC",
    "ABC-",
    "ABC DEF",
    "ABC_DEF",
    "ÁBC",
    "1234567890123",
  ]) {
    assert.throws(
      () => normalizeProjectTaskCode(input),
      (error: unknown) => error instanceof ValidationError &&
        error.message === "Project code must use 1 to 12 Latin letters, digits, or internal hyphens",
    );
    assert.equal(isProjectTaskCode(input), false);
  }
  assert.throws(() => normalizeProjectTaskCode(null), /Project code is required/);
});

test("Project task code suggestions remain valid while using the expanded range", () => {
  assert.equal(suggestProjectTaskCode("Task Manager"), "TM");
  assert.equal(suggestProjectTaskCode("Homeostat"), "HOMEOSTAT");
  assert.equal(suggestProjectTaskCode("Platform 2 Delivery"), "P2D");
  assert.equal(suggestProjectTaskCode("Платформа"), "PR");
  assert.equal(isProjectTaskCode(suggestProjectTaskCode("one two three four five six seven eight nine ten eleven twelve thirteen")), true);
});
