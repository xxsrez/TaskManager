import assert from "node:assert/strict";
import test from "node:test";
import {
  commentBodyPreview,
  visibleCommentAttachmentRefs,
} from "../lib/comment-rendering";
import {
  buildTaskFileLink,
  buildTaskImageToken,
} from "../lib/task-description-format";

const imageRef = "11111111-1111-4111-8111-111111111111";
const fileRef = "22222222-2222-4222-8222-222222222222";

test("collapsed comment previews never split or resolve a hidden attachment token", () => {
  const hiddenImage = buildTaskImageToken(imageRef, "Tall diagram", "Request flow", 480);
  const body = `${"Long context ".repeat(110)}${hiddenImage}\nAfter`;
  const preview = commentBodyPreview(body, 1_200);

  assert.equal(preview.truncated, true);
  assert.ok(preview.body.endsWith("…"));
  assert.doesNotMatch(preview.body, /attachment:v1:/);
  assert.deepEqual(visibleCommentAttachmentRefs(preview.body), []);
  assert.deepEqual(visibleCommentAttachmentRefs(body), [imageRef]);
});

test("a preview boundary inside an attachment token never exposes a partial native URL", () => {
  const file = buildTaskFileLink(fileRef, "A very long attachment filename.pdf");
  const preview = commentBodyPreview(file, 24);

  assert.deepEqual(preview, { body: "…", truncated: true });
  assert.doesNotMatch(preview.body, /attachment:v1:|\[[^\]]*$/);
});

test("visible comment refs are unique and ignore code, fences, and escaped examples", () => {
  const file = buildTaskFileLink(fileRef, "Design notes.pdf");
  const image = buildTaskImageToken(imageRef, "Wide diagram");
  const body = [
    image,
    file,
    file,
    `\`${buildTaskFileLink("33333333-3333-4333-8333-333333333333", "literal.pdf")}\``,
    "```md",
    buildTaskFileLink("44444444-4444-4444-8444-444444444444", "fenced.pdf"),
    "```",
    `\\${buildTaskFileLink("55555555-5555-4555-8555-555555555555", "escaped.pdf")}`,
  ].join("\n");

  assert.deepEqual(visibleCommentAttachmentRefs(body), [imageRef, fileRef]);
  assert.deepEqual(commentBodyPreview("Short body", 1_200), {
    body: "Short body",
    truncated: false,
  });
});
