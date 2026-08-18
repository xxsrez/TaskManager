import assert from "node:assert/strict";
import test from "node:test";
import { planImportedComments } from "../lib/imported-comments";

const base = {
  ownerUserId: "usr_owner",
  taskId: "task_1",
  taskSourceId: "LIN-1",
  sourceRecordId: "external_task_1",
  reconciledAt: "2026-08-18T00:00:00.000Z",
};

test("historical comment planning preserves authors, quotes, order, and reply topology", () => {
  const plan = planImportedComments({
    ...base,
    comments: [
      {
        id: "reply-2",
        body: "Nested historical reply",
        author: { name: "Grace" },
        createdAt: "2026-08-03T00:00:00Z",
        updatedAt: "2026-08-03T01:00:00Z",
        parentId: "reply-1",
      },
      {
        id: "root-1",
        body: "Historical root",
        author: { name: "Ada" },
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-01T01:00:00Z",
        quotedText: "Original quote",
      },
      {
        id: "reply-1",
        body: "Historical reply",
        author: { name: "Linus" },
        createdAt: "2026-08-02T00:00:00Z",
        updatedAt: "2026-08-02T01:00:00Z",
        parentId: "root-1",
      },
    ],
  });

  assert.deepEqual(plan.inventory, {
    total: 3,
    migrated: 3,
    exceptions: 0,
    roots: 1,
    replies: 2,
    authors: 3,
  });
  assert.deepEqual(plan.comments.map((comment) => comment.sourceCommentId), [
    "root-1",
    "reply-1",
    "reply-2",
  ]);
  assert.equal(plan.comments[0]?.authorName, "Ada");
  assert.equal(plan.comments[0]?.quotedText, "Original quote");
  assert.equal(plan.comments[2]?.parentCommentId, plan.comments[0]?.id);
  assert.equal(plan.comments[2]?.sourceParentCommentId, "reply-1");
  assert.match(plan.outcomes[0]?.reason ?? "", /nested_reply_flattened/);
});

test("historical comment planning records every malformed or ambiguous source row", () => {
  const duplicate = {
    id: "duplicate",
    body: "One",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  };
  const plan = planImportedComments({
    ...base,
    comments: [
      duplicate,
      { ...duplicate, body: "Two" },
      { id: "orphan", body: "Orphan", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", parentId: "missing" },
      { id: "bad-time", body: "Bad", createdAt: "not-a-date", updatedAt: "2026-08-01T00:00:00Z" },
      "not-an-object",
    ],
  });

  assert.equal(plan.comments.length, 0);
  assert.equal(plan.inventory.total, 5);
  assert.equal(plan.inventory.exceptions, 5);
  assert.deepEqual(plan.outcomes.map((outcome) => outcome.reason), [
    "duplicate_source_comment_id",
    "duplicate_source_comment_id",
    "missing_parent_comment",
    "comment_timestamp_invalid",
    "comment_not_object",
  ]);
  assert.ok(plan.outcomes.every((outcome) => outcome.rawJson.length > 0));
});

test("historical comment IDs and reconciliation outcomes are deterministic", () => {
  const comments = [{
    id: "c1",
    body: "Imported discussion",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  }];
  const first = planImportedComments({ ...base, comments });
  const second = planImportedComments({ ...base, comments });
  assert.deepEqual(second, first);
  assert.equal(first.comments[0]?.authorName, "Unknown Linear user");
  assert.equal(first.outcomes[0]?.reason, "author_name_missing");
});

test("invalid comment collections remain visible as reconciliation exceptions", () => {
  const plan = planImportedComments({ ...base, comments: { broken: true } });
  assert.equal(plan.comments.length, 0);
  assert.equal(plan.outcomes[0]?.reason, "invalid_comment_collection");
  assert.equal(plan.outcomes[0]?.sourceIndex, -1);
});
