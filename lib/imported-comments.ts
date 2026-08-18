export type PlannedHistoricalComment = {
  id: string;
  taskId: string;
  source: "linear";
  sourceRecordId: string;
  sourceCommentId: string;
  sourceParentCommentId: string | null;
  parentCommentId: string | null;
  authorName: string;
  body: string;
  quotedText: string | null;
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
  sourceIndex: number;
};

export type PlannedCommentMigrationOutcome = {
  id: string;
  taskId: string;
  source: "linear";
  sourceRecordId: string;
  sourceCommentId: string | null;
  sourceIndex: number;
  outcome: "migrated" | "exception";
  reason: string | null;
  commentId: string | null;
  rawJson: string;
  reconciledAt: string;
};

export type ImportedCommentPlan = {
  comments: PlannedHistoricalComment[];
  outcomes: PlannedCommentMigrationOutcome[];
  inventory: {
    total: number;
    migrated: number;
    exceptions: number;
    roots: number;
    replies: number;
    authors: number;
  };
};

type ParsedComment = {
  sourceIndex: number;
  sourceCommentId: string;
  sourceParentCommentId: string | null;
  authorName: string;
  authorMissing: boolean;
  body: string;
  quotedText: string | null;
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
  rawJson: string;
};

export function planImportedComments(input: {
  ownerUserId: string;
  taskId: string;
  taskSourceId: string;
  sourceRecordId: string;
  comments: unknown;
  reconciledAt: string;
}): ImportedCommentPlan {
  if (!Array.isArray(input.comments)) {
    const outcome = exceptionOutcome(input, -1, null, "invalid_comment_collection", input.comments);
    return {
      comments: [],
      outcomes: [outcome],
      inventory: { total: 1, migrated: 0, exceptions: 1, roots: 0, replies: 0, authors: 0 },
    };
  }

  const parsed: ParsedComment[] = [];
  const outcomes = new Map<number, PlannedCommentMigrationOutcome>();
  for (const [sourceIndex, value] of input.comments.entries()) {
    const result = parseComment(sourceIndex, value);
    if ("reason" in result) {
      outcomes.set(
        sourceIndex,
        exceptionOutcome(input, sourceIndex, result.sourceCommentId, result.reason, value),
      );
    } else {
      parsed.push(result);
    }
  }

  const idCounts = new Map<string, number>();
  for (const comment of parsed) {
    idCounts.set(comment.sourceCommentId, (idCounts.get(comment.sourceCommentId) ?? 0) + 1);
  }
  for (const comment of parsed) {
    if (idCounts.get(comment.sourceCommentId)! > 1) {
      outcomes.set(
        comment.sourceIndex,
        exceptionOutcome(
          input,
          comment.sourceIndex,
          comment.sourceCommentId,
          "duplicate_source_comment_id",
          input.comments[comment.sourceIndex],
        ),
      );
    }
  }

  const unique = parsed.filter((comment) => !outcomes.has(comment.sourceIndex));
  const bySourceId = new Map(unique.map((comment) => [comment.sourceCommentId, comment]));
  const rootBySourceId = new Map<string, ParsedComment>();
  const topologyError = new Map<string, string>();

  function resolveRoot(comment: ParsedComment): ParsedComment | null {
    const cached = rootBySourceId.get(comment.sourceCommentId);
    if (cached) return cached;
    const visited = new Set<string>();
    let current = comment;
    while (current.sourceParentCommentId) {
      if (visited.has(current.sourceCommentId)) {
        topologyError.set(comment.sourceCommentId, "cyclic_parent_topology");
        return null;
      }
      visited.add(current.sourceCommentId);
      const parent = bySourceId.get(current.sourceParentCommentId);
      if (!parent) {
        topologyError.set(comment.sourceCommentId, "missing_parent_comment");
        return null;
      }
      current = parent;
    }
    rootBySourceId.set(comment.sourceCommentId, current);
    return current;
  }

  for (const comment of unique) {
    const root = resolveRoot(comment);
    if (!root) {
      outcomes.set(
        comment.sourceIndex,
        exceptionOutcome(
          input,
          comment.sourceIndex,
          comment.sourceCommentId,
          topologyError.get(comment.sourceCommentId) ?? "invalid_parent_topology",
          input.comments[comment.sourceIndex],
        ),
      );
    }
  }

  const valid = unique.filter((comment) => !outcomes.has(comment.sourceIndex));
  const comments = valid.map((comment): PlannedHistoricalComment => {
    const root = rootBySourceId.get(comment.sourceCommentId) ?? comment;
    return {
      id: historicalCommentId(
        input.ownerUserId,
        input.taskSourceId,
        comment.sourceCommentId,
      ),
      taskId: input.taskId,
      source: "linear",
      sourceRecordId: input.sourceRecordId,
      sourceCommentId: comment.sourceCommentId,
      sourceParentCommentId: comment.sourceParentCommentId,
      parentCommentId: comment.sourceParentCommentId
        ? historicalCommentId(input.ownerUserId, input.taskSourceId, root.sourceCommentId)
        : null,
      authorName: comment.authorName,
      body: comment.body,
      quotedText: comment.quotedText,
      sourceCreatedAt: comment.sourceCreatedAt,
      sourceUpdatedAt: comment.sourceUpdatedAt,
      sourceIndex: comment.sourceIndex,
    };
  }).sort((left, right) => {
    const rootOrder = Number(Boolean(left.parentCommentId)) - Number(Boolean(right.parentCommentId));
    return rootOrder || left.sourceCreatedAt.localeCompare(right.sourceCreatedAt) || left.sourceIndex - right.sourceIndex;
  });

  for (const comment of valid) {
    const root = rootBySourceId.get(comment.sourceCommentId) ?? comment;
    const warnings = [
      ...(comment.authorMissing ? ["author_name_missing"] : []),
      ...(comment.sourceParentCommentId && root.sourceCommentId !== comment.sourceParentCommentId
        ? ["nested_reply_flattened"]
        : []),
    ];
    const commentId = historicalCommentId(
      input.ownerUserId,
      input.taskSourceId,
      comment.sourceCommentId,
    );
    outcomes.set(comment.sourceIndex, {
      id: outcomeId(input.sourceRecordId, comment.sourceIndex),
      taskId: input.taskId,
      source: "linear",
      sourceRecordId: input.sourceRecordId,
      sourceCommentId: comment.sourceCommentId,
      sourceIndex: comment.sourceIndex,
      outcome: "migrated",
      reason: warnings.length ? warnings.join(",") : null,
      commentId,
      rawJson: comment.rawJson,
      reconciledAt: input.reconciledAt,
    });
  }

  const orderedOutcomes = [...outcomes.values()].sort((left, right) => left.sourceIndex - right.sourceIndex);
  return {
    comments,
    outcomes: orderedOutcomes,
    inventory: {
      total: input.comments.length,
      migrated: comments.length,
      exceptions: orderedOutcomes.filter((outcome) => outcome.outcome === "exception").length,
      roots: comments.filter((comment) => !comment.parentCommentId).length,
      replies: comments.filter((comment) => Boolean(comment.parentCommentId)).length,
      authors: new Set(comments.map((comment) => comment.authorName)).size,
    },
  };
}

function parseComment(
  sourceIndex: number,
  value: unknown,
): ParsedComment | { reason: string; sourceCommentId: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { reason: "comment_not_object", sourceCommentId: null };
  }
  const row = value as Record<string, unknown>;
  const sourceCommentId = boundedString(row.id, 500);
  if (!sourceCommentId) return { reason: "comment_id_missing", sourceCommentId: null };
  if (typeof row.body !== "string" || !row.body.trim()) {
    return { reason: "comment_body_missing", sourceCommentId };
  }
  const sourceCreatedAt = validInstant(row.createdAt);
  const sourceUpdatedAt = validInstant(row.updatedAt);
  if (!sourceCreatedAt || !sourceUpdatedAt) {
    return { reason: "comment_timestamp_invalid", sourceCommentId };
  }
  const sourceParentCommentId = row.parentId == null
    ? null
    : boundedString(row.parentId, 500);
  if (row.parentId != null && !sourceParentCommentId) {
    return { reason: "parent_comment_id_invalid", sourceCommentId };
  }
  const author = row.author && typeof row.author === "object" && !Array.isArray(row.author)
    ? row.author as Record<string, unknown>
    : {};
  const authorName = boundedString(author.name, 500);
  const quotedText = row.quotedText == null
    ? null
    : typeof row.quotedText === "string"
      ? row.quotedText
      : null;
  if (row.quotedText != null && quotedText === null) {
    return { reason: "quoted_text_invalid", sourceCommentId };
  }
  return {
    sourceIndex,
    sourceCommentId,
    sourceParentCommentId,
    authorName: authorName ?? "Unknown Linear user",
    authorMissing: !authorName,
    body: row.body,
    quotedText,
    sourceCreatedAt,
    sourceUpdatedAt,
    rawJson: safeJson(value),
  };
}

function exceptionOutcome(
  input: {
    taskId: string;
    sourceRecordId: string;
    reconciledAt: string;
  },
  sourceIndex: number,
  sourceCommentId: string | null,
  reason: string,
  raw: unknown,
): PlannedCommentMigrationOutcome {
  return {
    id: outcomeId(input.sourceRecordId, sourceIndex),
    taskId: input.taskId,
    source: "linear",
    sourceRecordId: input.sourceRecordId,
    sourceCommentId,
    sourceIndex,
    outcome: "exception",
    reason,
    commentId: null,
    rawJson: safeJson(raw),
    reconciledAt: input.reconciledAt,
  };
}

function historicalCommentId(ownerUserId: string, taskSourceId: string, sourceCommentId: string) {
  return `linear:comment:${ownerUserId}:${taskSourceId}:${sourceCommentId}`;
}

function outcomeId(sourceRecordId: string, sourceIndex: number) {
  return `linear:comment-outcome:${sourceRecordId}:${sourceIndex}`;
}

function boundedString(value: unknown, maximum: number) {
  return typeof value === "string" && value.trim() && value.length <= maximum
    ? value.trim()
    : null;
}

function validInstant(value: unknown) {
  return typeof value === "string" && value && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ unstringifiable: true });
  }
}
