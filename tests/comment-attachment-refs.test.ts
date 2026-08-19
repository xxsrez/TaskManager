import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { GET as listAttachmentsRoute } from "../app/api/tasks/[id]/attachments/route";
import {
  GET as listAgentCommentsRoute,
  POST as createAgentCommentRoute,
} from "../app/api/agent/v1/tasks/[ref]/comments/route";
import {
  PATCH as editAgentCommentRoute,
} from "../app/api/agent/v1/tasks/[ref]/comments/[commentRef]/route";
import { POST as mcpPost } from "../app/api/mcp/route";
import { issueApiCredential, revokeApiCredential } from "../lib/api-credentials";
import { reconcileAttachmentStorage } from "../lib/attachment-operations";
import {
  createAgentTaskComment,
  listAgentTaskComments,
} from "../lib/agent-api-repository";
import {
  createAttachment,
  deleteAttachment,
  resolveTaskAttachments,
} from "../lib/attachments";
import { exportProjectBackup } from "../lib/project-backup";
import { exportSystemBackup } from "../lib/system-backup";
import {
  createComment,
  deleteComment,
  editComment,
  getCommentThread,
} from "../lib/comments";
import { ConflictError, ValidationError } from "../lib/domain";
import { configureActorResolverForTests } from "../lib/auth";
import {
  createProject,
  createTask,
  getOrCreateUser,
  getSnapshot,
  getTask,
} from "../lib/repository";
import { buildTaskFileLink, buildTaskImageToken } from "../lib/task-description-format";
import { createD1TestHarness } from "./helpers/d1";

const ownerActor = {
  provider: "chatgpt" as const,
  providerAccountKey: "comment-attachment-owner",
  displayName: "Comment Attachment Owner",
  email: "comment-attachment-owner@example.test",
};

let dispose: (() => Promise<void>) | undefined;
let database: D1Database;

before(async () => {
  const harness = await createD1TestHarness({
    TASK_MANAGER_ATTACHMENT_SCOPE: "comment-ref-test",
    TASK_MANAGER_ATTACHMENT_MAX_BYTES: "4096",
    TASK_MANAGER_ATTACHMENT_MAX_COUNT: "20",
    TASK_MANAGER_ADMIN_EMAILS: ownerActor.email,
  }, { r2: true });
  database = harness.database;
  dispose = harness.dispose;
});

after(async () => dispose?.());

async function setup(name: string) {
  const owner = await getOrCreateUser(ownerActor);
  await createProject(owner, { name, taskCode: `C${name.at(-1)}`.toUpperCase() });
  const project = (await getSnapshot(owner)).projects.find((value) => value.name === name)!;
  const task = await createTask(owner, { title: `${name} task`, projectId: project.id });
  return { owner, project, task };
}

async function readyFile(
  owner: Awaited<ReturnType<typeof getOrCreateUser>>,
  taskId: string,
  key: string,
) {
  return createAttachment(owner, taskId, {
    body: new TextEncoder().encode(`%PDF-1.7\n${key}\n%%EOF`),
    filename: `${key}.pdf`,
    claimedMediaType: "application/pdf",
    idempotencyKey: key,
  });
}

test("native comments atomically index ready image/file refs across create, edit, retry, delete, and backup", async () => {
  const { owner, project, task } = await setup("Comment refs A");
  const file = await readyFile(owner, task.id, "comment-file");
  const image = await readyFile(owner, task.id, "comment-image");
  await database.prepare(
    "UPDATE attachments SET kind = 'image', media_type = 'image/png' WHERE id = ?",
  ).bind(image.id).run();
  const imageToken = buildTaskImageToken(image.publicId, "Diagram", "Request flow", 480);
  const fileToken = buildTaskFileLink(file.publicId, "Download notes");
  const literalToken = "[literal](attachment:v1:guessed-reference)";
  const body = [
    imageToken,
    fileToken,
    fileToken,
    `\`${literalToken}\``,
    "~~~md",
    literalToken,
    "~~~~",
    "   ```md",
    literalToken,
    "   ```",
    `\\${literalToken}`,
  ].join("\n");

  const root = await createComment(owner, task.id, {
    body,
    idempotencyKey: "root-with-refs",
  });
  assert.match(root.body, /\{width=480\}/);
  assert.deepEqual(root.attachmentRefs, [
    { ref: image.publicId, presentation: "image" },
    { ref: file.publicId, presentation: "file" },
  ]);
  await assert.rejects(
    createComment(owner, task.id, {
      body: `![Bad width](attachment:v1:${image.publicId}){width=481}`,
      idempotencyKey: "root-bad-image-width",
    }),
    (error: unknown) => error instanceof ValidationError && /malformed/.test(error.message),
  );
  assert.equal(await activityCount(task.id, "comment_added"), 1);
  const projectBackup = await exportProjectBackup(
    owner,
    project.id,
    "https://example.test",
  );
  assert.equal(projectBackup.schemaVersion, 13);
  assert.equal(projectBackup.tables.comment_attachment_refs.length, 2);
  assert.match(
    String(projectBackup.tables.comments.find((comment) => comment.id === root.id)?.body ?? ""),
    /\{width=480\}/,
  );
  assert.equal(
    projectBackup.tables.comment_attachment_refs.every((ref) => ref.comment_id === root.id),
    true,
  );
  const systemBackup = await exportSystemBackup(owner);
  assert.equal(systemBackup.schemaVersion, 13);
  assert.match(
    String(systemBackup.tables.comments.find((comment) => comment.id === root.id)?.body ?? ""),
    /\{width=480\}/,
  );
  assert.equal(
    systemBackup.tables.comment_attachment_refs.filter((ref) => ref.comment_id === root.id).length,
    2,
  );
  const duplicate = await createComment(owner, task.id, {
    body: "retry must not replace body or refs",
    idempotencyKey: "root-with-refs",
  });
  assert.equal(duplicate.id, root.id);
  assert.equal(duplicate.body, body);
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM comment_attachment_refs WHERE comment_id = ?",
    ).bind(root.id).first<{ count: number }>())?.count),
    2,
  );

  const edited = await editComment(owner, task.id, root.id, {
    version: root.version,
    body: fileToken,
  });
  assert.deepEqual(edited.attachmentRefs, [
    { ref: file.publicId, presentation: "file" },
  ]);
  assert.equal(await activityCount(task.id, "comment_edited"), 1);
  await assert.rejects(
    editComment(owner, task.id, root.id, {
      version: root.version,
      body: imageToken,
    }),
    ConflictError,
  );
  assert.deepEqual((await getCommentThread(owner, task.id, root.id)).root.attachmentRefs, [
    { ref: file.publicId, presentation: "file" },
  ]);
  await assert.rejects(
    deleteAttachment(owner, task.id, file.publicId, file.version),
    ValidationError,
  );

  const deleted = await deleteComment(owner, task.id, root.id, {
    version: edited.version,
  });
  assert.deepEqual(deleted.attachmentRefs, []);
  assert.equal(await activityCount(task.id, "comment_deleted"), 1);
  assert.equal(
    Number((await database.prepare(
      "SELECT COUNT(*) AS count FROM comment_attachment_refs WHERE comment_id = ?",
    ).bind(root.id).first<{ count: number }>())?.count),
    0,
  );
  assert.equal((await database.prepare(
    "SELECT state FROM attachments WHERE id = ?",
  ).bind(file.id).first<{ state: string }>())?.state, "ready");
  assert.equal(
    (await deleteAttachment(owner, task.id, file.publicId, file.version)).state,
    "deleted",
  );
});

test("comment refs reject guessed, cross-task, unavailable, and incompatible attachments without leaks", async () => {
  const { owner, project, task } = await setup("Comment refs B");
  const other = await createTask(owner, { title: "Other task", projectId: project.id });
  const local = await readyFile(owner, task.id, "local-file");
  const foreign = await readyFile(owner, other.id, "foreign-file");
  const detail = await getTask(owner, task.id);

  for (const [key, body] of [
    ["guessed", "[missing](attachment:v1:guessed-reference)"],
    ["cross-task", buildTaskFileLink(foreign.publicId, "foreign")],
    ["wrong-kind", buildTaskImageToken(local.publicId, "not image")],
  ]) {
    await assert.rejects(
      createComment(owner, detail.id, { body, idempotencyKey: key }),
      (error: unknown) => error instanceof ValidationError &&
        !error.message.includes("guessed-reference") &&
        !error.message.includes(foreign.publicId),
    );
  }
  await database.prepare("UPDATE attachments SET state = 'pending' WHERE id = ?")
    .bind(local.id).run();
  await assert.rejects(
    createComment(owner, task.id, {
      body: buildTaskFileLink(local.publicId, "pending"),
      idempotencyKey: "pending",
    }),
    ValidationError,
  );
});

test("comment attachment metadata resolves only requested same-Task refs", async () => {
  const { owner, project, task } = await setup("Comment refs R");
  const other = await createTask(owner, { title: "Other metadata task", projectId: project.id });
  const visible = await readyFile(owner, task.id, "visible-comment-file");
  const hiddenSameTask = await readyFile(owner, task.id, "hidden-comment-file");
  const foreign = await readyFile(owner, other.id, "foreign-comment-file");

  const resolved = await resolveTaskAttachments(owner, task.id, [
    visible.publicId,
    "guessed-reference",
    foreign.publicId,
    visible.publicId,
  ]);

  assert.deepEqual(resolved.map((attachment) => attachment.publicId), [visible.publicId]);
  assert.ok(!resolved.some((attachment) => attachment.publicId === hiddenSameTask.publicId));
  assert.ok(!resolved.some((attachment) => attachment.publicId === foreign.publicId));

  await createComment(owner, task.id, {
    body: buildTaskFileLink(visible.publicId, "Visible comment file"),
    idempotencyKey: "metadata-bootstrap-boundary",
  });
  const bootstrap = JSON.stringify(await getSnapshot(owner));
  assert.doesNotMatch(bootstrap, new RegExp(visible.publicId));
  assert.doesNotMatch(bootstrap, /visible-comment-file|attachment:v1:/);

  configureActorResolverForTests(async () => ownerActor);
  try {
    const query = new URLSearchParams();
    query.append("refs", visible.publicId);
    query.append("refs", foreign.publicId);
    query.append("refs", "guessed-reference");
    const response = await listAttachmentsRoute(
      new Request(`https://example.test/api/tasks/${task.id}/attachments?${query}`),
      { params: Promise.resolve({ id: task.id }) },
    );
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      attachments: Array<{ ref: string }>;
    };
    assert.deepEqual(payload.attachments.map((attachment) => attachment.ref), [
      visible.publicId,
    ]);
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /objectKey|"url"|"body"/);
    assert.doesNotMatch(serialized, /hidden-comment-file|foreign-comment-file/);
  } finally {
    configureActorResolverForTests(null);
  }

  await assert.rejects(
    resolveTaskAttachments(owner, task.id, Array.from({ length: 101 }, (_, index) => `ref-${index}`)),
    ValidationError,
  );
});

test("native reply to historical root carries refs and Agent/MCP projections expose only opaque topology", async () => {
  const { owner, task } = await setup("Comment refs C");
  const file = await readyFile(owner, task.id, "historical-reply");
  const token = buildTaskFileLink(file.publicId, "history.pdf");
  const historicalId = "comment_historical_attachment_root";
  await database.prepare(
    `INSERT INTO comments
      (id, task_id, author_user_id, body, source, source_record_id,
       source_comment_id, historical_author_name, historical_created_at,
       historical_updated_at, idempotency_key, created_at, updated_at, version)
     VALUES (?, ?, NULL, 'Historical root', 'linear', 'source-history',
       'history-root', 'Historical Author', '2025-01-01T00:00:00.000Z',
       '2025-01-01T00:00:00.000Z', 'linear:history-root',
       '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', 1)`,
  ).bind(historicalId, task.id).run();

  const reply = await createAgentTaskComment(owner, task.publicId, {
    body: token,
    parentCommentRef: historicalId,
    idempotencyKey: "historical-reply-ref",
  });
  assert.deepEqual(reply.attachmentRefs, [
    { ref: file.publicId, presentation: "file" },
  ]);
  const page = await listAgentTaskComments(owner, task.publicId, { limit: 10 });
  assert.deepEqual(page.data[0]?.replies[0]?.attachmentRefs, reply.attachmentRefs);
  assert.equal(JSON.stringify(reply).includes("objectKey"), false);
  assert.equal(JSON.stringify(reply).includes("filename"), false);

  const credential = await issueApiCredential(owner, {
    name: "comment-attachment-mcp",
    scopes: ["api:write"],
    expiresInDays: 1,
  });
  const response = await mcpPost(new Request("https://example.test/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 270,
      method: "tools/call",
      params: {
        name: "add_task_comment",
        arguments: {
          taskRef: task.publicId,
          body: token,
          idempotencyKey: "mcp-comment-ref",
        },
      },
    }),
  }));
  const result = await mcpResult(response);
  assert.deepEqual(result.result.structuredContent.data.attachmentRefs, [
    { ref: file.publicId, presentation: "file" },
  ]);
});

test("Agent REST composes root and reply refs with scope, version, and existence-leak guards", async () => {
  const { owner, project, task } = await setup("Comment refs Agent REST");
  const other = await createTask(owner, { title: "Foreign REST task", projectId: project.id });
  const image = await readyFile(owner, task.id, "agent-rest-image");
  await database.prepare(
    "UPDATE attachments SET kind = 'image', media_type = 'image/png' WHERE id = ?",
  ).bind(image.id).run();
  const file = await readyFile(owner, task.id, "agent-rest-file");
  const foreign = await readyFile(owner, other.id, "agent-rest-foreign");
  const writeCredential = await issueApiCredential(owner, {
    name: "comment-rest-write",
    scopes: ["api:write"],
    expiresInDays: 1,
  });
  const readCredential = await issueApiCredential(owner, {
    name: "comment-rest-read",
    scopes: ["api:read"],
    expiresInDays: 1,
  });
  const endpoint = `https://example.test/api/agent/v1/tasks/${task.publicId}/comments`;
  const context = { params: Promise.resolve({ ref: task.publicId }) };
  const writeHeaders = {
    authorization: `Bearer ${writeCredential.token}`,
    "content-type": "application/json",
  };

  const rootResponse = await createAgentCommentRoute(new Request(endpoint, {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({
      body: [
        buildTaskImageToken(image.publicId, "Architecture diagram"),
        buildTaskFileLink(file.publicId, "Review packet.pdf"),
      ].join("\n\n"),
      idempotencyKey: "agent-rest-root",
    }),
  }), context);
  assert.equal(rootResponse.status, 201);
  const root = (await rootResponse.json()) as {
    data: { ref: string; version: number; attachmentRefs: unknown[] };
  };
  assert.deepEqual(root.data.attachmentRefs, [
    { ref: image.publicId, presentation: "image" },
    { ref: file.publicId, presentation: "file" },
  ]);

  const replyResponse = await createAgentCommentRoute(new Request(endpoint, {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({
      body: buildTaskFileLink(file.publicId, "Reply packet.pdf"),
      parentCommentRef: root.data.ref,
      idempotencyKey: "agent-rest-reply",
    }),
  }), context);
  assert.equal(replyResponse.status, 201);
  const reply = (await replyResponse.json()) as {
    data: { ref: string; parentCommentRef: string; attachmentRefs: unknown[] };
  };
  assert.equal(reply.data.parentCommentRef, root.data.ref);
  assert.deepEqual(reply.data.attachmentRefs, [
    { ref: file.publicId, presentation: "file" },
  ]);

  const editContext = {
    params: Promise.resolve({ ref: task.publicId, commentRef: root.data.ref }),
  };
  const editedResponse = await editAgentCommentRoute(new Request(
    `${endpoint}/${root.data.ref}`,
    {
      method: "PATCH",
      headers: writeHeaders,
      body: JSON.stringify({ version: root.data.version, body: "Refs removed" }),
    },
  ), editContext);
  assert.equal(editedResponse.status, 200);
  assert.deepEqual(((await editedResponse.json()) as {
    data: { attachmentRefs: unknown[] };
  }).data.attachmentRefs, []);
  const stale = await editAgentCommentRoute(new Request(
    `${endpoint}/${root.data.ref}`,
    {
      method: "PATCH",
      headers: writeHeaders,
      body: JSON.stringify({ version: root.data.version, body: "Stale edit" }),
    },
  ), editContext);
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { error: { code: string } }).error.code, "version_conflict");

  const foreignResponse = await createAgentCommentRoute(new Request(endpoint, {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({
      body: buildTaskFileLink(foreign.publicId, "Foreign.pdf"),
      idempotencyKey: "agent-rest-cross-task",
    }),
  }), context);
  assert.equal(foreignResponse.status, 400);
  const foreignError = await foreignResponse.text();
  assert.doesNotMatch(foreignError, new RegExp(foreign.publicId));

  const readOnly = await createAgentCommentRoute(new Request(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${readCredential.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ body: "Denied", idempotencyKey: "read-only" }),
  }), context);
  assert.equal(readOnly.status, 403);
  assert.match(readOnly.headers.get("www-authenticate") ?? "", /api:write/);

  await revokeApiCredential(owner, writeCredential.credential.id);
  const revoked = await listAgentCommentsRoute(new Request(endpoint, {
    headers: { authorization: `Bearer ${writeCredential.token}` },
  }), context);
  assert.equal(revoked.status, 401);
});

test("concurrent comment create and attachment delete never leave a dangling live ref", async () => {
  const { owner, task } = await setup("Comment refs D");
  const file = await readyFile(owner, task.id, "delete-race");
  const token = buildTaskFileLink(file.publicId, "race.pdf");
  const outcomes = await Promise.allSettled([
    createComment(owner, task.id, {
      body: token,
      idempotencyKey: "delete-race-comment",
    }),
    deleteAttachment(owner, task.id, file.publicId, file.version),
  ]);
  assert.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1);
  const row = await database.prepare(
    `SELECT a.state, COUNT(car.comment_id) AS refs
     FROM attachments a LEFT JOIN comment_attachment_refs car
       ON car.attachment_id = a.id
     WHERE a.id = ? GROUP BY a.id, a.state`,
  ).bind(file.id).first<{ state: string; refs: number }>();
  assert.ok(row);
  if (row.state === "deleted") {
    assert.equal(Number(row.refs), 0);
  } else {
    assert.equal(row.state, "ready");
    assert.equal(Number(row.refs), 1);
  }
});

test("attachment reconciliation reports comment body/index drift without body or filename", async () => {
  const { owner, project, task } = await setup("Comment refs E");
  const local = await readyFile(owner, task.id, "reconcile-local");
  const other = await createTask(owner, { title: "Reconcile other", projectId: project.id });
  const foreign = await readyFile(owner, other.id, "reconcile-foreign");
  const comment = await createComment(owner, task.id, {
    body: buildTaskFileLink(local.publicId, "private-filename.pdf"),
    idempotencyKey: "reconcile-comment",
  });
  await database.batch([
    database.prepare(
      "DELETE FROM comment_attachment_refs WHERE comment_id = ?",
    ).bind(comment.id),
    database.prepare(
      `INSERT INTO comment_attachment_refs (comment_id, task_id, attachment_id)
       VALUES (?, ?, ?)`,
    ).bind(comment.id, task.id, foreign.id),
  ]);

  const report = await reconcileAttachmentStorage(owner, { maxObjects: 200 });
  assert.ok(report.brokenCommentRefs.some((value) =>
    value.commentRef === comment.id && value.reason === "cross_task"));
  assert.ok(report.commentRefIndexMismatches.some((value) =>
    value.commentRef === comment.id && value.attachmentRef === local.publicId &&
    value.reason === "missing_index"));
  assert.ok(report.commentRefIndexMismatches.some((value) =>
    value.commentRef === comment.id && value.attachmentRef === foreign.publicId &&
    value.reason === "unexpected_index"));
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("private-filename.pdf"), false);
  assert.equal(serialized.includes("reconcile-foreign.pdf"), false);

  await database.batch([
    database.prepare(
      "DELETE FROM comment_attachment_refs WHERE comment_id = ?",
    ).bind(comment.id),
    database.prepare(
      `INSERT INTO comment_attachment_refs (comment_id, task_id, attachment_id)
       VALUES (?, ?, ?)`,
    ).bind(comment.id, task.id, local.id),
    database.prepare(
      "UPDATE attachments SET state = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind(local.id),
  ]);
  const unavailable = await reconcileAttachmentStorage(owner, { maxObjects: 200 });
  assert.ok(unavailable.brokenCommentRefs.some((value) =>
    value.commentRef === comment.id && value.attachmentRef === local.publicId &&
    value.reason === "unavailable"));
});

async function mcpResult(response: Response) {
  assert.equal(response.status, 200);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const match = (await response.text()).match(/data: (\{.*\})/);
    assert.ok(match);
    return JSON.parse(match[1]!);
  }
  return response.json() as Promise<{
    result: {
      structuredContent: {
        data: { attachmentRefs: unknown };
      };
    };
  }>;
}

async function activityCount(taskId: string, eventType: string) {
  return Number((await database.prepare(
    "SELECT COUNT(*) AS count FROM activity_events WHERE task_id = ? AND event_type = ?",
  ).bind(taskId, eventType).first<{ count: number }>())?.count ?? 0);
}
