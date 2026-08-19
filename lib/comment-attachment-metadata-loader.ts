export const COMMENT_ATTACHMENT_REFS_PER_REQUEST = 100;
export const COMMENT_ATTACHMENT_REQUEST_CONCURRENCY = 2;

export type CommentAttachmentMetadata = { ref: string };
export type CommentAttachmentMetadataResult<T extends CommentAttachmentMetadata> = {
  failedRefs: string[];
  records: Map<string, T>;
  resolvedRefs: string[];
};

export function mergeCommentAttachmentRefs(
  consumers: Iterable<readonly string[]>,
): string[] {
  return [...new Set([...consumers].flat())].sort();
}

export async function loadCommentAttachmentMetadata<T extends CommentAttachmentMetadata>({
  refs,
  loadChunk,
  chunkSize = COMMENT_ATTACHMENT_REFS_PER_REQUEST,
  concurrency = COMMENT_ATTACHMENT_REQUEST_CONCURRENCY,
}: {
  refs: readonly string[];
  loadChunk: (refs: string[]) => Promise<T[]>;
  chunkSize?: number;
  concurrency?: number;
}): Promise<CommentAttachmentMetadataResult<T>> {
  const boundedChunkSize = Math.max(1, Math.min(
    COMMENT_ATTACHMENT_REFS_PER_REQUEST,
    Math.floor(chunkSize),
  ));
  const requested = [...new Set(refs)];
  const chunks = Array.from(
    { length: Math.ceil(requested.length / boundedChunkSize) },
    (_, index) => requested.slice(
      index * boundedChunkSize,
      (index + 1) * boundedChunkSize,
    ),
  );
  const results = new Array<{ attachments?: T[]; failed: boolean }>(chunks.length);
  let cursor = 0;

  async function worker() {
    while (cursor < chunks.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { attachments: await loadChunk(chunks[index]!), failed: false };
      } catch {
        results[index] = { failed: true };
      }
    }
  }

  const workerCount = Math.min(
    chunks.length,
    Math.max(1, Math.min(
      COMMENT_ATTACHMENT_REQUEST_CONCURRENCY,
      Math.floor(concurrency),
    )),
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const failedRefs: string[] = [];
  const resolvedRefs: string[] = [];
  const records = new Map<string, T>();
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    const result = results[index]!;
    if (result.failed) {
      failedRefs.push(...chunk);
      continue;
    }
    resolvedRefs.push(...chunk);
    const requestedChunk = new Set(chunk);
    for (const attachment of result.attachments ?? []) {
      if (requestedChunk.has(attachment.ref)) records.set(attachment.ref, attachment);
    }
  }
  return { failedRefs, records, resolvedRefs };
}

export function applyCommentAttachmentMetadataResult<T extends CommentAttachmentMetadata>(
  cache: { loaded: ReadonlySet<string>; records: ReadonlyMap<string, T> },
  result: CommentAttachmentMetadataResult<T>,
): { loaded: Set<string>; records: Map<string, T> } {
  const loaded = new Set(cache.loaded);
  const records = new Map(cache.records);
  for (const ref of result.resolvedRefs) {
    loaded.add(ref);
    records.delete(ref);
  }
  for (const [ref, attachment] of result.records) records.set(ref, attachment);
  return { loaded, records };
}
