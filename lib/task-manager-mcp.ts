import {
  McpServer,
  type AuthInfo,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ApiScope } from "./api-credential-crypto";
import type { AgentAuthorizationContext } from "./agent-api-context";
import {
  AgentApiError,
  parseAgentAttachmentListQuery,
  parseAgentExternalContextQuery,
  parseAgentProjectListQuery,
  parseAgentReleaseListQuery,
  parseAgentTaskListQuery,
} from "./agent-api-contract";
import {
  assertAgentTaskAttachmentWriteAccess,
  createAgentTaskAttachment,
  createAgentTaskComment,
  createAgentTaskRelation,
  deleteAgentTaskAttachment,
  deleteAgentTaskComment,
  deleteAgentTaskRelation,
  editAgentTaskComment,
  createAgentTask,
  getAgentProjectDetail,
  getAgentReleaseDetail,
  getAgentTaskDetail,
  getAgentTaskAttachment,
  getAgentTaskExternalContext,
  getAgentTaskThread,
  getAgentWorkspace,
  listAgentProjects,
  listAgentReleases,
  listAgentLabels,
  listAgentTasks,
  listAgentTaskAttachments,
  listAgentTaskComments,
  moveAgentTask,
  setAgentTaskLabel,
  resolveAgentTaskThread,
  setAgentCommentReaction,
  updateAgentTask,
  updateAgentTaskRelation,
} from "./agent-api-repository";
import { fetchMcpFileInput } from "./agent-file-input";
import { attachmentLimits } from "./attachments";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from "./domain";
import { oauthProtectedResourceMetadataUrl } from "./oauth-contract";
import type { UserRecord } from "./types";

const paginationSchema = {
  limit: z.number().int().min(1).max(200).optional().describe("Items per page; default 50."),
  cursor: z.string().min(1).optional().describe("Opaque nextCursor from the previous page."),
};

const taskFields = {
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(100_000).optional(),
  statusRef: z.string().min(1).max(200).optional(),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
  projectRef: z.string().min(1).max(200).optional(),
  releaseRef: z.string().min(1).max(200).nullable().optional(),
  estimate: z.number().finite().nonnegative().nullable().optional(),
  dueDate: z.string().nullable().optional().describe("ISO 8601 calendar date or null."),
};

const mcpFileInputSchema = z.object({
  download_url: z.string().url().describe("Temporary OpenAI file download URL."),
  file_id: z.string().min(1).max(512).describe("OpenAI file identifier."),
  mime_type: z.string().min(1).max(200).optional(),
  file_name: z.string().min(1).max(512).optional(),
});

export function buildTaskManagerMcp(context: AgentAuthorizationContext) {
  const server = new McpServer({ name: "task-manager", version: "1.0.0" });

  server.registerTool(
    "get_workspace",
    {
      title: "Get Task Manager workspace",
      description:
        "Start here. Returns the signed-in user, connector capabilities, accessible counts, and workflow status catalog.",
      inputSchema: z.object({}),
      annotations: readAnnotations,
      _meta: toolSecurity("api:read"),
    },
    async () => toolCall(() => getAgentWorkspace(context)),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "Lists every project accessible through ownership or sharing. Use search to resolve a project before filtering tasks or releases.",
      inputSchema: z.object({
        ...paginationSchema,
        search: z.string().min(1).max(200).optional(),
        archived: z.boolean().optional().describe("Default false."),
      }),
      annotations: readAnnotations,
      _meta: toolSecurity("api:read"),
    },
    async (input) =>
      toolCall(async () => {
        const query = await parseAgentProjectListQuery(queryParameters(input));
        return listAgentProjects(context.user, query);
      }),
  );

  server.registerTool(
    "list_labels",
    {
      title: "List labels",
      description:
        "Lists native Label catalogs visible through owned or shared Projects. Use a returned canonical label ref with add_task_label or remove_task_label.",
      inputSchema: z.object({
        archived: z.boolean().optional().describe("Include archived Labels; default false."),
      }),
      annotations: readAnnotations,
      _meta: toolSecurity("api:read"),
    },
    async ({ archived }) => toolCall(() => listAgentLabels(context.user, archived)),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get project",
      description:
        "Returns project details, releases, task counts, access role, and the workflow statuses valid when creating tasks in this project.",
      inputSchema: z.object({ projectRef: reference("Canonical project ref from list_projects.") }),
      annotations: readAnnotations,
      _meta: toolSecurity("api:read"),
    },
    async ({ projectRef }) =>
      toolCall(() => getAgentProjectDetail(context.user, projectRef)),
  );

  server.registerTool(
    "list_releases",
    {
      title: "List releases",
      description:
        "Lists accessible releases. Filter by projectRef, lifecycle status, or search text; omit projectRef to search across all projects.",
      inputSchema: z.object({
        ...paginationSchema,
        projectRef: reference("Canonical project ref.").optional(),
        statuses: z
          .array(z.enum(["planned", "active", "released", "canceled"]))
          .max(4)
          .optional(),
        search: z.string().min(1).max(200).optional(),
      }),
      annotations: readAnnotations,
      _meta: toolSecurity("api:read"),
    },
    async (input) =>
      toolCall(async () => {
        const query = await parseAgentReleaseListQuery(
          queryParameters(input, { projectRef: "project_ref", statuses: "status" }),
        );
        return listAgentReleases(context.user, query);
      }),
  );

  server.registerTool(
    "get_release",
    {
      title: "Get release",
      description:
        "Returns release details, project identity, task counts, progress, notes, and workflow statuses for tasks in the release.",
      inputSchema: z.object({ releaseRef: reference("Canonical release ref from list_releases.") }),
      annotations: readAnnotations,
      _meta: toolSecurity("api:read"),
    },
    async ({ releaseRef }) =>
      toolCall(() => getAgentReleaseDetail(context.user, releaseRef)),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List and filter tasks",
      description:
        "Lists compact task summaries across everything the user can access. Filter by projectRef and releaseRef independently or together; omit both to get all accessible tasks. Continue with nextCursor only when more results are needed, then call get_task for the selected task.",
      inputSchema: z.object({
        ...paginationSchema,
        projectRef: reference("Canonical project ref from list_projects.").optional(),
        releaseRef: reference("Canonical release ref from list_releases.").optional(),
        statusCategories: z
          .array(z.enum(["backlog", "unstarted", "started", "completed", "canceled"]))
          .max(5)
          .optional(),
        priorities: z
          .array(z.enum(["none", "low", "medium", "high", "urgent"]))
          .max(5)
          .optional(),
        assignee: z.enum(["me", "unassigned"]).optional(),
        archived: z.boolean().optional().describe("Default false."),
        search: z.string().min(1).max(200).optional(),
        order: z.enum(["manual", "updated", "created", "priority", "due", "title"]).optional(),
        direction: z.enum(["asc", "desc"]).optional(),
      }),
      annotations: readAnnotations,
      _meta: toolSecurity("api:read"),
    },
    async (input) =>
      toolCall(async () => {
        const query = await parseAgentTaskListQuery(
          queryParameters(input, {
            projectRef: "project_ref",
            releaseRef: "release_ref",
            statusCategories: "status_category",
            priorities: "priority",
          }),
        );
        return listAgentTasks(context.user, query);
      }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description:
        "Gets a complete task after selection: description, lifecycle, project/release, relations, subtasks, provenance, native attachment count, access, version, and valid workflow statuses. Call list_task_attachments only when attachment metadata is needed.",
      inputSchema: z.object({ taskRef: reference("Task ref or identifier. Prefer the canonical ref from list_tasks.") }),
      annotations: readAnnotations,
      _meta: toolSecurity("api:read"),
    },
    async ({ taskRef }) => toolCall(() => getAgentTaskDetail(context.user, taskRef)),
  );

  server.registerTool(
    "get_task_external_context",
    {
      title: "Get imported task context",
      description:
        "Gets paginated imported comments, attachments, source URL, and branch metadata when get_task reports external provenance.",
      inputSchema: z.object({
        taskRef: reference("Canonical task ref."),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).optional(),
      }),
      annotations: readAnnotations,
      _meta: toolSecurity("api:read"),
    },
    async ({ taskRef, limit, cursor }) =>
      toolCall(async () => {
        const query = await parseAgentExternalContextQuery(
          queryParameters({ limit, cursor }),
          taskRef,
        );
        return getAgentTaskExternalContext(context.user, taskRef, query);
      }),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Creates a task when the user explicitly asks. Resolve project/release first and use their canonical refs. Use a workflow status ref returned by get_project/get_release; otherwise the default status is used.",
      inputSchema: z.object({
        ...taskFields,
        title: z.string().min(1).max(500),
        projectRef: reference("Canonical Project ref; every Task requires one."),
      }),
      annotations: writeAnnotations,
      _meta: toolSecurity("api:write"),
    },
    async (input) => writeToolCall(context, () => createAgentTask(context.user, defined(input))),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Updates a task when the user explicitly asks. First call get_task and pass its current version for optimistic concurrency. Project cannot be cleared or changed by this generic patch; releaseRef/dueDate may be null and archived is reversible.",
      inputSchema: z.object({
        taskRef: reference("Canonical task ref."),
        version: z.number().int().positive(),
        ...taskFields,
        rank: z.number().finite().optional(),
        archived: z.boolean().optional(),
      }),
      annotations: writeAnnotations,
      _meta: toolSecurity("api:write"),
    },
    async ({ taskRef, ...input }) =>
      writeToolCall(context, () => updateAgentTask(context.user, taskRef, defined(input))),
  );

  server.registerTool(
    "move_task",
    {
      title: "Move task",
      description:
        "Atomically moves a task to another editable active Project. First resolve the task and target Project, then pass canonical refs and the current task version. If the current Release or assignee cannot remain valid, explicitly pass releaseRef or assigneeEmail as null, or choose a compatible value. The returned identifier is authoritative; the preview does not reserve a number.",
      inputSchema: z.object({
        taskRef: reference("Canonical current or historical Task ref."),
        version: z.number().int().positive(),
        targetProjectRef: reference("Canonical target Project ref."),
        releaseRef: reference("Canonical Release ref in the target Project.")
          .nullable()
          .optional(),
        assigneeEmail: z.string().email().max(320).nullable().optional().describe(
          "Verified email of a member of the target Project, or null to clear.",
        ),
      }),
      annotations: writeAnnotations,
      _meta: toolSecurity("api:write"),
    },
    async ({ taskRef, ...input }) =>
      writeToolCall(context, () => moveAgentTask(context.user, taskRef, defined(input))),
  );

  server.registerTool(
    "create_task_relation",
    {
      title: "Create task relation",
      description:
        "Creates one native relation after resolving both tasks. Use outgoing blocks for taskRef blocks targetTaskRef, incoming blocks for taskRef is blocked by targetTaskRef, related for a symmetric relation, and outgoing duplicate_of to mark taskRef as a duplicate and move it to the reserved Duplicate status. Reuse idempotencyKey only when retrying the identical command.",
      inputSchema: z.object({
        taskRef: reference("Canonical source/context task ref."),
        targetTaskRef: reference("Canonical peer task ref."),
        type: z.enum(["blocks", "related", "duplicate_of"]),
        direction: z.enum(["outgoing", "incoming"]),
        idempotencyKey: z.string().min(1).max(200),
        taskVersion: z.number().int().positive().optional().describe(
          "Current taskRef version; required when type is duplicate_of.",
        ),
      }),
      annotations: idempotentWriteAnnotations,
      _meta: toolSecurity("api:write"),
    },
    async ({ taskRef, ...input }) => writeToolCall(context, () =>
      createAgentTaskRelation(context.user, taskRef, defined(input))),
  );

  server.registerTool(
    "add_task_label",
    {
      title: "Add task label",
      description:
        "Idempotently adds one active native Label to a Task. Resolve both canonical refs first; retries preserve the same desired state without duplicating the assignment.",
      inputSchema: z.object({
        taskRef: reference("Canonical Task ref."),
        labelRef: reference("Canonical active Label ref from list_labels."),
      }),
      annotations: idempotentWriteAnnotations,
      _meta: toolSecurity("api:write"),
    },
    async ({ taskRef, labelRef }) => writeToolCall(context, () =>
      setAgentTaskLabel(context.user, taskRef, labelRef, true)),
  );

  server.registerTool(
    "remove_task_label",
    {
      title: "Remove task label",
      description:
        "Idempotently removes one native Label from a Task. Archived Labels may still be removed by their canonical ref.",
      inputSchema: z.object({
        taskRef: reference("Canonical Task ref."),
        labelRef: reference("Canonical Label ref."),
      }),
      annotations: idempotentWriteAnnotations,
      _meta: toolSecurity("api:write"),
    },
    async ({ taskRef, labelRef }) => writeToolCall(context, () =>
      setAgentTaskLabel(context.user, taskRef, labelRef, false)),
  );

  server.registerTool(
    "update_task_relation",
    {
      title: "Update task relation",
      description:
        "Changes the type or direction of one relation using its current relation version. Read get_task again after an unknown outcome before retrying. Changing away from duplicate_of does not guess or restore a previous task status.",
      inputSchema: z.object({
        taskRef: reference("Canonical context task ref."),
        relationRef: reference("Canonical relation ref from get_task."),
        version: z.number().int().positive(),
        type: z.enum(["blocks", "related", "duplicate_of"]),
        direction: z.enum(["outgoing", "incoming"]),
        taskVersion: z.number().int().positive().optional().describe(
          "Current taskRef version; required when changing to duplicate_of.",
        ),
      }),
      annotations: writeAnnotations,
      _meta: toolSecurity("api:write"),
    },
    async ({ taskRef, relationRef, ...input }) => writeToolCall(context, () =>
      updateAgentTaskRelation(
        context.user,
        taskRef,
        relationRef,
        defined(input),
      )),
  );

  server.registerTool(
    "delete_task_relation",
    {
      title: "Delete task relation",
      description:
        "Removes one native relation using its current relation version. Removing duplicate_of deliberately leaves the task status unchanged.",
      inputSchema: z.object({
        taskRef: reference("Canonical context task ref."),
        relationRef: reference("Canonical relation ref from get_task."),
        version: z.number().int().positive(),
      }),
      annotations: destructiveWriteAnnotations,
      _meta: toolSecurity("api:write"),
    },
    async ({ taskRef, relationRef, version }) => writeToolCall(context, () =>
      deleteAgentTaskRelation(context.user, taskRef, relationRef, { version })),
  );

  server.registerTool(
    "list_task_attachments",
    {
      title: "List native task attachments",
      description:
        "Lists one bounded page of private native attachment metadata after resolving an accessible task. Binary content and imported attachment links are not included.",
      inputSchema: z.object({
        taskRef: reference("Canonical task ref."),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).optional(),
        includeDeleted: z.boolean().optional().describe("Editor-only; default false."),
      }),
      annotations: readAnnotations,
      _meta: toolSecurity("api:read"),
    },
    async ({ taskRef, limit, cursor, includeDeleted }) =>
      toolCall(async () => {
        const query = await parseAgentAttachmentListQuery(
          queryParameters(
            { limit, cursor, includeDeleted },
            { includeDeleted: "include_deleted" },
          ),
          taskRef,
        );
        return listAgentTaskAttachments(
          context.user,
          taskRef,
          query,
          toolOrigin(context),
        );
      }),
  );

  server.registerTool(
    "get_task_attachment",
    {
      title: "Get native task attachment",
      description:
        "Gets metadata and bearer-protected original/thumbnail URLs for one native attachment. It never returns an R2 key or public object URL.",
      inputSchema: z.object({
        taskRef: reference("Canonical task ref."),
        attachmentRef: reference("Attachment ref from list_task_attachments."),
      }),
      annotations: readAnnotations,
      _meta: toolSecurity("api:read"),
    },
    async ({ taskRef, attachmentRef }) =>
      toolCall(() =>
        getAgentTaskAttachment(
          context.user,
          taskRef,
          attachmentRef,
          toolOrigin(context),
        )),
  );

  server.registerTool(
    "upload_task_attachment",
    {
      title: "Upload native task attachment",
      description:
        "Uploads one OpenAI-provided file into the selected Task's private storage. Reuse idempotencyKey only when retrying the identical file. To embed a raster image, insert its attachment:v1 ref with update_task after upload succeeds.",
      inputSchema: z.object({
        taskRef: reference("Canonical task ref."),
        file: mcpFileInputSchema,
        idempotencyKey: z.string().min(1).max(200),
      }),
      annotations: idempotentOpenWorldWriteAnnotations,
      _meta: {
        ...toolSecurity("api:write"),
        "openai/fileParams": ["file"],
      },
    },
    async ({ taskRef, file, idempotencyKey }) =>
      writeToolCall(context, async () => {
        await assertAgentTaskAttachmentWriteAccess(context.user, taskRef);
        const downloaded = await fetchMcpFileInput(file, {
          maxBytes: attachmentLimits().maxBytes,
        });
        return createAgentTaskAttachment(
          context.user,
          taskRef,
          {
            body: downloaded.body,
            filename: downloaded.filename,
            claimedMediaType: downloaded.mediaType,
            idempotencyKey,
          },
          toolOrigin(context),
        );
      }),
  );

  server.registerTool(
    "delete_task_attachment",
    {
      title: "Delete native task attachment",
      description:
        "Soft-deletes one unreferenced native attachment using its current version. Remove any description image token first; recovery remains available through the REST API during the grace period.",
      inputSchema: z.object({
        taskRef: reference("Canonical task ref."),
        attachmentRef: reference("Attachment ref from list_task_attachments."),
        version: z.number().int().positive(),
      }),
      annotations: destructiveWriteAnnotations,
      _meta: toolSecurity("api:write"),
    },
    async ({ taskRef, attachmentRef, version }) =>
      writeToolCall(context, () =>
        deleteAgentTaskAttachment(
          context.user,
          taskRef,
          attachmentRef,
          version,
          toolOrigin(context),
        )),
  );

  server.registerTool(
    "list_task_comments",
    {
      title: "List task comment threads",
      description: "Lists bounded native comment threads after resolving an accessible task. Imported Linear comments remain in get_task_external_context.",
      inputSchema: z.object({
        taskRef: reference("Canonical task ref."),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().min(1).optional(),
      }),
      annotations: readAnnotations,
      _meta: toolSecurity("api:read"),
    },
    async ({ taskRef, limit, cursor }) => toolCall(() =>
      listAgentTaskComments(context.user, taskRef, { limit, cursor })),
  );

  server.registerTool(
    "get_task_thread",
    {
      title: "Get task comment thread",
      description: "Gets one ACL-scoped native root thread with bounded replies.",
      inputSchema: z.object({
        taskRef: reference("Canonical task ref."),
        commentRef: reference("Comment ref from list_task_comments."),
      }),
      annotations: readAnnotations,
      _meta: toolSecurity("api:read"),
    },
    async ({ taskRef, commentRef }) => toolCall(() =>
      getAgentTaskThread(context.user, taskRef, commentRef)),
  );

  server.registerTool(
    "add_task_comment",
    {
      title: "Add task comment",
      description: "Adds one native root comment as the authenticated user. Reuse the idempotency key when retrying the same write.",
      inputSchema: z.object({
        taskRef: reference("Canonical task ref."),
        body: z.string().min(1).max(100_000),
        idempotencyKey: z.string().min(1).max(200),
      }),
      annotations: writeAnnotations,
      _meta: toolSecurity("api:write"),
    },
    async ({ taskRef, ...input }) => writeToolCall(context, () =>
      createAgentTaskComment(context.user, taskRef, input)),
  );

  server.registerTool(
    "reply_to_task_comment",
    {
      title: "Reply to task comment",
      description: "Replies one level deep to a native root thread as the authenticated user and reopens a resolved thread.",
      inputSchema: z.object({
        taskRef: reference("Canonical task ref."),
        rootCommentRef: reference("Root comment ref."),
        body: z.string().min(1).max(100_000),
        idempotencyKey: z.string().min(1).max(200),
      }),
      annotations: writeAnnotations,
      _meta: toolSecurity("api:write"),
    },
    async ({ taskRef, rootCommentRef, ...input }) => writeToolCall(context, () =>
      createAgentTaskComment(context.user, taskRef, {
        ...input,
        parentCommentRef: rootCommentRef,
      })),
  );

  server.registerTool(
    "edit_task_comment",
    {
      title: "Edit task comment",
      description: "Edits the authenticated author's native comment using its current version.",
      inputSchema: z.object({
        taskRef: reference("Canonical task ref."),
        commentRef: reference("Comment ref."),
        version: z.number().int().positive(),
        body: z.string().min(1).max(100_000),
      }),
      annotations: writeAnnotations,
      _meta: toolSecurity("api:write"),
    },
    async ({ taskRef, commentRef, ...input }) => writeToolCall(context, () =>
      editAgentTaskComment(context.user, taskRef, commentRef, input)),
  );

  server.registerTool(
    "delete_task_comment",
    {
      title: "Delete task comment",
      description: "Soft-deletes an authorized native comment while preserving thread structure.",
      inputSchema: z.object({
        taskRef: reference("Canonical task ref."),
        commentRef: reference("Comment ref."),
        version: z.number().int().positive(),
      }),
      annotations: destructiveWriteAnnotations,
      _meta: toolSecurity("api:write"),
    },
    async ({ taskRef, commentRef, ...input }) => writeToolCall(context, () =>
      deleteAgentTaskComment(context.user, taskRef, commentRef, input)),
  );

  server.registerTool(
    "set_comment_reaction",
    {
      title: "Set comment reaction",
      description: "Idempotently adds or removes the authenticated user's emoji reaction.",
      inputSchema: z.object({
        taskRef: reference("Canonical task ref."),
        commentRef: reference("Comment ref."),
        emoji: z.string().min(1).max(16),
        active: z.boolean(),
      }),
      annotations: writeAnnotations,
      _meta: toolSecurity("api:write"),
    },
    async ({ taskRef, commentRef, ...input }) => writeToolCall(context, () =>
      setAgentCommentReaction(context.user, taskRef, commentRef, input)),
  );

  server.registerTool(
    "resolve_task_thread",
    {
      title: "Resolve or reopen task thread",
      description: "Sets the desired resolution state of a root thread using its current version.",
      inputSchema: z.object({
        taskRef: reference("Canonical task ref."),
        rootCommentRef: reference("Root comment ref."),
        version: z.number().int().positive(),
        resolved: z.boolean(),
        resolutionCommentRef: z.string().min(1).max(200).nullable().optional(),
      }),
      annotations: writeAnnotations,
      _meta: toolSecurity("api:write"),
    },
    async ({ taskRef, rootCommentRef, ...input }) => writeToolCall(context, () =>
      resolveAgentTaskThread(context.user, taskRef, rootCommentRef, input)),
  );

  return server;
}

export function agentContextFromMcpAuthInfo(authInfo: AuthInfo): AgentAuthorizationContext {
  const extra = authInfo.extra ?? {};
  const user = extra.user;
  if (!isUserRecord(user)) throw new Error("MCP authentication context is missing its user");
  return {
    authorizationId: String(extra.authorizationId ?? ""),
    authorizationType:
      extra.authorizationType === "personal_token" ? "personal_token" : "oauth",
    clientId: authInfo.clientId,
    scopes: authInfo.scopes.filter(isApiScope),
    user,
    expiresAt: authInfo.expiresAt ?? null,
    resource: authInfo.resource?.toString() ?? null,
  };
}

function queryParameters(
  input: Record<string, unknown>,
  names: Record<string, string> = {},
) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const name = names[key] ?? key;
    for (const item of Array.isArray(value) ? value : [value]) {
      result.append(name, String(item));
    }
  }
  return result;
}

async function writeToolCall(
  context: AgentAuthorizationContext,
  action: () => Promise<unknown>,
) {
  if (!context.scopes.includes("api:write")) {
    return authenticationToolError(
      "This connection has read-only access. Reconnect and approve task updates.",
      "api:write",
      context.resource,
    );
  }
  return toolCall(action);
}

async function toolCall(action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await action();
    const structuredContent = normalizeToolResult(value);
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  } catch (error) {
    const mapped = mapToolError(error);
    return {
      isError: true,
      content: [{ type: "text", text: `${mapped.code}: ${mapped.message}` }],
      structuredContent: { error: mapped },
    };
  }
}

function authenticationToolError(message: string, scope: ApiScope, resource: string | null): CallToolResult {
  const metadata = resource
    ? oauthProtectedResourceMetadataUrl(new URL(resource).origin)
    : "/.well-known/oauth-protected-resource/api/mcp";
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: { code: "insufficient_scope", message } },
    _meta: {
      "mcp/www_authenticate": `Bearer resource_metadata="${metadata}", scope="${scope}", error="insufficient_scope", error_description="Additional ${scope} scope is required"`,
    },
  };
}

function normalizeToolResult(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("data" in value && "page" in value) return value as Record<string, unknown>;
    return { data: value };
  }
  return { data: value };
}

function mapToolError(error: unknown) {
  if (error instanceof AgentApiError) {
    return { code: error.code, message: error.message, details: error.details ?? null };
  }
  if (error instanceof ValidationError) return { code: "invalid_argument", message: error.message };
  if (error instanceof NotFoundError) return { code: "not_found", message: "Resource not found" };
  if (error instanceof PermissionError) return { code: "forbidden", message: error.message };
  if (error instanceof ConflictError) return { code: "version_conflict", message: error.message };
  console.error(error);
  return { code: "internal_error", message: "Something went wrong" };
}

function toolSecurity(scope: ApiScope) {
  return { securitySchemes: [{ type: "oauth2", scopes: [scope] }] };
}

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const idempotentWriteAnnotations = {
  ...writeAnnotations,
  idempotentHint: true,
} as const;

const idempotentOpenWorldWriteAnnotations = {
  ...idempotentWriteAnnotations,
  openWorldHint: true,
} as const;

const destructiveWriteAnnotations = {
  ...writeAnnotations,
  destructiveHint: true,
} as const;

function reference(description: string) {
  return z.string().min(1).max(200).describe(description);
}

function toolOrigin(context: AgentAuthorizationContext) {
  if (!context.resource) {
    throw new Error("MCP resource origin is unavailable");
  }
  return new URL(context.resource).origin;
}

function defined(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function isApiScope(value: string): value is ApiScope {
  return value === "api:read" || value === "api:write";
}

function isUserRecord(value: unknown): value is UserRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const user = value as Record<string, unknown>;
  return [user.id, user.displayName, user.email, user.timezone].every(
    (field) => typeof field === "string",
  );
}
