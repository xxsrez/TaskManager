import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  GET as listCommentsRoute,
  POST as createCommentRoute,
} from "../app/api/tasks/[id]/comments/route";
import {
  createAgentTaskComment,
  listAgentTaskComments,
} from "../lib/agent-api-repository";
import { configureActorResolverForTests } from "../lib/auth";
import {
  createComment,
  deleteComment,
  editComment,
  getCommentThread,
  listTaskComments,
  normalizeCommentBody,
  resolveCommentThread,
  setCommentReaction,
} from "../lib/comments";
import { ConflictError, PermissionError, ValidationError } from "../lib/domain";
import {
  createProject,
  createTask,
  getOrCreateUser,
  getSnapshot,
  getTask,
  grantAccess,
} from "../lib/repository";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "comment-owner",
  displayName: "Comment Owner",
  email: "comment-owner@example.test",
};
const editorActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "comment-editor",
  displayName: "Comment Editor",
  email: "comment-editor@example.test",
};
const viewerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "comment-viewer",
  displayName: "Comment Viewer",
  email: "comment-viewer@example.test",
};

let dispose: (() => Promise<void>) | undefined;
let database: D1Database;

before(async () => {
  const harness = await createD1TestHarness();
  database = harness.database;
  dispose = harness.dispose;
});

after(async () => {
  configureActorResolverForTests(null);
  await dispose?.();
});

test("comment bodies are normalized and unsafe control content is rejected", () => {
  assert.equal(normalizeCommentBody("  hello\r\nworld  "), "hello\nworld");
  assert.throws(() => normalizeCommentBody("   "), ValidationError);
  assert.throws(() => normalizeCommentBody("hello\u0000world"), ValidationError);
});

test("native task threads enforce identity, ACL, idempotency, versions, and reactions", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const editor = await getOrCreateUser(editorActor);
  const viewer = await getOrCreateUser(viewerActor);
  await createProject(owner, { name: "Comment project", taskCode: "CM" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Comment project",
  )!;
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: editor.email,
    permission: "editor",
  });
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: viewer.email,
    permission: "viewer",
  });
  const createdTask = await createTask(owner, {
    title: "Discuss this task",
    projectId: project.id,
  });
  const before = await getTask(owner, createdTask.id);

  const root = await createComment(owner, createdTask.id, {
    body: "Root **comment**",
    idempotencyKey: "root-request",
    authorUserId: viewer.id,
  });
  const duplicate = await createComment(owner, createdTask.id, {
    body: "A retry must not replace the original",
    idempotencyKey: "root-request",
  });
  assert.equal(duplicate.id, root.id);
  assert.equal(duplicate.body, "Root **comment**");
  assert.equal(root.author.id, owner.id);

  const afterRoot = await getTask(owner, createdTask.id);
  assert.equal(afterRoot.commentCount, 1);
  assert.notEqual(afterRoot.updatedAt, before.updatedAt);

  const visibleToViewer = await listTaskComments(viewer, createdTask.id, {
    limit: 20,
    cursor: null,
  });
  assert.equal(visibleToViewer.threads[0]?.root.id, root.id);
  await assert.rejects(
    createComment(viewer, createdTask.id, {
      body: "Denied",
      idempotencyKey: "viewer-request",
    }),
    PermissionError,
  );
  await assert.rejects(
    setCommentReaction(viewer, createdTask.id, root.id, {
      emoji: "👍",
      active: true,
    }),
    PermissionError,
  );

  const resolved = await resolveCommentThread(owner, createdTask.id, root.id, {
    version: root.version,
    resolved: true,
  });
  assert.ok(resolved.resolvedAt);
  const reply = await createComment(editor, createdTask.id, {
    body: "Reply from editor",
    parentCommentId: root.id,
    idempotencyKey: "reply-request",
  });
  assert.equal(reply.parentCommentId, root.id);
  const reopened = await getCommentThread(owner, createdTask.id, root.id);
  assert.equal(reopened.root.resolvedAt, null);
  assert.equal(reopened.replies[0]?.author.id, editor.id);

  const reacted = await setCommentReaction(editor, createdTask.id, root.id, {
    emoji: "👍",
    active: true,
  });
  assert.deepEqual(reacted, [{ emoji: "👍", count: 1, reactedByCurrentUser: true }]);
  const retriedReaction = await setCommentReaction(editor, createdTask.id, root.id, {
    emoji: "👍",
    active: true,
  });
  assert.deepEqual(retriedReaction, reacted);

  const edited = await editComment(editor, createdTask.id, reply.id, {
    version: reply.version,
    body: "Edited reply",
  });
  assert.ok(edited.updatedAt > edited.createdAt);
  await assert.rejects(
    editComment(editor, createdTask.id, reply.id, {
      version: reply.version,
      body: "Stale edit",
    }),
    ConflictError,
  );
  await assert.rejects(
    editComment(owner, createdTask.id, reply.id, {
      version: edited.version,
      body: "Owners cannot impersonate an edit",
    }),
    PermissionError,
  );

  const deleted = await deleteComment(owner, createdTask.id, root.id, {
    version: reopened.root.version,
  });
  assert.ok(deleted.deletedAt);
  assert.equal(deleted.body, "");
  const tombstone = await getCommentThread(viewer, createdTask.id, root.id);
  assert.equal(tombstone.replies[0]?.body, "Edited reply");
  assert.equal((await getTask(owner, createdTask.id)).commentCount, 1);
});

test("root comment pagination uses a stable keyset while new rows are inserted", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const project = (await getSnapshot(owner)).projects.find((item) => item.accessRole === "owner")!;
  const task = await createTask(owner, { title: "Paginated comments", projectId: project.id });
  for (const [index, body] of ["Alpha", "Beta", "Gamma"].entries()) {
    await createComment(owner, task.id, {
      body,
      idempotencyKey: `page-${index}`,
    });
  }
  const first = await listTaskComments(owner, task.id, { limit: 2, cursor: null });
  assert.deepEqual(first.threads.map((thread) => thread.root.body), ["Alpha", "Beta"]);
  assert.ok(first.nextCursor);
  await createComment(owner, task.id, { body: "Delta", idempotencyKey: "page-3" });
  const second = await listTaskComments(owner, task.id, {
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.deepEqual(second.threads.map((thread) => thread.root.body), ["Gamma", "Delta"]);
});

test("comment writes advance task recency monotonically after a concurrent task update", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const project = (await getSnapshot(owner)).projects.find((item) => item.accessRole === "owner")!;
  const task = await createTask(owner, { title: "Monotonic comment activity", projectId: project.id });
  const root = await createComment(owner, task.id, {
    body: "Comment before concurrent task activity",
    idempotencyKey: "monotonic-root",
  });
  const concurrentTimestamp = "2030-01-02T03:04:05.678Z";
  await database
    .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
    .bind(concurrentTimestamp, task.id)
    .run();

  await editComment(owner, task.id, root.id, {
    version: root.version,
    body: "Comment after concurrent task activity",
  });
  assert.ok((await getTask(owner, task.id)).updatedAt > concurrentTimestamp);
});

test("app and agent boundaries preserve ACL and expose privacy-minimized authors", async () => {
  const owner = await getOrCreateUser(ownerActor);
  const viewer = await getOrCreateUser(viewerActor);
  await createProject(owner, { name: "Comment API project", taskCode: "CA" });
  const project = (await getSnapshot(owner)).projects.find(
    (item) => item.name === "Comment API project",
  )!;
  await grantAccess(owner, {
    resourceType: "project",
    resourceId: project.id,
    email: viewer.email,
    permission: "viewer",
  });
  const task = await createTask(owner, {
    title: "Comment API task",
    projectId: project.id,
  });

  const agentComment = await createAgentTaskComment(owner, task.publicId, {
    body: "Created through the agent contract",
    idempotencyKey: "agent-boundary-request",
  });
  assert.equal(agentComment.author.displayName, owner.displayName);
  assert.equal(agentComment.author.isCurrentUser, true);
  assert.equal(Object.hasOwn(agentComment.author, "email"), false);
  const agentPage = await listAgentTaskComments(viewer, task.publicId, { limit: 10 });
  assert.equal(agentPage.totalCount, 1);
  assert.equal(agentPage.data[0]?.root.author.isCurrentUser, false);
  assert.equal(Object.hasOwn(agentPage.data[0]!.root.author, "email"), false);

  configureActorResolverForTests(async () => viewerActor);
  const listed = await listCommentsRoute(
    new Request(`https://example.test/api/tasks/${task.id}/comments?limit=10`),
    { params: Promise.resolve({ id: task.id }) },
  );
  assert.equal(listed.status, 200);
  const listedBody = (await listed.json()) as {
    totalCount: number;
    threads: Array<{ root: { author: Record<string, unknown> } }>;
  };
  assert.equal(listedBody.totalCount, 1);
  assert.equal(Object.hasOwn(listedBody.threads[0]!.root.author, "email"), false);

  const denied = await createCommentRoute(
    new Request(`https://example.test/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Viewer write must fail",
        idempotencyKey: "viewer-route-request",
      }),
    }),
    { params: Promise.resolve({ id: task.id }) },
  );
  assert.equal(denied.status, 403);
  configureActorResolverForTests(null);
});
