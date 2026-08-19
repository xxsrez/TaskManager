import assert from "node:assert/strict";
import test from "node:test";
import {
  keyboardCommandFor,
  reconcileTaskInteraction,
  selectTaskRange,
  toggleTaskSelection,
} from "../lib/task-keyboard";

const event = (
  key: string,
  overrides: Partial<Parameters<typeof keyboardCommandFor>[0]> = {},
) => ({ key, ...overrides });

test("maps macOS and Control shortcuts without stealing browser variants", () => {
  assert.equal(keyboardCommandFor(event("b", { metaKey: true })), "toggle-layout");
  assert.equal(keyboardCommandFor(event("B", { ctrlKey: true })), "toggle-layout");
  assert.equal(keyboardCommandFor(event("v", { shiftKey: true })), "display");
  assert.equal(keyboardCommandFor(event("x", { shiftKey: true })), "extend-selection");
  assert.equal(keyboardCommandFor(event("k", { metaKey: true })), "contextual-actions");
  assert.equal(keyboardCommandFor(event("i", { ctrlKey: true })), "toggle-details");
  assert.equal(keyboardCommandFor(event("f", { metaKey: true })), null);
  assert.equal(keyboardCommandFor(event("b", { altKey: true })), null);
});

test("keeps global shortcuts out of editors, composing input, and owned layers", () => {
  const input = { tagName: "INPUT", isContentEditable: false };
  const markdown = {
    tagName: "DIV",
    isContentEditable: false,
    closest: (selector: string) => selector.includes("data-keyboard-editor") ? {} : null,
  };
  assert.equal(keyboardCommandFor(event("c", { target: input as unknown as EventTarget })), null);
  assert.equal(keyboardCommandFor(event("x", { target: markdown as unknown as EventTarget })), null);
  assert.equal(keyboardCommandFor(event("j", { isComposing: true })), null);
  assert.equal(keyboardCommandFor(event("j", { defaultPrevented: true })), null);
  assert.equal(keyboardCommandFor(event("Escape", { defaultPrevented: true })), null);
  assert.equal(keyboardCommandFor(event("j"), { layerOwnsKeyboard: true }), null);
  assert.equal(keyboardCommandFor(event("Escape"), { layerOwnsKeyboard: true }), "escape");
});

test("distinguishes highlight, toggle selection, and stable-anchor range selection", () => {
  const ordered = ["a", "b", "c", "d", "e"];
  const first = toggleTaskSelection(new Set(), null, "b");
  assert.deepEqual([...first.selected], ["b"]);
  assert.equal(first.anchorId, "b");

  const ranged = selectTaskRange(first.selected, first.anchorId, "d", ordered);
  assert.deepEqual([...ranged.selected], ["b", "c", "d"]);
  assert.equal(ranged.anchorId, "b");

  const extendedBack = selectTaskRange(ranged.selected, ranged.anchorId, "a", ordered);
  assert.deepEqual([...extendedBack.selected], ["a", "b", "c", "d"]);
  assert.equal(extendedBack.anchorId, "b");
});

test("range and select-all never include non-selectable or non-visible records", () => {
  const result = selectTaskRange(
    new Set(["hidden"]),
    "a",
    "d",
    ["a", "b", "c", "d"],
    new Set(["a", "c", "d"]),
  );
  assert.deepEqual([...result.selected], ["a", "c", "d"]);
});

test("reconciles interaction state after filter, sync removal, and pagination changes", () => {
  const result = reconcileTaskInteraction(
    {
      highlightedId: "c",
      selected: new Set(["b", "c", "hidden"]),
      anchorId: "b",
    },
    ["a", "b", "d"],
    new Set(["a", "b", "d"]),
    ["a", "b", "c", "d"],
  );
  assert.equal(result.highlightedId, "d");
  assert.deepEqual([...result.selected], ["b"]);
  assert.equal(result.anchorId, "b");

  const removedAnchor = reconcileTaskInteraction(
    { highlightedId: "b", selected: new Set(["b"]), anchorId: "b" },
    ["a", "d"],
    new Set(["a", "d"]),
    ["a", "b", "d"],
  );
  assert.equal(removedAnchor.highlightedId, "d");
  assert.equal(removedAnchor.anchorId, null);
  assert.deepEqual([...removedAnchor.selected], []);
});
