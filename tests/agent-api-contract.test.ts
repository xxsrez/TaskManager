import assert from "node:assert/strict";
import test from "node:test";
import {
  apiTokenFromAuthorization,
  createApiToken,
  hashApiToken,
  normalizeApiScopes,
} from "../lib/api-credential-crypto";
import {
  AgentApiError,
  encodeKeysetCursor,
  parseAgentAttachmentListQuery,
  parseAgentSavedViewListQuery,
  parseAgentTaskListQuery,
} from "../lib/agent-api-contract";
import { agentApiOpenApi } from "../lib/agent-api-openapi";

test("API credentials are opaque bearer tokens and write includes read", async () => {
  const { token, prefix } = createApiToken();
  assert.match(token, /^tm_pat_[A-Za-z0-9_-]{40,}$/);
  assert.equal(token.startsWith(prefix), true);
  assert.equal(apiTokenFromAuthorization(`Bearer ${token}`), token);
  assert.equal(apiTokenFromAuthorization(`bearer ${token}`), token);
  assert.equal(apiTokenFromAuthorization(`Basic ${token}`), null);
  assert.deepEqual(normalizeApiScopes(["api:write"]), [
    "api:read",
    "api:write",
  ]);
  assert.notEqual(await hashApiToken(token), token);
  assert.equal(await hashApiToken(token), await hashApiToken(token));
});

test("task collection parser accepts bounded filters and resumes its cursor", async () => {
  const first = await parseAgentTaskListQuery(
    new URLSearchParams(
      "limit=25&project_ref=project-ref&status_category=started&priority=high&search=ship&order=updated",
    ),
  );
  assert.equal(first.limit, 25);
  assert.equal(first.projectRef, "project-ref");
  assert.deepEqual(first.statusCategories, ["started"]);
  assert.deepEqual(first.priorities, ["high"]);

  const cursor = encodeKeysetCursor(
    { values: ["2026-08-15T08:00:00.000Z"], id: "task-ref" },
    first.fingerprint,
  );
  const second = await parseAgentTaskListQuery(
    new URLSearchParams(
      `limit=25&project_ref=project-ref&status_category=started&priority=high&search=ship&order=updated&cursor=${cursor}`,
    ),
  );
  assert.deepEqual(second.after, {
    values: ["2026-08-15T08:00:00.000Z"],
    id: "task-ref",
  });

  const priorityOrder = await parseAgentTaskListQuery(
    new URLSearchParams("order=priority"),
  );
  assert.equal(priorityOrder.direction, "asc");
});

test("task collection parser rejects unknown fields and cross-query cursors", async () => {
  await assert.rejects(
    parseAgentTaskListQuery(new URLSearchParams("include=description")),
    (error: unknown) =>
      error instanceof AgentApiError && error.code === "invalid_argument",
  );
  const first = await parseAgentTaskListQuery(
    new URLSearchParams("project_ref=one"),
  );
  const cursor = encodeKeysetCursor(
    { values: ["2026-08-15T08:00:00.000Z"], id: "task-ref" },
    first.fingerprint,
  );
  await assert.rejects(
    parseAgentTaskListQuery(
      new URLSearchParams(`project_ref=two&cursor=${cursor}`),
    ),
    (error: unknown) =>
      error instanceof AgentApiError && error.code === "invalid_argument",
  );
});

test("attachment collection parser uses a resource-bound keyset cursor", async () => {
  const first = await parseAgentAttachmentListQuery(
    new URLSearchParams("limit=2&include_deleted=true"),
    "task-ref-one",
  );
  assert.equal(first.limit, 2);
  assert.equal(first.includeDeleted, true);
  const cursor = encodeKeysetCursor(
    { values: ["2026-08-17T20:00:00.000Z"], id: "attachment-ref" },
    first.fingerprint,
  );
  const resumed = await parseAgentAttachmentListQuery(
    new URLSearchParams(`limit=2&include_deleted=true&cursor=${cursor}`),
    "task-ref-one",
  );
  assert.deepEqual(resumed.after, {
    values: ["2026-08-17T20:00:00.000Z"],
    id: "attachment-ref",
  });
  await assert.rejects(
    parseAgentAttachmentListQuery(
      new URLSearchParams(`limit=2&include_deleted=true&cursor=${cursor}`),
      "task-ref-two",
    ),
    (error: unknown) =>
      error instanceof AgentApiError && error.code === "invalid_argument",
  );
});

test("Saved View collection parser binds pagination to scope and archive filters", async () => {
  const first = await parseAgentSavedViewListQuery(
    new URLSearchParams(
      "limit=12&project_ref=project-ref&search=Launch&archived=true",
    ),
  );
  assert.equal(first.limit, 12);
  assert.equal(first.projectRef, "project-ref");
  assert.equal(first.search, "Launch");
  assert.equal(first.archived, true);

  const cursor = encodeKeysetCursor(
    { values: ["launch"], id: "view-ref" },
    first.fingerprint,
  );
  const resumed = await parseAgentSavedViewListQuery(
    new URLSearchParams(
      `limit=12&project_ref=project-ref&search=Launch&archived=true&cursor=${cursor}`,
    ),
  );
  assert.deepEqual(resumed.after, {
    values: ["launch"],
    id: "view-ref",
  });
  await assert.rejects(
    parseAgentSavedViewListQuery(
      new URLSearchParams(
        `limit=12&project_ref=project-ref&search=Launch&archived=false&cursor=${cursor}`,
      ),
    ),
    (error: unknown) =>
      error instanceof AgentApiError && error.code === "invalid_argument",
  );
});

test("OpenAPI exposes task work but no administration or sharing operations", () => {
  const paths = Object.keys(agentApiOpenApi.paths);
  assert.equal(paths.includes("/tasks"), true);
  assert.equal(paths.includes("/tasks/{ref}"), true);
  assert.equal(paths.includes("/tasks/{ref}/move"), true);
  assert.equal(paths.includes("/tasks/{ref}/parent"), true);
  assert.equal(paths.includes("/tasks/{ref}/subtasks"), true);
  assert.equal(paths.includes("/tasks/{ref}/relations"), true);
  assert.equal(paths.includes("/tasks/{ref}/relations/{relationRef}"), true);
  assert.equal(paths.includes("/labels"), true);
  assert.equal(paths.includes("/tasks/{ref}/labels"), true);
  assert.equal(paths.includes("/label-groups"), true);
  assert.equal(paths.includes("/tasks/{ref}/labels/{labelRef}"), true);
  assert.equal(paths.includes("/tasks/{ref}/label-groups/{groupRef}"), true);
  assert.equal(paths.includes("/projects"), true);
  assert.equal(paths.includes("/releases"), true);
  assert.equal(paths.includes("/views"), true);
  assert.equal(paths.includes("/views/{ref}"), true);
  assert.equal(paths.includes("/tasks/{ref}/comments"), true);
  assert.equal(paths.includes("/tasks/{ref}/activity"), true);
  assert.equal(paths.includes("/tasks/{ref}/external-context"), false);
  assert.equal(paths.includes("/tasks/{ref}/comments/{commentRef}"), true);
  assert.equal(paths.includes("/files"), true);
  assert.equal(paths.includes("/files/{fileRef}"), true);
  assert.equal(paths.includes("/tasks/{ref}/attachments"), true);
  assert.equal(paths.includes("/tasks/{ref}/attachments/{attachmentRef}"), true);
  assert.equal(
    paths.includes("/tasks/{ref}/attachments/{attachmentRef}/content"),
    true,
  );
  assert.equal(
    agentApiOpenApi.paths["/tasks/{ref}/comments"].post.operationId,
    "createTaskComment",
  );
  const commentExamples = agentApiOpenApi.paths["/tasks/{ref}/comments"].post
    .requestBody.content["application/json"].examples as Record<
      string,
      { value: Record<string, unknown> }
    >;
  assert.match(String(commentExamples.rootWithImage?.value.body), /!\[Architecture diagram\]\(attachment:v1:/);
  assert.match(String(commentExamples.replyWithFile?.value.body), /\[Review packet\.pdf\]\(attachment:v1:/);
  assert.equal(commentExamples.replyWithFile?.value.parentCommentRef, "comment_root_01");
  assert.equal(
    agentApiOpenApi.paths["/tasks/{ref}/comments/{commentRef}"].patch.requestBody
      .content["application/json"].examples?.replaceAttachment?.value.version,
    3,
  );
  const commentErrorExamples = agentApiOpenApi.components.responses.CommentWriteError
    .content["application/json"].examples;
  assert.deepEqual(Object.keys(commentErrorExamples).sort(), [
    "crossTaskAttachment",
    "forbidden",
    "malformedAttachment",
    "versionConflict",
  ]);
  assert.equal(commentErrorExamples.crossTaskAttachment.value.error.code, "invalid_argument");
  assert.doesNotMatch(
    commentErrorExamples.crossTaskAttachment.value.error.message,
    /attachment_[a-z0-9_-]+/i,
  );
  assert.equal(
    agentApiOpenApi.paths["/tasks/{ref}/activity"].get.operationId,
    "listTaskActivity",
  );
  assert.deepEqual(
    agentApiOpenApi.components.schemas.Comment.properties.source.enum,
    ["native", "historical"],
  );
  assert.equal(
    Object.hasOwn(agentApiOpenApi.components.schemas.TaskDetail.properties, "provenance"),
    false,
  );
  assert.equal(
    agentApiOpenApi.paths["/views"].get.operationId,
    "listSavedViews",
  );
  assert.equal(
    agentApiOpenApi.paths["/views/{ref}"].get.operationId,
    "getSavedView",
  );
  assert.equal(
    Object.hasOwn(agentApiOpenApi.paths["/views"], "post"),
    false,
  );
  assert.equal(
    agentApiOpenApi.paths["/tasks/{ref}/relations"].post.operationId,
    "createTaskRelation",
  );
  assert.match(
    agentApiOpenApi.paths["/tasks/{ref}/relations"].post.summary,
    /one Project/,
  );
  assert.deepEqual(
    agentApiOpenApi.paths["/tasks/{ref}/relations"].post.security,
    [{ oauth2: ["api:write"] }, { personalToken: [] }],
  );
  assert.equal(
    agentApiOpenApi.paths["/tasks/{ref}/labels"].put.operationId,
    "replaceTaskLabels",
  );
  assert.equal(
    agentApiOpenApi.components.schemas.TaskCreate.properties.estimate.minimum,
    1,
  );
  assert.equal(
    agentApiOpenApi.components.schemas.TaskCreate.properties.estimate.maximum,
    100,
  );
  assert.equal(
    agentApiOpenApi.paths["/tasks/{ref}/labels/{labelRef}"].put.operationId,
    "addTaskLabel",
  );
  assert.equal(
    agentApiOpenApi.paths["/tasks/{ref}/labels/{labelRef}"].delete.operationId,
    "removeTaskLabel",
  );
  assert.equal(
    agentApiOpenApi.paths["/tasks/{ref}/move"].post.operationId,
    "moveTask",
  );
  assert.equal(
    agentApiOpenApi.paths["/tasks/{ref}/parent"].put.operationId,
    "setTaskParent",
  );
  assert.equal(
    agentApiOpenApi.paths["/tasks/{ref}/parent"].delete.operationId,
    "removeTaskParent",
  );
  assert.equal(
    agentApiOpenApi.paths["/tasks/{ref}/subtasks"].post.operationId,
    "createSubtask",
  );
  assert.deepEqual(
    agentApiOpenApi.components.schemas.TaskMove.required,
    ["version", "targetProjectRef"],
  );
  assert.deepEqual(
    agentApiOpenApi.components.schemas.TaskParentUpdate.required,
    ["version", "parentTaskRef"],
  );
  assert.deepEqual(
    agentApiOpenApi.components.schemas.TaskLabelsReplace.required,
    ["version", "labelRefs"],
  );
  assert.ok(agentApiOpenApi.components.schemas.TaskCreate.properties.assigneeEmail);
  assert.ok(agentApiOpenApi.components.schemas.TaskUpdate.properties.assigneeEmail);
  assert.ok(agentApiOpenApi.components.schemas.TaskSubtaskCreate.properties.assigneeEmail);
  assert.ok(agentApiOpenApi.components.schemas.TaskCreate.properties.labelRefs);
  assert.ok(agentApiOpenApi.components.schemas.TaskSubtaskCreate.properties.labelRefs);
  assert.equal(
    agentApiOpenApi.paths["/tasks/{ref}/comments/{commentRef}/resolution"].put
      .operationId,
    "setTaskCommentResolution",
  );
  assert.equal(paths.some((path) => /admin|backup|share|credential/.test(path)), false);
  assert.equal(
    Object.hasOwn(
      agentApiOpenApi.components.schemas.TaskSummary.properties,
      "description",
    ),
    false,
  );
  assert.deepEqual(
    agentApiOpenApi.components.schemas.TaskUpdate.required,
    ["version"],
  );
  assert.deepEqual(agentApiOpenApi.security, [
    { oauth2: ["api:read"] },
    { personalToken: [] },
  ]);
  assert.deepEqual(agentApiOpenApi.paths["/tasks"].post.security, [
    { oauth2: ["api:write"] },
    { personalToken: [] },
  ]);
  assert.equal(
    agentApiOpenApi.paths["/tasks/{ref}/attachments"].post.requestBody.content[
      "application/octet-stream"
    ].schema.format,
    "binary",
  );
  assert.equal(
    agentApiOpenApi.paths["/tasks/{ref}/attachments"].post.requestBody.content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/StoredFileBind",
  );
  assert.equal(
    agentApiOpenApi.paths["/files"].post.requestBody.content["application/pdf"]
      .schema.format,
    "binary",
  );
  assert.equal(
    agentApiOpenApi.paths["/files/{fileRef}"].delete.parameters.some(
      (parameter) => parameter.name === "X-File-Version",
    ),
    true,
  );
  assert.deepEqual(agentApiOpenApi.components.schemas.StoredFile.required, [
    "ref",
    "filename",
    "mediaType",
    "byteSize",
    "checksumSha256",
    "kind",
    "state",
    "readyExpiresAt",
    "version",
  ]);
});
