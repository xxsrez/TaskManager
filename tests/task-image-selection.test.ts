import assert from "node:assert/strict";
import test from "node:test";
import {
  createTaskImageSelection,
  replaceSelectedTaskImageWidth,
  resolveTaskImageSelection,
} from "../lib/task-image-selection";
import {
  buildTaskImageToken,
  parseTaskImageReferences,
} from "../lib/task-description-format";

const ref = "88ff4153-cb23-4043-aab8-6fbc97800762";

test("selected same-ref embed follows its token when distinct occurrences are reordered", () => {
  const first = buildTaskImageToken(ref, "First diagram", "First caption", 240);
  const second = buildTaskImageToken(ref, "Second diagram", "Second caption", 720);
  const original = `First block\n${first}\nSecond block\n${second}`;
  const selected = createTaskImageSelection(
    original,
    parseTaskImageReferences(original)[1]!,
  );

  const reordered = `Second block\n${second}\nFirst block\n${first}`;
  const resolved = resolveTaskImageSelection(reordered, selected);
  assert.equal(resolved?.alt, "Second diagram");
  assert.equal(resolved?.start, reordered.indexOf(second));

  const resized = replaceSelectedTaskImageWidth(reordered, selected, 480);
  assert.match(resized!.value, /Second diagram[^\n]+\{width=480\}/);
  assert.match(resized!.value, /First diagram[^\n]+\{width=240\}/);
});

test("identical same-ref embeds retain selection through edits before their distinct context", () => {
  const token = buildTaskImageToken(ref, "Repeated diagram", null, 480);
  const original = `Alpha context\n${token}\nBeta context\n${token}\nTail`;
  const selected = createTaskImageSelection(
    original,
    parseTaskImageReferences(original)[1]!,
  );
  const edited = `Intro\nAlpha context\n${token}\nBeta context updated\n${token}\nTail`;

  const resolved = resolveTaskImageSelection(edited, selected);
  assert.equal(resolved?.start, edited.lastIndexOf(token));
});
