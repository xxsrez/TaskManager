import { canEditContent } from "./access";
import { ConflictError, NotFoundError, PermissionError, ValidationError } from "./domain";
import { getTask } from "./repository";
import { getD1 } from "@/db";
import type {
  CommentAttachmentReference,
  CommentPage,
  CommentReactionSummary,
  CommentRecord,
  CommentThreadRecord,
  TaskRecord,
  UserRecord,
} from "./types";
import {
  activityBatchAssertion,
  activityEventAfterPreviousChange,
} from "./activity-write";
import {
  descriptionAttachmentRequirements,
  type DescriptionAttachmentRequirement,
  validateTaskDescriptionAttachments,
} from "./task-description-attachments";

type DbRow = Record<string, unknown>;

const MAX_COMMENT_BODY = 100_000;
const MAX_ROOT_PAGE = 50;
const MAX_REPLIES_PER_THREAD = 100;
const MAX_COMMENT_ATTACHMENT_REFS = 100;
const MONOTONIC_TASK_UPDATED_AT = `CASE
  WHEN updated_at >= ?
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds')
  ELSE ? END`;

export function normalizeCommentBody(value: unknown) {
  if (typeof value !== "string") {
    throw new ValidationError("Comment body is required");
  }
  const body = value.replace(/\r\n?/g, "\n").trim();
  if (!body) throw new ValidationError("Comment body cannot be empty");
  if (body.length > MAX_COMMENT_BODY) {
    throw new ValidationError(`Comment body is limited to ${MAX_COMMENT_BODY} characters`);
  }
  for (const character of body) {
    const code = character.charCodeAt(0);
    if (code === 0 || (code < 32 && code !== 9 && code !== 10) || code === 127) {
      throw new ValidationError("Comment body contains unsupported control characters");
    }
  }
  return body;
}

export async function listTaskComments(
  currentUser: UserRecord,
  taskReference: string,
  input: { limit?: number; cursor?: string | null } = {},
): Promise<CommentPage> {
  const task = await getTask(currentUser, taskReference);
  const limit = boundedLimit(input.limit);
  const after = input.cursor ? decodeCommentCursor(input.cursor, task.id) : null;
  const predicates = ["c.task_id = ?", "c.parent_comment_id IS NULL"];
  const parameters: unknown[] = [task.id];
  if (after) {
    predicates.push("(c.created_at > ? OR (c.created_at = ? AND c.id > ?))");
    parameters.push(after.createdAt, after.createdAt, after.id);
  }
  parameters.push(limit + 1);
  const roots = await getD1()
    .prepare(
      `SELECT c.* FROM comments c
       WHERE ${predicates.join(" AND ")}
       ORDER BY c.created_at, c.id LIMIT ?`,
    )
    .bind(...parameters)
    .all<DbRow>();
  const hasMore = roots.results.length > limit;
  const visibleRoots = roots.results.slice(0, limit);
  if (!visibleRoots.length) {
    return {
      threads: [],
      totalCount: task.commentCount,
      nextCursor: null,
      hasMore: false,
    };
  }

  const rootIds = visibleRoots.map((row) => String(row.id));
  const placeholders = rootIds.map(() => "?").join(", ");
  const replies = await getD1()
    .prepare(
      `WITH ranked AS (
         SELECT c.*, ROW_NUMBER() OVER (
           PARTITION BY c.parent_comment_id ORDER BY c.created_at, c.id
         ) AS reply_rank
         FROM comments c WHERE c.parent_comment_id IN (${placeholders})
       )
       SELECT * FROM ranked WHERE reply_rank <= ?
       ORDER BY parent_comment_id, created_at, id`,
    )
    .bind(...rootIds, MAX_REPLIES_PER_THREAD)
    .all<DbRow>();
  return buildPage(currentUser, task, visibleRoots, replies.results, hasMore);
}

export async function getCommentThread(
  currentUser: UserRecord,
  taskReference: string,
  commentId: string,
): Promise<CommentThreadRecord> {
  const task = await getTask(currentUser, taskReference);
  const selected = await loadCommentRow(task.id, commentId);
  const rootId = selected.parent_comment_id ? String(selected.parent_comment_id) : String(selected.id);
  const [root, replies] = await Promise.all([
    loadCommentRow(task.id, rootId),
    getD1()
      .prepare(
        `SELECT * FROM comments WHERE task_id = ? AND parent_comment_id = ?
         ORDER BY created_at, id LIMIT ?`,
      )
      .bind(task.id, rootId, MAX_REPLIES_PER_THREAD)
      .all<DbRow>(),
  ]);
  const records = await hydrateComments(currentUser, task, [root, ...replies.results]);
  return { root: records[0]!, replies: records.slice(1) };
}

export async function createComment(
  currentUser: UserRecord,
  taskReference: string,
  input: Record<string, unknown>,
): Promise<CommentRecord> {
  const task = await editableTask(currentUser, taskReference);
  const body = normalizeCommentBody(input.body);
  const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey);
  const existing = await getD1()
    .prepare(
      `SELECT id FROM comments
       WHERE task_id = ? AND author_user_id = ? AND idempotency_key = ?`,
    )
    .bind(task.id, currentUser.id, idempotencyKey)
    .first<{ id: string }>();
  if (existing) return getCommentRecord(currentUser, task, existing.id);

  let parentCommentId: string | null = null;
  if (input.parentCommentId !== undefined && input.parentCommentId !== null) {
    const parent = await loadCommentRow(task.id, String(input.parentCommentId));
    parentCommentId = parent.parent_comment_id
      ? String(parent.parent_comment_id)
      : String(parent.id);
  }
  const attachmentRequirements = await validateCommentAttachmentRequirements(
    task.id,
    body,
  );
  const id = `comment_${crypto.randomUUID()}`;
  const now = laterTimestamp(task.updatedAt);
  const db = getD1();
  const activity = activityEventAfterPreviousChange(db, currentUser, {
    taskId: task.id,
    eventType: "comment_added",
    payload: { commentId: id, parentCommentId },
    createdAt: now,
  });
  try {
    await db.batch([
      db.prepare(
      `INSERT OR IGNORE INTO comments
       (id, task_id, author_user_id, body, source, parent_comment_id,
        idempotency_key, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, 'native', ?, ?, ?, ?, 1)`,
      ).bind(
      id,
      task.id,
      currentUser.id,
      body,
      parentCommentId,
      idempotencyKey,
      now,
      now,
      ),
      ...commentAttachmentInsertStatements(
        db,
        id,
        task.id,
        body,
        attachmentRequirements,
        1,
      ),
      commentAttachmentBatchGuard(
        db,
        id,
        task.id,
        body,
        attachmentRequirements.length,
        1,
      ),
      activity.statement,
      db.prepare(
      `UPDATE comments SET resolved_at = NULL, resolved_by_user_id = NULL,
         resolution_comment_id = NULL, version = version + 1, updated_at = ?
       WHERE id = ? AND task_id = ? AND resolved_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM comments inserted WHERE inserted.id = ?)`,
      ).bind(now, parentCommentId, task.id, id),
      db.prepare(
      `UPDATE tasks SET
         comment_count = (SELECT COUNT(*) FROM comments
           WHERE task_id = ? AND deleted_at IS NULL),
         updated_at = ${MONOTONIC_TASK_UPDATED_AT}
       WHERE id = ? AND EXISTS (SELECT 1 FROM activity_events WHERE id = ?)`,
      ).bind(task.id, now, now, task.id, activity.id),
      activityBatchAssertion(
        db,
        `comment_attachment_assert_${crypto.randomUUID()}`,
        now,
      ),
    ]);
  } catch {
    const retried = await db.prepare(
      `SELECT id FROM comments
       WHERE task_id = ? AND author_user_id = ? AND idempotency_key = ?`,
    ).bind(task.id, currentUser.id, idempotencyKey).first<{ id: string }>();
    if (retried) return getCommentRecord(currentUser, task, retried.id);
    throw new ConflictError("Comment attachments changed in another session");
  }
  const inserted = await getD1()
    .prepare(
      `SELECT id FROM comments
       WHERE task_id = ? AND author_user_id = ? AND idempotency_key = ?`,
    )
    .bind(task.id, currentUser.id, idempotencyKey)
    .first<{ id: string }>();
  if (!inserted) throw new Error("Comment idempotency write failed");
  return getCommentRecord(currentUser, task, inserted.id);
}

export async function editComment(
  currentUser: UserRecord,
  taskReference: string,
  commentId: string,
  input: Record<string, unknown>,
): Promise<CommentRecord> {
  const task = await editableTask(currentUser, taskReference);
  const comment = await loadCommentRow(task.id, commentId);
  if (String(comment.source) !== "native") {
    throw new PermissionError("Historical comments are immutable");
  }
  if (String(comment.author_user_id) !== currentUser.id) {
    throw new PermissionError("Only the comment author can edit this comment");
  }
  if (comment.deleted_at) throw new ValidationError("Deleted comments cannot be edited");
  assertVersion(input.version, comment.version);
  const body = normalizeCommentBody(input.body);
  if (body === String(comment.body)) return getCommentRecord(currentUser, task, commentId);
  const attachmentRequirements = await validateCommentAttachmentRequirements(
    task.id,
    body,
  );
  const now = laterTimestamp(String(comment.updated_at));
  const taskNow = laterTimestamp(task.updatedAt);
  const db = getD1();
  const activity = activityEventAfterPreviousChange(db, currentUser, {
    taskId: task.id,
    eventType: "comment_edited",
    payload: { commentId },
    createdAt: taskNow,
  });
  const attachmentPredicate = commentAttachmentPredicate(attachmentRequirements);
  try {
    await db.batch([
      db.prepare(
        `DELETE FROM comment_attachment_refs
         WHERE comment_id = ? AND task_id = ?
           AND EXISTS (
             SELECT 1 FROM comments current_comment
             WHERE current_comment.id = comment_attachment_refs.comment_id
               AND current_comment.task_id = comment_attachment_refs.task_id
               AND current_comment.version = ?
           )`,
      ).bind(commentId, task.id, Number(comment.version)),
      db.prepare(
      `UPDATE comments SET body = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND task_id = ? AND version = ?
       ${attachmentPredicate.sql}`,
      ).bind(
        body,
        now,
        commentId,
        task.id,
        Number(comment.version),
        ...attachmentPredicate.bindings,
      ),
      ...commentAttachmentInsertStatements(
        db,
        commentId,
        task.id,
        body,
        attachmentRequirements,
        Number(comment.version) + 1,
      ),
      commentAttachmentBatchGuard(
        db,
        commentId,
        task.id,
        body,
        attachmentRequirements.length,
        Number(comment.version) + 1,
      ),
      activity.statement,
      db.prepare(
      `UPDATE tasks SET updated_at = ${MONOTONIC_TASK_UPDATED_AT}
       WHERE id = ? AND EXISTS (SELECT 1 FROM activity_events WHERE id = ?)`,
      ).bind(taskNow, taskNow, task.id, activity.id),
      activityBatchAssertion(
        db,
        `comment_attachment_assert_${crypto.randomUUID()}`,
        taskNow,
      ),
    ]);
  } catch {
    throw new ConflictError("Comment was changed in another session");
  }
  return getCommentRecord(currentUser, task, commentId);
}

export async function deleteComment(
  currentUser: UserRecord,
  taskReference: string,
  commentId: string,
  input: Record<string, unknown>,
): Promise<CommentRecord> {
  const task = await editableTask(currentUser, taskReference);
  const comment = await loadCommentRow(task.id, commentId);
  if (String(comment.source) !== "native") {
    throw new PermissionError("Historical comments are immutable");
  }
  const isAuthor = String(comment.author_user_id) === currentUser.id;
  const canModerate = task.accessRole === "owner" || task.accessRole === "manager";
  if (!isAuthor && !canModerate) {
    throw new PermissionError("Only the author or a task moderator can delete this comment");
  }
  assertVersion(input.version, comment.version);
  if (comment.deleted_at) return getCommentRecord(currentUser, task, commentId);
  const now = laterTimestamp(String(comment.updated_at));
  const taskNow = laterTimestamp(task.updatedAt);
  const db = getD1();
  const activity = activityEventAfterPreviousChange(db, currentUser, {
    taskId: task.id,
    eventType: "comment_deleted",
    payload: { commentId },
    createdAt: taskNow,
  });
  try {
    await db.batch([
      db.prepare(
        `DELETE FROM comment_attachment_refs
         WHERE comment_id = ? AND task_id = ?
           AND EXISTS (
             SELECT 1 FROM comments current_comment
             WHERE current_comment.id = comment_attachment_refs.comment_id
               AND current_comment.task_id = comment_attachment_refs.task_id
               AND current_comment.version = ?
           )`,
      ).bind(commentId, task.id, Number(comment.version)),
      db.prepare(
      `UPDATE comments SET body = '', deleted_at = ?, updated_at = ?,
         version = version + 1
       WHERE id = ? AND task_id = ? AND version = ?`,
      ).bind(now, now, commentId, task.id, Number(comment.version)),
      activity.statement,
      db.prepare(
      `UPDATE tasks SET comment_count = (
         SELECT COUNT(*) FROM comments WHERE task_id = ? AND deleted_at IS NULL
       ), updated_at = ${MONOTONIC_TASK_UPDATED_AT}
       WHERE id = ? AND EXISTS (SELECT 1 FROM activity_events WHERE id = ?)`,
      ).bind(task.id, taskNow, taskNow, task.id, activity.id),
      activityBatchAssertion(
        db,
        `comment_attachment_assert_${crypto.randomUUID()}`,
        taskNow,
      ),
    ]);
  } catch {
    throw new ConflictError("Comment was changed in another session");
  }
  return getCommentRecord(currentUser, task, commentId);
}

export async function resolveCommentThread(
  currentUser: UserRecord,
  taskReference: string,
  commentId: string,
  input: Record<string, unknown>,
): Promise<CommentRecord> {
  const task = await editableTask(currentUser, taskReference);
  const selected = await loadCommentRow(task.id, commentId);
  const rootId = selected.parent_comment_id ? String(selected.parent_comment_id) : String(selected.id);
  const root = rootId === selected.id ? selected : await loadCommentRow(task.id, rootId);
  assertVersion(input.version, root.version);
  if (typeof input.resolved !== "boolean") {
    throw new ValidationError("resolved must be true or false");
  }
  const resolutionCommentId = input.resolutionCommentId == null
    ? null
    : String(input.resolutionCommentId);
  if (resolutionCommentId) {
    const resolution = await loadCommentRow(task.id, resolutionCommentId);
    if (String(resolution.id) !== rootId && String(resolution.parent_comment_id) !== rootId) {
      throw new ValidationError("Resolution comment must belong to the thread");
    }
  }
  if (
    Boolean(root.resolved_at) === input.resolved &&
    (!input.resolved || nullableString(root.resolution_comment_id) === resolutionCommentId)
  ) {
    return getCommentRecord(currentUser, task, rootId);
  }
  const now = laterTimestamp(String(root.updated_at));
  const taskNow = laterTimestamp(task.updatedAt);
  const db = getD1();
  const activity = activityEventAfterPreviousChange(db, currentUser, {
    taskId: task.id,
    eventType: input.resolved ? "comment_resolved" : "comment_reopened",
    payload: { rootCommentId: rootId, resolutionCommentId },
    createdAt: taskNow,
  });
  const result = await db.batch([
    db.prepare(
      `UPDATE comments SET resolved_at = ?, resolved_by_user_id = ?,
         resolution_comment_id = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND task_id = ? AND parent_comment_id IS NULL AND version = ?`,
    ).bind(
      input.resolved ? now : null,
      input.resolved ? currentUser.id : null,
      input.resolved ? resolutionCommentId : null,
      now,
      rootId,
      task.id,
      Number(root.version),
    ),
    activity.statement,
    db.prepare(
      `UPDATE tasks SET updated_at = ${MONOTONIC_TASK_UPDATED_AT}
       WHERE id = ? AND EXISTS (SELECT 1 FROM activity_events WHERE id = ?)`,
    ).bind(taskNow, taskNow, task.id, activity.id),
  ]);
  if ((result[0]?.meta.changes ?? 0) < 1) {
    throw new ConflictError("Comment thread was changed in another session");
  }
  return getCommentRecord(currentUser, task, rootId);
}

export async function setCommentReaction(
  currentUser: UserRecord,
  taskReference: string,
  commentId: string,
  input: Record<string, unknown>,
): Promise<CommentReactionSummary[]> {
  const task = await editableTask(currentUser, taskReference);
  const comment = await loadCommentRow(task.id, commentId);
  if (comment.deleted_at) throw new ValidationError("Deleted comments cannot be reacted to");
  const emoji = normalizeEmoji(input.emoji);
  if (typeof input.active !== "boolean") {
    throw new ValidationError("active must be true or false");
  }
  const db = getD1();
  const existingReaction = await db.prepare(
    `SELECT 1 AS active FROM comment_reactions
     WHERE comment_id = ? AND user_id = ? AND emoji = ?`,
  ).bind(commentId, currentUser.id, emoji).first<{ active: number }>();
  if (Boolean(existingReaction) === input.active) {
    const reactions = await loadReactionMap([commentId], currentUser.id);
    return reactions.get(commentId) ?? [];
  }
  const taskNow = laterTimestamp(task.updatedAt);
  const activity = activityEventAfterPreviousChange(db, currentUser, {
    taskId: task.id,
    eventType: "comment_reaction_changed",
    payload: { commentId, emoji, active: input.active },
    createdAt: taskNow,
  });
  await db.batch([
    input.active
      ? db.prepare(
          `INSERT INTO comment_reactions (comment_id, user_id, emoji)
           VALUES (?, ?, ?) ON CONFLICT(comment_id, user_id, emoji) DO NOTHING`,
        ).bind(commentId, currentUser.id, emoji)
      : db.prepare(
          `DELETE FROM comment_reactions
           WHERE comment_id = ? AND user_id = ? AND emoji = ?`,
        ).bind(commentId, currentUser.id, emoji),
    activity.statement,
    db.prepare(
      `UPDATE tasks SET updated_at = ${MONOTONIC_TASK_UPDATED_AT}
       WHERE id = ? AND EXISTS (SELECT 1 FROM activity_events WHERE id = ?)`,
    ).bind(taskNow, taskNow, task.id, activity.id),
  ]);
  const reactions = await loadReactionMap([commentId], currentUser.id);
  return reactions.get(commentId) ?? [];
}

async function buildPage(
  currentUser: UserRecord,
  task: TaskRecord,
  roots: DbRow[],
  replies: DbRow[],
  hasMore: boolean,
): Promise<CommentPage> {
  const records = await hydrateComments(currentUser, task, [...roots, ...replies]);
  const byId = new Map(records.map((record) => [record.id, record]));
  const repliesByRoot = new Map<string, CommentRecord[]>();
  for (const reply of records.slice(roots.length)) {
    const values = repliesByRoot.get(reply.parentCommentId!) ?? [];
    values.push(reply);
    repliesByRoot.set(reply.parentCommentId!, values);
  }
  const threads = roots.map((row) => {
    const root = byId.get(String(row.id))!;
    return { root, replies: repliesByRoot.get(root.id) ?? [] };
  });
  const last = roots.at(-1)!;
  return {
    threads,
    totalCount: task.commentCount,
    hasMore,
    nextCursor: hasMore
      ? encodeCommentCursor(task.id, String(last.created_at), String(last.id))
      : null,
  };
}

async function hydrateComments(
  currentUser: UserRecord,
  task: TaskRecord,
  rows: DbRow[],
) {
  if (!rows.length) return [];
  const authorIds = [...new Set(rows.flatMap((row) =>
    row.author_user_id == null ? [] : [String(row.author_user_id)]
  ))];
  const users = authorIds.length
    ? await getD1()
      .prepare(
        `SELECT id, display_name FROM users WHERE id IN (${authorIds.map(() => "?").join(", ")})`,
      )
      .bind(...authorIds)
      .all<DbRow>()
    : { results: [] as DbRow[] };
  const usersById = new Map(users.results.map((row) => [String(row.id), {
    id: String(row.id),
    displayName: String(row.display_name),
  }]));
  const reactionMap = await loadReactionMap(rows.map((row) => String(row.id)), currentUser.id);
  const editable = canEditContent(task.accessRole);
  return rows.map((row): CommentRecord => {
    const source = String(row.source);
    if (source !== "native" && source !== "linear") {
      throw new Error("Comment source is unsupported");
    }
    const authorId = row.author_user_id == null ? null : String(row.author_user_id);
    const nativeAuthor = authorId ? usersById.get(authorId) : null;
    if (source === "native" && !nativeAuthor) throw new Error("Comment author is missing");
    const historicalAuthorName = nullableString(row.historical_author_name);
    if (source !== "native" && !historicalAuthorName) {
      throw new Error("Historical comment author snapshot is missing");
    }
    const deletedAt = nullableString(row.deleted_at);
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      author: source === "native"
        ? { ...nativeAuthor!, kind: "user" as const }
        : { id: null, displayName: historicalAuthorName!, kind: "historical" as const },
      body: String(row.body),
      attachmentRefs: commentAttachmentProjection(row),
      source: source === "native" ? "native" : "historical",
      historical: source === "native" ? null : {
        originalCreatedAt: String(row.historical_created_at),
        originalUpdatedAt: String(row.historical_updated_at),
        quotedText: nullableString(row.historical_quoted_text),
      },
      parentCommentId: nullableString(row.parent_comment_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deletedAt,
      resolvedAt: nullableString(row.resolved_at),
      resolutionCommentId: nullableString(row.resolution_comment_id),
      version: Number(row.version),
      reactions: reactionMap.get(String(row.id)) ?? [],
      permissions: {
        canEdit: source === "native" && editable && !deletedAt && authorId === currentUser.id,
        canDelete: source === "native" && editable && !deletedAt && (
          authorId === currentUser.id || task.accessRole === "owner" || task.accessRole === "manager"
        ),
        canReact: editable && !deletedAt,
        canResolve: editable && !row.parent_comment_id,
      },
    };
  });
}

function commentAttachmentProjection(row: DbRow): CommentAttachmentReference[] {
  if (row.source !== "native" || row.deleted_at) return [];
  return descriptionAttachmentRequirements(String(row.body)).map((requirement) => ({
    ref: requirement.ref,
    presentation: requirement.imageRequired ? "image" : "file",
  }));
}

async function getCommentRecord(
  currentUser: UserRecord,
  task: TaskRecord,
  commentId: string,
) {
  const row = await loadCommentRow(task.id, commentId);
  return (await hydrateComments(currentUser, task, [row]))[0]!;
}

async function loadCommentRow(taskId: string, commentId: string) {
  const row = await getD1()
    .prepare("SELECT * FROM comments WHERE task_id = ? AND id = ?")
    .bind(taskId, commentId)
    .first<DbRow>();
  if (!row) throw new NotFoundError("Comment not found");
  return row;
}

async function loadReactionMap(commentIds: string[], currentUserId: string) {
  const result = new Map<string, CommentReactionSummary[]>();
  if (!commentIds.length) return result;
  const placeholders = commentIds.map(() => "?").join(", ");
  const rows = await getD1()
    .prepare(
      `SELECT comment_id, emoji, COUNT(*) AS reaction_count,
         MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS current_user_reacted
       FROM comment_reactions WHERE comment_id IN (${placeholders})
       GROUP BY comment_id, emoji ORDER BY comment_id, emoji`,
    )
    .bind(currentUserId, ...commentIds)
    .all<DbRow>();
  for (const row of rows.results) {
    const commentId = String(row.comment_id);
    const values = result.get(commentId) ?? [];
    values.push({
      emoji: String(row.emoji),
      count: Number(row.reaction_count),
      reactedByCurrentUser: Number(row.current_user_reacted) === 1,
    });
    result.set(commentId, values);
  }
  return result;
}

async function validateCommentAttachmentRequirements(taskId: string, body: string) {
  const requirements = await validateTaskDescriptionAttachments(taskId, body);
  if (requirements.length > MAX_COMMENT_ATTACHMENT_REFS) {
    throw new ValidationError(
      `A comment can reference at most ${MAX_COMMENT_ATTACHMENT_REFS} attachments`,
    );
  }
  return requirements;
}

function commentAttachmentInsertStatements(
  db: D1Database,
  commentId: string,
  taskId: string,
  body: string,
  requirements: DescriptionAttachmentRequirement[],
  commentVersion: number,
) {
  return requirements.map((requirement) => db.prepare(
    `INSERT INTO comment_attachment_refs
      (comment_id, task_id, attachment_id)
     SELECT ?, ?, attachment.id FROM attachments attachment
     WHERE attachment.task_id = ? AND attachment.public_id = ?
       AND attachment.state = 'ready'
       AND (? = 0 OR attachment.kind = 'image')
       AND EXISTS (
         SELECT 1 FROM comments current_comment
         WHERE current_comment.id = ? AND current_comment.task_id = ?
           AND current_comment.body = ? AND current_comment.version = ?
           AND current_comment.source = 'native'
           AND current_comment.deleted_at IS NULL
       )`,
  ).bind(
    commentId,
    taskId,
    taskId,
    requirement.ref,
    requirement.imageRequired ? 1 : 0,
    commentId,
    taskId,
    body,
    commentVersion,
  ));
}

function commentAttachmentBatchGuard(
  db: D1Database,
  commentId: string,
  taskId: string,
  body: string,
  expectedRefCount: number,
  commentVersion: number,
) {
  return db.prepare(
    `UPDATE comments SET updated_at = updated_at
     WHERE id = ? AND task_id = ? AND body = ? AND version = ?
       AND source = 'native' AND deleted_at IS NULL
       AND (SELECT COUNT(*) FROM comment_attachment_refs ref
            WHERE ref.comment_id = comments.id
              AND ref.task_id = comments.task_id) = ?
       AND NOT EXISTS (
         SELECT 1 FROM comment_attachment_refs ref
         LEFT JOIN attachments attachment ON attachment.id = ref.attachment_id
         WHERE ref.comment_id = comments.id
           AND (ref.task_id <> comments.task_id
             OR attachment.id IS NULL
             OR attachment.task_id <> comments.task_id
             OR attachment.state <> 'ready')
       )`,
  ).bind(
    commentId,
    taskId,
    body,
    commentVersion,
    expectedRefCount,
  );
}

function commentAttachmentPredicate(
  requirements: DescriptionAttachmentRequirement[],
) {
  return {
    sql: requirements.map(() => `
      AND EXISTS (
        SELECT 1 FROM attachments comment_attachment
        WHERE comment_attachment.task_id = comments.task_id
          AND comment_attachment.public_id = ?
          AND comment_attachment.state = 'ready'
          AND (? = 0 OR comment_attachment.kind = 'image')
      )`).join(""),
    bindings: requirements.flatMap((requirement) => [
      requirement.ref,
      requirement.imageRequired ? 1 : 0,
    ]),
  };
}

async function editableTask(currentUser: UserRecord, taskReference: string) {
  const task = await getTask(currentUser, taskReference);
  if (!canEditContent(task.accessRole)) {
    throw new PermissionError("Editor access is required");
  }
  return task;
}

function boundedLimit(value: unknown) {
  const limit = value === undefined ? 25 : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROOT_PAGE) {
    throw new ValidationError(`Comment limit must be between 1 and ${MAX_ROOT_PAGE}`);
  }
  return limit;
}

function requiredIdempotencyKey(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new ValidationError("A bounded idempotency key is required");
  }
  return value.trim();
}

function normalizeEmoji(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 16 || /\s/.test(value)) {
    throw new ValidationError("Choose one emoji reaction");
  }
  return value;
}

function assertVersion(value: unknown, current: unknown) {
  const expected = Number(value);
  if (!Number.isInteger(expected) || expected !== Number(current)) {
    throw new ConflictError("Comment was changed in another session");
  }
}

function laterTimestamp(reference: string) {
  const now = Date.now();
  const previous = Date.parse(reference);
  return new Date(Number.isFinite(previous) && now <= previous ? previous + 1 : now).toISOString();
}

function nullableString(value: unknown) {
  return value == null ? null : String(value);
}

function encodeCommentCursor(taskId: string, createdAt: string, id: string) {
  return btoa(JSON.stringify({ taskId, createdAt, id }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function decodeCommentCursor(cursor: string, taskId: string) {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const value = JSON.parse(atob(padded)) as Record<string, unknown>;
    if (
      value.taskId !== taskId ||
      typeof value.createdAt !== "string" ||
      typeof value.id !== "string"
    ) throw new Error("invalid");
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new ValidationError("Comment cursor is invalid for this task");
  }
}
