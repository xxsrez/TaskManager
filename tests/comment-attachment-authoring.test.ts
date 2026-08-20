import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommentAttachmentAuthoring } from "../components/comment-attachment-authoring";
import {
  buildCommentAttachmentToken,
  commentUploadBlocksSubmit,
  createCommentUploadCandidate,
  insertCommentAttachmentToken,
  rebaseCommentAttachmentInsertion,
  removeCommentAttachmentInsertion,
} from "../lib/comment-attachment-authoring";

const image = {
  ref: "image-reference-123",
  filename: "Схема [v2].png",
  kind: "image" as const,
};

const document = {
  ref: "file-reference-456",
  filename: "Очень длинный отчёт [финал].pdf",
  kind: "file" as const,
};

test("comment attachment authoring builds editable image alt and file labels from Unicode filenames", () => {
  assert.equal(
    buildCommentAttachmentToken(image),
    "![Схема [v2)](attachment:v1:image-reference-123)",
  );
  assert.equal(
    buildCommentAttachmentToken(document),
    "[Очень длинный отчёт [финал).pdf](attachment:v1:file-reference-456)",
  );
});

test("comment attachment authoring inserts image blocks and file links at the current cursor", () => {
  const imageInsert = insertCommentAttachmentToken("BeforeAfter", 6, image);
  assert.equal(
    imageInsert.value,
    "Before\n![Схема [v2)](attachment:v1:image-reference-123)\nAfter",
  );
  assert.equal(imageInsert.value.slice(imageInsert.cursor), "After");

  const fileInsert = insertCommentAttachmentToken("Readtoday", 4, document);
  assert.equal(
    fileInsert.value,
    "Read [Очень длинный отчёт [финал).pdf](attachment:v1:file-reference-456) today",
  );
  assert.equal(fileInsert.value.slice(fileInsert.cursor), "today");
});

test("mixed image and file uploads keep the image on its own Markdown line", () => {
  const imageInsert = insertCommentAttachmentToken("", 0, image);
  const fileInsert = insertCommentAttachmentToken(
    imageInsert.value,
    imageInsert.cursor,
    document,
  );

  assert.equal(
    fileInsert.value,
    "![Схема [v2)](attachment:v1:image-reference-123)\n" +
      "[Очень длинный отчёт [финал).pdf](attachment:v1:file-reference-456)",
  );
});

test("removing a ready upload removes only its inserted draft token", () => {
  const upload = insertCommentAttachmentToken("First\nKeep", 5, document);
  const gallery = insertCommentAttachmentToken(upload.value, upload.cursor, document);
  const rebased = rebaseCommentAttachmentInsertion(
    upload.value,
    gallery.value,
    upload.insertion,
  );
  assert.ok(rebased);

  const removed = removeCommentAttachmentInsertion(gallery.value, rebased);
  assert.equal(removed.removed, true);
  assert.equal(
    removed.value,
    "First [Очень длинный отчёт [финал).pdf](attachment:v1:file-reference-456)\nKeep",
  );
});

test("upload insertion identity rebases after cursor edits before an identical token", () => {
  const upload = insertCommentAttachmentToken("Before", 0, document);
  const edited = `Cursor edit: ${upload.value}`;
  const rebased = rebaseCommentAttachmentInsertion(
    upload.value,
    edited,
    upload.insertion,
  );
  assert.ok(rebased);
  assert.equal(
    edited.slice(rebased.tokenStart, rebased.tokenEnd),
    buildCommentAttachmentToken(document),
  );
  assert.deepEqual(removeCommentAttachmentInsertion(edited, rebased), {
    value: "Cursor edit: Before",
    removed: true,
  });
});

test("queued, active, processing, failed, and canceled uploads block submit until removed or ready", () => {
  for (const state of ["queued", "uploading", "processing", "failed", "canceled"] as const) {
    assert.equal(commentUploadBlocksSubmit(state), true, state);
  }
  assert.equal(commentUploadBlocksSubmit("ready"), false);
});

test("upload candidate keeps one attachment idempotency key across retry", () => {
  const file = new File(["pdf"], "report.pdf", { type: "application/pdf" });
  const candidate = createCommentUploadCandidate(file, 3, () => "stable-random-id");
  assert.equal(candidate.id, "stable-random-id");
  assert.equal(candidate.idempotencyKey, "comment-attachment:stable-random-id");
  assert.equal(candidate.insertionPoint, 3);
  assert.equal(candidate.status, "queued");

  const retry = { ...candidate, status: "uploading" as const };
  assert.equal(retry.idempotencyKey, candidate.idempotencyKey);
});

test("editable root, reply, and edit composition exposes picker, gallery, multi-file and accessible status hooks", () => {
  const textareaRef = createRef<HTMLTextAreaElement>();
  const markup = renderToStaticMarkup(createElement(
    CommentAttachmentAuthoring,
    {
      taskId: "task-a",
      value: "Draft",
      onChange: () => undefined,
      textareaRef,
      disabled: false,
    },
    createElement("textarea", { ref: textareaRef, "aria-label": "Comment body" }),
  ));

  assert.match(markup, /aria-label="Attach files"/);
  assert.match(markup, /Attach files \(Cmd\/Ctrl\+Shift\+A\)/);
  assert.match(markup, /aria-label="Choose files for this comment"/);
  assert.match(markup, /type="file"[^>]*multiple=""/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, />Task files</);
  assert.match(markup, /Drop or paste files/);
});

test("comment attachment authoring keeps long filenames bounded and mobile actions at 44px", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.comment-attachment-uploads b[^}]*text-overflow: ellipsis/);
  assert.match(css, /\.comment-upload-icon, \.comment-upload-actions button \{ width: 44px; height: 44px; \}/);
  assert.match(css, /\.comment-attachment-gallery select, \.comment-attachment-gallery \.button \{ min-height: 44px; \}/);
});
