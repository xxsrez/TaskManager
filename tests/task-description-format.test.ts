import assert from "node:assert/strict";
import test from "node:test";
import { insertImageToken } from "../components/task-description-editor";
import {
  buildTaskImageToken,
  hasMalformedTaskImageReference,
  parseTaskImageLine,
  parseTaskImageReferences,
  taskDescriptionUsesAttachment,
} from "../lib/task-description-format";

test("native Task image tokens round-trip opaque refs and accessible metadata", () => {
  const ref = "88ff4153-cb23-4043-aab8-6fbc97800762";
  const token = buildTaskImageToken(ref, " Diagram ] one ", 'Caption "quoted"');
  assert.equal(
    token,
    `![Diagram ) one](attachment:v1:${ref} "Caption 'quoted'")`,
  );
  assert.deepEqual(parseTaskImageLine(token), {
    ref,
    alt: "Diagram ) one",
    caption: "Caption 'quoted'",
    token,
    start: 0,
    end: token.length,
  });
  assert.equal(taskDescriptionUsesAttachment(`Before\n${token}\nAfter`, ref), true);
  assert.equal(parseTaskImageReferences(`${token}\n${token}`).length, 2);
});

test("native Task image syntax rejects malformed markers without enabling external images", () => {
  assert.equal(hasMalformedTaskImageReference("![x](attachment:v1:short)"), true);
  assert.equal(hasMalformedTaskImageReference("![x](https://example.test/x.png)"), false);
  assert.equal(parseTaskImageLine("![x](https://example.test/x.png)"), null);
  assert.throws(() => buildTaskImageToken("../object-key", "unsafe"));
  assert.throws(() => buildTaskImageToken("valid_reference", ""));
});

test("description image upload inserts a block token at the current cursor", () => {
  const inserted = insertImageToken("BeforeAfter", 6, "![Image](attachment:v1:reference-123)");
  assert.equal(
    inserted.value,
    "Before\n![Image](attachment:v1:reference-123)\nAfter",
  );
  assert.equal(inserted.cursor, "Before\n![Image](attachment:v1:reference-123)\n".length);
});
