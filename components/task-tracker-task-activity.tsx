"use client";

import {
CommentAttachmentAuthoring,
} from "@/components/comment-attachment-authoring";
import {
CommentAttachmentMetadataProvider
} from "@/components/comment-attachment-metadata";
import {
commentDraftStorageKey
} from "@/components/task-tracker-state";
import {
commentBodyPreview,
} from "@/lib/comment-rendering";
import type {
ActivityEventRecord,
ActivityPage,
CommentPage,
CommentRecord,
CommentThreadRecord,
TaskRecord,
UserRecord
} from "@/lib/types";
import {
Check,
CircleDot,
MessageSquare,
MoreHorizontal
} from "lucide-react";
import {
useEffect,
useRef,
useState
} from "react";

import {
initials,
longDateTime
} from "@/components/task-tracker-dialogs";

import {
CommentMarkdown,
avatarHue,
copyCommentPermalink,
fetchCommentJson,
formatCommentSelection,
prefixCommentLines,
relativeTime,
} from "@/components/task-tracker-task-markdown";

export function TaskActivity({ task, currentUser, canWrite }: {
  task: TaskRecord;
  currentUser: UserRecord;
  canWrite: boolean;
}) {
  const [page, setPage] = useState<CommentPage | null>(null);
  const [activityPage, setActivityPage] = useState<ActivityPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [activityLoading, setActivityLoading] = useState(true);
  const [error, setError] = useState("");
  const [activityError, setActivityError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadBlocked, setUploadBlocked] = useState(false);
  const [composerEpoch, setComposerEpoch] = useState(0);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const pendingIdempotencyKeys = useRef(new Map<string, string>());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const draftKey = commentDraftStorageKey(currentUser.id, task.id, replyTo ?? undefined);

  useEffect(() => {
    const saved = window.localStorage.getItem(draftKey);
    // Local storage is the external source for an unsent per-user task/thread draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(saved ?? "");
  }, [draftKey]);

  useEffect(() => {
    if (draft) window.localStorage.setItem(draftKey, draft);
    else window.localStorage.removeItem(draftKey);
  }, [draft, draftKey]);

  async function loadComments(cursor: string | null = null, append = false) {
    setLoading(true);
    setError("");
    try {
      const next = await fetchCommentJson<CommentPage>(
        `/api/tasks/${encodeURIComponent(task.id)}/comments?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      setPage((current) => append && current ? {
        ...next,
        threads: [...current.threads, ...next.threads],
      } : next);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Comments could not be loaded");
    } finally {
      setLoading(false);
    }
  }

  async function loadActivity(cursor: string | null = null, append = false) {
    setActivityLoading(true);
    setActivityError("");
    try {
      const next = await fetchCommentJson<ActivityPage>(
        `/api/tasks/${encodeURIComponent(task.id)}/activity?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      setActivityPage((current) => append && current ? {
        ...next,
        events: [...current.events, ...next.events],
      } : next);
    } catch (requestError) {
      setActivityError(requestError instanceof Error ? requestError.message : "Activity could not be loaded");
    } finally {
      setActivityLoading(false);
    }
  }

  useEffect(() => {
    // Keep the draft, but discard the loaded page after a remote comment event.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(null);
    const timer = window.setTimeout(() => void loadComments(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.commentInvalidationCursor, task.id]);

  useEffect(() => {
    // Activity is a separate lazy projection; reload only for the open Task.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActivityPage(null);
    const timer = window.setTimeout(() => void loadActivity(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.activityInvalidationCursor, task.id]);

  useEffect(() => {
    if (!page || !window.location.hash.startsWith("#comment-")) return;
    const target = document.getElementById(window.location.hash.slice(1));
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("permalink-target");
    const timer = window.setTimeout(() => target.classList.remove("permalink-target"), 1800);
    return () => window.clearTimeout(timer);
  }, [page]);

  async function submitComment() {
    if (!canWrite || busy || uploadBlocked || !draft.trim()) return;
    const submittedDraftKey = draftKey;
    const submittedReplyTo = replyTo;
    const idempotencyKey = pendingIdempotencyKeys.current.get(submittedDraftKey) ?? crypto.randomUUID();
    pendingIdempotencyKeys.current.set(submittedDraftKey, idempotencyKey);
    setBusy(true);
    setError("");
    try {
      await fetchCommentJson<CommentRecord>(
        `/api/tasks/${encodeURIComponent(task.id)}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            body: draft,
            parentCommentId: replyTo,
            idempotencyKey,
          }),
        },
      );
      pendingIdempotencyKeys.current.delete(submittedDraftKey);
      window.localStorage.removeItem(submittedDraftKey);
      setComposerEpoch((current) => current + 1);
      setReplyTo(null);
      setDraft(submittedReplyTo
        ? window.localStorage.getItem(commentDraftStorageKey(currentUser.id, task.id)) ?? ""
        : "");
      await Promise.all([loadComments(), loadActivity()]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Comment could not be saved");
    } finally {
      setBusy(false);
    }
  }

  async function mutateComment(path: string, method: string, input: Record<string, unknown>) {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await fetchCommentJson(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      await Promise.all([loadComments(), loadActivity()]);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Comment action failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function commentPath(commentId: string, suffix = "") {
    return `/api/tasks/${encodeURIComponent(task.id)}/comments/${encodeURIComponent(commentId)}${suffix}`;
  }

  function switchComposer(threadId: string | null) {
    setReplyTo(threadId);
    setDraft(window.localStorage.getItem(
      commentDraftStorageKey(currentUser.id, task.id, threadId ?? undefined),
    ) ?? "");
  }

  const count = page?.totalCount ?? task.commentCount;
  const activityCount = activityPage?.totalCount ?? 0;
  return <section className="task-activity details-section" aria-labelledby={`activity-${task.id}`}>
    <header className="activity-header">
      <h2 id={`activity-${task.id}`}><MessageSquare size={14} />Activity</h2>
      <span>{activityCount} {activityCount === 1 ? "event" : "events"} · {count} {count === 1 ? "comment" : "comments"}</span>
    </header>
    {activityLoading && !activityPage && <p className="inline-note" role="status">Loading activity…</p>}
    {activityError && <div className="comment-error" role="alert"><span>{activityError}</span><button type="button" onClick={() => void loadActivity()}>Retry</button></div>}
    {activityPage && activityPage.events.length > 0 && <div className="activity-events">
      {activityPage.events.map((event) => <ActivityTimelineEvent key={event.id} event={event} />)}
    </div>}
    {activityPage?.hasMore && <button className="button ghost load-comments" type="button" disabled={activityLoading} onClick={() => void loadActivity(activityPage.nextCursor, true)}>{activityLoading ? "Loading…" : "Load older activity"}</button>}
    {loading && !page && <p className="inline-note" role="status">Loading comments…</p>}
    {error && <div className="comment-error" role="alert"><span>{error}</span><button type="button" onClick={() => void loadComments()}>Retry</button></div>}
    {page && page.threads.length === 0 && <p className="activity-empty">No comments yet.</p>}
    <CommentAttachmentMetadataProvider task={task}>
      <div className="comment-threads">
        {page?.threads.map((thread) => <CommentThread
          key={`${thread.root.id}:${thread.root.resolvedAt ?? "open"}`}
          taskId={task.id}
          thread={thread}
          busy={busy}
          onReply={(rootId) => {
            switchComposer(rootId);
            window.setTimeout(() => composerRef.current?.focus(), 0);
          }}
          onEdit={(comment, body) => mutateComment(commentPath(comment.id), "PATCH", { version: comment.version, body })}
          onDelete={(comment) => mutateComment(commentPath(comment.id), "DELETE", { version: comment.version })}
          onReact={(comment, emoji, active) => mutateComment(commentPath(comment.id, "/reactions"), "PUT", { emoji, active })}
          onResolve={(comment, resolved) => mutateComment(commentPath(comment.id, "/resolution"), "PUT", { version: comment.version, resolved })}
        />)}
      </div>
    </CommentAttachmentMetadataProvider>
    {page?.hasMore && <button className="button ghost load-comments" type="button" disabled={loading} onClick={() => void loadComments(page.nextCursor, true)}>{loading ? "Loading…" : "Load older threads"}</button>}
    {canWrite && <div className="comment-composer">
      <span className="comment-avatar" style={{ "--avatar-hue": avatarHue(currentUser.id) } as React.CSSProperties}>{initials(currentUser.displayName)}</span>
      <div className="comment-composer-box">
        {replyTo && <div className="reply-context"><span>Replying in thread</span><button type="button" onClick={() => switchComposer(null)}>Cancel</button></div>}
        <CommentAttachmentAuthoring
          key={`${draftKey}:${composerEpoch}`}
          taskId={task.id}
          value={draft}
          onChange={setDraft}
          textareaRef={composerRef}
          disabled={busy}
          onBlockingChange={setUploadBlocked}
        >
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void submitComment();
              }
            }}
            placeholder="Leave a comment…"
            aria-label="Comment body"
            rows={draft.includes("\n") ? 5 : 3}
          />
        </CommentAttachmentAuthoring>
        <div className="comment-composer-actions">
          <div className="comment-toolbar" role="toolbar" aria-label="Comment formatting">
            <button type="button" title="Bold" aria-label="Bold" onClick={() => formatCommentSelection(composerRef.current, setDraft, "**")}><b>B</b></button>
            <button type="button" title="Italic" aria-label="Italic" onClick={() => formatCommentSelection(composerRef.current, setDraft, "*")}><i>I</i></button>
            <button type="button" title="Inline code" aria-label="Inline code" onClick={() => formatCommentSelection(composerRef.current, setDraft, "`")}><code>&lt;/&gt;</code></button>
            <button type="button" title="Quote" aria-label="Quote" onClick={() => prefixCommentLines(composerRef.current, setDraft, "> ")}>&gt;</button>
            <button type="button" title="List" aria-label="List" onClick={() => prefixCommentLines(composerRef.current, setDraft, "- ")}>•</button>
            <button type="button" title="Link" aria-label="Link" onClick={() => formatCommentSelection(composerRef.current, setDraft, "[", "](https://)")}>↗</button>
          </div>
          <span><kbd>⌘</kbd><kbd>Enter</kbd></span>
          <button className="button primary" type="button" disabled={busy || uploadBlocked || !draft.trim()} onClick={() => void submitComment()}>{busy ? "Saving…" : uploadBlocked ? "Upload pending" : replyTo ? "Reply" : "Comment"}</button>
        </div>
      </div>
    </div>}
  </section>;
}

export function ActivityTimelineEvent({ event }: { event: ActivityEventRecord }) {
  const changes = event.payload.changes && typeof event.payload.changes === "object"
    ? event.payload.changes as Record<string, unknown>
    : null;
  const summary = changes
    ? Object.entries(changes).map(([field, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return field;
      const change = value as Record<string, unknown>;
      return `${activityFieldLabel(field)}: ${activityValue(change.before)} → ${activityValue(change.after)}`;
    }).join(" · ")
    : activityEventFallback(event);
  return <div className="activity-event">
    <span className="activity-event-icon"><CircleDot size={12} /></span>
    <div>
      <header><b>{event.actor.displayName}</b><span>{activityEventLabel(event.eventType)}</span>{event.actor.kind === "historical" && <small>Imported history</small>}<time dateTime={event.createdAt} title={longDateTime(event.createdAt)}>{relativeTime(event.createdAt)}</time></header>
      {summary && <p>{summary}</p>}
    </div>
  </div>;
}

export function activityEventLabel(value: string) {
  return ({
    task_created: "created the task",
    task_updated: "updated the task",
    task_moved: "moved the task",
    task_archived: "archived the task",
    task_restored: "restored the task",
    task_deleted: "moved the task to Recently deleted",
    task_delete_restored: "restored the task from Recently deleted",
    status_changed: "changed status",
    hierarchy_changed: "changed hierarchy",
    labels_changed: "changed labels",
    relation_created: "added a relation",
    relation_updated: "updated a relation",
    relation_deleted: "removed a relation",
    comment_added: "added a comment",
    comment_edited: "edited a comment",
    comment_deleted: "deleted a comment",
    comment_resolved: "resolved a thread",
    comment_reopened: "reopened a thread",
    comment_reaction_changed: "changed a reaction",
  } as Record<string, string>)[value] ?? value.replaceAll("_", " ");
}

export function activityFieldLabel(value: string) {
  return ({ assigneeUserId: "Assignee", dueDate: "Due date", estimate: "Estimate", parentTaskId: "Parent", project: "Project", projectId: "Project", releaseId: "Release", archivedAt: "Archive", status: "Status", priority: "Priority", identifier: "Identifier", title: "Title" } as Record<string, string>)[value] ?? value;
}

export function activityValue(value: unknown): string {
  if (value == null || value === "") return "None";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return String(record.name ?? record.identifier ?? record.id ?? "Changed");
  }
  return "Changed";
}

export function activityEventFallback(event: ActivityEventRecord) {
  if (event.eventType === "labels_changed") {
    const label = event.payload.label as Record<string, unknown> | undefined;
    return `${event.payload.active ? "Added" : "Removed"} ${String(label?.name ?? "label")}`;
  }
  if (event.eventType.startsWith("relation_")) return "Task relation changed";
  if (event.eventType.startsWith("comment_")) return "Discussion activity";
  return "";
}

export function CommentThread({ taskId, thread, busy, onReply, onEdit, onDelete, onReact, onResolve }: {
  taskId: string;
  thread: CommentThreadRecord;
  busy: boolean;
  onReply: (rootId: string) => void;
  onEdit: (comment: CommentRecord, body: string) => Promise<boolean>;
  onDelete: (comment: CommentRecord) => Promise<boolean>;
  onReact: (comment: CommentRecord, emoji: string, active: boolean) => Promise<boolean>;
  onResolve: (comment: CommentRecord, resolved: boolean) => Promise<boolean>;
}) {
  const [collapsed, setCollapsed] = useState(Boolean(thread.root.resolvedAt));
  useEffect(() => {
    const targetId = window.location.hash.slice(1);
    if (!targetId || ![thread.root, ...thread.replies].some(
      (comment) => `comment-${comment.id}` === targetId,
    )) return;
    let focusFrame = 0;
    const openFrame = window.requestAnimationFrame(() => {
      setCollapsed(false);
      focusFrame = window.requestAnimationFrame(() => {
        const target = document.getElementById(targetId);
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
    return () => {
      window.cancelAnimationFrame(openFrame);
      window.cancelAnimationFrame(focusFrame);
    };
  }, [thread]);
  return <article className={`comment-thread ${thread.root.resolvedAt ? "resolved" : ""}`}>
    {thread.root.resolvedAt && <button className="resolved-thread-toggle" type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}><Check size={13} />Resolved thread · {thread.replies.length + 1} messages</button>}
    {!collapsed && <>
      <CommentEntry taskId={taskId} comment={thread.root} rootId={thread.root.id} busy={busy} onReply={onReply} onEdit={onEdit} onDelete={onDelete} onReact={onReact} onResolve={onResolve} />
      {thread.replies.length > 0 && <div className="comment-replies">{thread.replies.map((reply) => <CommentEntry key={reply.id} taskId={taskId} comment={reply} rootId={thread.root.id} busy={busy} onReply={onReply} onEdit={onEdit} onDelete={onDelete} onReact={onReact} onResolve={onResolve} />)}</div>}
    </>}
  </article>;
}

export function CommentEntry({ taskId, comment, rootId, busy, onReply, onEdit, onDelete, onReact, onResolve }: {
  taskId: string;
  comment: CommentRecord;
  rootId: string;
  busy: boolean;
  onReply: (rootId: string) => void;
  onEdit: (comment: CommentRecord, body: string) => Promise<boolean>;
  onDelete: (comment: CommentRecord) => Promise<boolean>;
  onReact: (comment: CommentRecord, emoji: string, active: boolean) => Promise<boolean>;
  onResolve: (comment: CommentRecord, resolved: boolean) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const [editUploadBlocked, setEditUploadBlocked] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);
  const preview = commentBodyPreview(comment.body);
  const long = preview.truncated;
  const body = long && !expanded ? preview.body : comment.body;
  const isRoot = comment.parentCommentId === null;
  const permalink = `comment-${comment.id}`;
  return <div className="comment-entry" id={permalink} tabIndex={-1}>
    <span className="comment-avatar" style={{ "--avatar-hue": avatarHue(comment.author.id ?? comment.id) } as React.CSSProperties}>{initials(comment.author.displayName)}</span>
    <div className="comment-content">
      <header><b>{comment.author.displayName}</b>{comment.author.kind === "historical" && <small className="historical-comment-badge">Imported history</small>}<time dateTime={comment.createdAt} title={longDateTime(comment.createdAt)}>{relativeTime(comment.createdAt)}</time>{comment.source === "native" && comment.updatedAt !== comment.createdAt && <small>edited</small>}
        <details className="comment-menu"><summary aria-label="Comment actions"><MoreHorizontal size={14} /></summary><div>
          <button type="button" onClick={() => copyCommentPermalink(comment.id)}>Copy link</button>
          {comment.permissions.canEdit && <button type="button" onClick={() => setEditing(true)}>Edit</button>}
          {comment.permissions.canDelete && <button type="button" onClick={() => { if (window.confirm("Delete this comment?")) void onDelete(comment); }}>Delete</button>}
        </div></details>
      </header>
      {comment.historical?.quotedText && <blockquote className="historical-comment-quote">{comment.historical.quotedText}</blockquote>}
      {comment.deletedAt ? <p className="comment-tombstone">Comment deleted</p> : editing ? <div className="comment-edit"><CommentAttachmentAuthoring taskId={taskId} value={editBody} onChange={setEditBody} textareaRef={editRef} disabled={busy} onBlockingChange={setEditUploadBlocked}><textarea ref={editRef} value={editBody} onChange={(event) => setEditBody(event.target.value)} rows={4} autoFocus /></CommentAttachmentAuthoring><div><button className="button ghost" type="button" onClick={() => { setEditBody(comment.body); setEditing(false); }}>Cancel</button><button className="button primary" type="button" disabled={busy || editUploadBlocked || !editBody.trim()} onClick={() => void onEdit(comment, editBody).then((saved) => { if (saved) setEditing(false); })}>{editUploadBlocked ? "Upload pending" : "Save"}</button></div></div> : <><CommentMarkdown taskId={taskId} body={body} />{long && <button className="comment-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less" : "Show more"}</button>}</>}
      {!comment.deletedAt && <div className="comment-actions">
        {comment.reactions.map((reaction) => <button key={reaction.emoji} className={reaction.reactedByCurrentUser ? "active" : ""} type="button" disabled={!comment.permissions.canReact || busy} onClick={() => void onReact(comment, reaction.emoji, !reaction.reactedByCurrentUser)}>{reaction.emoji} <span>{reaction.count}</span></button>)}
        {comment.permissions.canReact && ["👍", "❤️", "🎉"].filter((emoji) => !comment.reactions.some((reaction) => reaction.emoji === emoji)).map((emoji) => <button className="reaction-add" key={emoji} type="button" disabled={busy} aria-label={`React ${emoji}`} onClick={() => void onReact(comment, emoji, true)}>{emoji}</button>)}
        {isRoot && comment.permissions.canReact && <button type="button" disabled={busy} onClick={() => onReply(rootId)}>Reply</button>}
        {isRoot && comment.permissions.canResolve && <button type="button" disabled={busy} onClick={() => void onResolve(comment, !comment.resolvedAt)}>{comment.resolvedAt ? "Reopen" : "Resolve"}</button>}
      </div>}
    </div>
  </div>;
}
