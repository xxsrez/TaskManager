import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCommentAttachmentMetadataResult,
  loadCommentAttachmentMetadata,
  mergeCommentAttachmentRefs,
} from "../lib/comment-attachment-metadata-loader";

function refs(count: number, offset = 0) {
  return Array.from(
    { length: count },
    (_, index) => `attachment-${String(index + offset).padStart(4, "0")}`,
  );
}

test("mounted comment refs are deterministically deduplicated into requests of at most 100", async () => {
  const firstComment = refs(70);
  const secondComment = [...refs(10, 60), ...refs(75, 70)];
  const visibleRefs = mergeCommentAttachmentRefs([firstComment, secondComment]);
  const calls: string[][] = [];
  let active = 0;
  let maxActive = 0;

  const result = await loadCommentAttachmentMetadata({
    refs: visibleRefs,
    loadChunk: async (chunk) => {
      calls.push(chunk);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return chunk.map((ref) => ({ ref }));
    },
  });

  assert.equal(visibleRefs.length, 145);
  assert.deepEqual(calls.map((chunk) => chunk.length), [100, 45]);
  assert.ok(calls.every((chunk) => chunk.length <= 100));
  assert.ok(maxActive <= 2);
  assert.equal(result.failedRefs.length, 0);
  assert.equal(result.resolvedRefs.length, 145);
});

test("one failed chunk retains partial success and an exact retry recovers without remount", async () => {
  const visibleRefs = refs(205);
  const attempts = new Map<string, number>();
  const loadChunk = async (chunk: string[]) => {
    const key = chunk[0]!;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    if (key === visibleRefs[100] && attempt === 1) throw new Error("transient");
    return chunk.map((ref) => ({ ref }));
  };

  const first = await loadCommentAttachmentMetadata({ refs: visibleRefs, loadChunk });
  assert.equal(first.records.size, 105);
  assert.deepEqual(first.resolvedRefs, [...visibleRefs.slice(0, 100), ...visibleRefs.slice(200)]);
  assert.deepEqual(first.failedRefs, visibleRefs.slice(100, 200));

  const retry = await loadCommentAttachmentMetadata({
    refs: first.failedRefs,
    loadChunk,
  });
  const recovered = new Map([...first.records, ...retry.records]);
  assert.equal(retry.failedRefs.length, 0);
  assert.equal(recovered.size, 205);
  assert.equal(attempts.get(visibleRefs[0]!), 1);
  assert.equal(attempts.get(visibleRefs[100]!), 2);
  assert.equal(attempts.get(visibleRefs[200]!), 1);
});

test("transient failure retains known metadata while an authoritative omission clears it", () => {
  const stale = { ref: "attachment-stale" };
  const success = { ref: "attachment-success" };
  const partial = applyCommentAttachmentMetadataResult(
    {
      loaded: new Set<string>(),
      records: new Map([[stale.ref, stale]]),
    },
    {
      failedRefs: [stale.ref],
      records: new Map([[success.ref, success]]),
      resolvedRefs: [success.ref],
    },
  );

  assert.equal(partial.records.get(stale.ref), stale);
  assert.equal(partial.records.get(success.ref), success);
  assert.equal(partial.loaded.has(stale.ref), false);
  assert.equal(partial.loaded.has(success.ref), true);

  const omitted = applyCommentAttachmentMetadataResult(partial, {
    failedRefs: [],
    records: new Map(),
    resolvedRefs: [stale.ref],
  });
  assert.equal(omitted.records.has(stale.ref), false);
  assert.equal(omitted.loaded.has(stale.ref), true);
});
