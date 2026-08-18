const metaSchema = {
  type: "object",
  required: ["apiVersion", "asOf", "requestId"],
  properties: {
    apiVersion: { const: "1" },
    asOf: { type: "string", format: "date-time" },
    requestId: { type: "string" },
  },
  additionalProperties: false,
} as const;

const pageSchema = {
  type: "object",
  required: ["nextCursor", "hasMore"],
  properties: {
    nextCursor: { type: ["string", "null"] },
    hasMore: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

const errorResponses = {
  "400": { $ref: "#/components/responses/Error" },
  "401": { $ref: "#/components/responses/Error" },
  "403": { $ref: "#/components/responses/Error" },
  "404": { $ref: "#/components/responses/Error" },
  "409": { $ref: "#/components/responses/Error" },
} as const;

const listParameters = [
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  },
  { name: "cursor", in: "query", schema: { type: "string" } },
] as const;

export const agentApiOpenApi = {
  openapi: "3.1.0",
  info: {
    title: "Task Manager Agent API",
    version: "1.0.0",
    description:
      "OAuth-first API for compact task discovery and task execution. Personal tokens remain available for development and scripts. Administrative, backup, sharing, and credential-management operations are intentionally absent.",
  },
  servers: [{ url: "/api/agent/v1" }],
  security: [{ oauth2: ["api:read"] }, { personalToken: [] }],
  paths: {
    "/workspace": {
      get: {
        operationId: "getWorkspace",
        summary: "Get accessible workspace counts and workflow statuses",
        responses: {
          "200": envelopeResponse("Workspace summary", {
            type: "object",
            additionalProperties: true,
          }),
          ...errorResponses,
        },
      },
    },
    "/projects": {
      get: {
        operationId: "listProjects",
        summary: "List accessible projects without project descriptions",
        parameters: [
          ...listParameters,
          { name: "search", in: "query", schema: { type: "string", maxLength: 200 } },
          { name: "archived", in: "query", schema: { type: "boolean", default: false } },
        ],
        responses: {
          "200": listResponse("Project summaries", {
            $ref: "#/components/schemas/ProjectSummary",
          }),
          ...errorResponses,
        },
      },
    },
    "/projects/{ref}": {
      get: {
        operationId: "getProject",
        summary: "Get one project with description and compact releases",
        parameters: [referenceParameter()],
        responses: {
          "200": envelopeResponse("Project detail", {
            $ref: "#/components/schemas/ProjectDetail",
          }),
          ...errorResponses,
        },
      },
    },
    "/releases": {
      get: {
        operationId: "listReleases",
        summary: "List accessible releases without descriptions or release notes",
        parameters: [
          ...listParameters,
          { name: "project_ref", in: "query", schema: { type: "string" } },
          {
            name: "status",
            in: "query",
            schema: {
              type: "array",
              items: { enum: ["planned", "active", "released", "canceled"] },
            },
            explode: true,
          },
          { name: "search", in: "query", schema: { type: "string", maxLength: 200 } },
        ],
        responses: {
          "200": listResponse("Release summaries", {
            $ref: "#/components/schemas/ReleaseSummary",
          }),
          ...errorResponses,
        },
      },
    },
    "/releases/{ref}": {
      get: {
        operationId: "getRelease",
        summary: "Get one release including description and release notes",
        parameters: [referenceParameter()],
        responses: {
          "200": envelopeResponse("Release detail", {
            $ref: "#/components/schemas/ReleaseDetail",
          }),
          ...errorResponses,
        },
      },
    },
    "/tasks": {
      get: {
        operationId: "listTasks",
        summary: "Search compact task summaries; task bodies are never returned",
        parameters: [
          ...listParameters,
          { name: "project_ref", in: "query", schema: { type: "string" } },
          { name: "release_ref", in: "query", schema: { type: "string" } },
          {
            name: "status_category",
            in: "query",
            schema: {
              type: "array",
              items: {
                enum: ["backlog", "unstarted", "started", "completed", "canceled"],
              },
            },
            explode: true,
          },
          {
            name: "priority",
            in: "query",
            schema: {
              type: "array",
              items: { enum: ["urgent", "high", "medium", "low", "none"] },
            },
            explode: true,
          },
          { name: "assignee", in: "query", schema: { enum: ["me", "unassigned"] } },
          { name: "archived", in: "query", schema: { type: "boolean", default: false } },
          { name: "search", in: "query", schema: { type: "string", maxLength: 200 } },
          {
            name: "order",
            in: "query",
            schema: { enum: ["manual", "updated", "created", "priority", "due", "title"] },
          },
          { name: "direction", in: "query", schema: { enum: ["asc", "desc"] } },
        ],
        responses: {
          "200": listResponse("Task summaries", {
            $ref: "#/components/schemas/TaskSummary",
          }),
          ...errorResponses,
        },
      },
      post: {
        operationId: "createTask",
        summary: "Create a task using canonical project, release, and status refs",
        security: [{ oauth2: ["api:write"] }, { personalToken: [] }],
        requestBody: jsonRequest("#/components/schemas/TaskCreate"),
        responses: {
          "201": envelopeResponse("Created task", {
            $ref: "#/components/schemas/TaskDetail",
          }),
          ...errorResponses,
        },
      },
    },
    "/tasks/{ref}": {
      get: {
        operationId: "getTask",
        summary: "Get one full task without its unbounded imported archive",
        parameters: [referenceParameter()],
        responses: {
          "200": envelopeResponse("Task detail", {
            $ref: "#/components/schemas/TaskDetail",
          }),
          ...errorResponses,
        },
      },
      patch: {
        operationId: "updateTask",
        summary: "Update or move a task with optimistic version checking",
        security: [{ oauth2: ["api:write"] }, { personalToken: [] }],
        parameters: [referenceParameter()],
        requestBody: jsonRequest("#/components/schemas/TaskUpdate"),
        responses: {
          "200": envelopeResponse("Updated task", {
            $ref: "#/components/schemas/TaskDetail",
          }),
          ...errorResponses,
        },
      },
    },
    "/tasks/{ref}/relations": {
      post: {
        operationId: "createTaskRelation",
        summary: "Create a versioned native relation between two editable project tasks",
        security: [{ oauth2: ["api:write"] }, { personalToken: [] }],
        parameters: [referenceParameter()],
        requestBody: jsonRequest("#/components/schemas/TaskRelationCreate"),
        responses: {
          "200": envelopeResponse("Created relation and updated task detail", {
            $ref: "#/components/schemas/TaskRelationMutation",
          }),
          ...errorResponses,
        },
      },
    },
    "/tasks/{ref}/relations/{relationRef}": {
      patch: {
        operationId: "updateTaskRelation",
        summary: "Change a relation type or direction using its current version",
        security: [{ oauth2: ["api:write"] }, { personalToken: [] }],
        parameters: [referenceParameter(), relationReferenceParameter()],
        requestBody: jsonRequest("#/components/schemas/TaskRelationUpdate"),
        responses: {
          "200": envelopeResponse("Updated relation and task detail", {
            $ref: "#/components/schemas/TaskRelationMutation",
          }),
          ...errorResponses,
        },
      },
      delete: {
        operationId: "deleteTaskRelation",
        summary: "Remove a relation without guessing a previous duplicate status",
        security: [{ oauth2: ["api:write"] }, { personalToken: [] }],
        parameters: [referenceParameter(), relationReferenceParameter()],
        requestBody: jsonRequest("#/components/schemas/TaskRelationDelete"),
        responses: {
          "200": envelopeResponse("Removed relation and updated task detail", {
            type: "object",
            additionalProperties: true,
          }),
          ...errorResponses,
        },
      },
    },
    "/tasks/{ref}/attachments": {
      get: {
        operationId: "listTaskAttachments",
        summary: "List one bounded page of private native attachment metadata",
        parameters: [
          referenceParameter(),
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
          { name: "cursor", in: "query", schema: { type: "string" } },
          {
            name: "include_deleted",
            in: "query",
            schema: { type: "boolean", default: false },
            description: "Editor-only recovery view.",
          },
        ],
        responses: {
          "200": listResponse("Native attachment metadata", {
            $ref: "#/components/schemas/Attachment",
          }),
          ...errorResponses,
        },
      },
      post: {
        operationId: "uploadTaskAttachment",
        summary: "Upload one bounded binary into private Task storage",
        security: [{ oauth2: ["api:write"] }, { personalToken: [] }],
        parameters: [
          referenceParameter(),
          requiredHeader("Idempotency-Key", "Stable retry key for the identical binary."),
          requiredHeader(
            "X-Attachment-Filename",
            "Percent-encoded original filename.",
          ),
        ],
        requestBody: {
          required: true,
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
            "application/pdf": {
              schema: { type: "string", format: "binary" },
            },
            "image/png": {
              schema: { type: "string", format: "binary" },
            },
            "image/jpeg": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        responses: {
          "201": envelopeResponse("Created native attachment", {
            $ref: "#/components/schemas/Attachment",
          }),
          ...errorResponses,
        },
      },
    },
    "/tasks/{ref}/attachments/{attachmentRef}": {
      get: {
        operationId: "getTaskAttachment",
        summary: "Get one native attachment's metadata and private content links",
        parameters: [referenceParameter(), attachmentReferenceParameter()],
        responses: {
          "200": envelopeResponse("Native attachment metadata", {
            $ref: "#/components/schemas/Attachment",
          }),
          ...errorResponses,
        },
      },
      patch: {
        operationId: "restoreTaskAttachment",
        summary: "Restore a soft-deleted attachment during its recovery window",
        security: [{ oauth2: ["api:write"] }, { personalToken: [] }],
        parameters: [referenceParameter(), attachmentReferenceParameter()],
        requestBody: jsonRequest("#/components/schemas/AttachmentRestore"),
        responses: {
          "200": envelopeResponse("Restored native attachment", {
            $ref: "#/components/schemas/Attachment",
          }),
          ...errorResponses,
        },
      },
      delete: {
        operationId: "deleteTaskAttachment",
        summary: "Soft-delete an unreferenced attachment using its current version",
        security: [{ oauth2: ["api:write"] }, { personalToken: [] }],
        parameters: [
          referenceParameter(),
          attachmentReferenceParameter(),
          requiredHeader("X-Attachment-Version", "Current optimistic version."),
        ],
        responses: {
          "200": envelopeResponse("Deleted native attachment", {
            $ref: "#/components/schemas/Attachment",
          }),
          ...errorResponses,
        },
      },
    },
    "/tasks/{ref}/attachments/{attachmentRef}/content": {
      get: {
        operationId: "downloadTaskAttachment",
        summary: "Download an ACL-checked original or image thumbnail",
        parameters: [
          referenceParameter(),
          attachmentReferenceParameter(),
          {
            name: "variant",
            in: "query",
            schema: { enum: ["original", "thumbnail"], default: "original" },
          },
          {
            name: "Range",
            in: "header",
            schema: { type: "string" },
            description: "Single byte range for the original variant.",
          },
        ],
        responses: {
          "200": binaryResponse("Original or thumbnail content"),
          "206": binaryResponse("Partial original content"),
          "416": { description: "Requested byte range is unsatisfiable" },
          ...errorResponses,
        },
      },
    },
    "/tasks/{ref}/external-context": {
      get: {
        operationId: "getTaskExternalContext",
        summary: "Read paginated imported comments and attachment links",
        parameters: [
          referenceParameter(),
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": pagedResponse("Imported task context", {
            type: "object",
            additionalProperties: true,
          }),
          ...errorResponses,
        },
      },
    },
    "/tasks/{ref}/comments": {
      get: {
        operationId: "listTaskComments",
        summary: "List bounded native comment threads for an accessible task",
        parameters: [
          referenceParameter(),
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 25 } },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": pagedResponse("Native comment threads", { type: "object", additionalProperties: true }),
          ...errorResponses,
        },
      },
      post: {
        operationId: "createTaskComment",
        summary: "Create a native root comment or reply as the authenticated user",
        security: [{ oauth2: ["api:write"] }, { personalToken: [] }],
        parameters: [referenceParameter()],
        requestBody: jsonRequest("#/components/schemas/CommentCreate"),
        responses: {
          "201": envelopeResponse("Created native comment", { $ref: "#/components/schemas/Comment" }),
          ...errorResponses,
        },
      },
    },
    "/tasks/{ref}/comments/{commentRef}": {
      get: {
        operationId: "getTaskCommentThread",
        summary: "Get one native root thread with bounded replies",
        parameters: [referenceParameter(), commentReferenceParameter()],
        responses: {
          "200": envelopeResponse("Native comment thread", { type: "object", additionalProperties: true }),
          ...errorResponses,
        },
      },
      patch: {
        operationId: "editTaskComment",
        summary: "Edit the authenticated author's comment with optimistic versioning",
        security: [{ oauth2: ["api:write"] }, { personalToken: [] }],
        parameters: [referenceParameter(), commentReferenceParameter()],
        requestBody: jsonRequest("#/components/schemas/CommentEdit"),
        responses: {
          "200": envelopeResponse("Edited comment", { $ref: "#/components/schemas/Comment" }),
          ...errorResponses,
        },
      },
      delete: {
        operationId: "deleteTaskComment",
        summary: "Soft-delete an authorized comment while preserving its thread",
        security: [{ oauth2: ["api:write"] }, { personalToken: [] }],
        parameters: [referenceParameter(), commentReferenceParameter()],
        requestBody: jsonRequest("#/components/schemas/CommentVersion"),
        responses: {
          "200": envelopeResponse("Deleted comment tombstone", { $ref: "#/components/schemas/Comment" }),
          ...errorResponses,
        },
      },
    },
    "/tasks/{ref}/comments/{commentRef}/reactions": {
      put: {
        operationId: "setTaskCommentReaction",
        summary: "Idempotently set the authenticated user's emoji reaction",
        security: [{ oauth2: ["api:write"] }, { personalToken: [] }],
        parameters: [referenceParameter(), commentReferenceParameter()],
        requestBody: jsonRequest("#/components/schemas/CommentReactionSet"),
        responses: { "200": envelopeResponse("Reaction summary", { type: "array", items: { type: "object" } }), ...errorResponses },
      },
    },
    "/tasks/{ref}/comments/{commentRef}/resolution": {
      put: {
        operationId: "setTaskCommentResolution",
        summary: "Resolve or reopen a native root thread with optimistic versioning",
        security: [{ oauth2: ["api:write"] }, { personalToken: [] }],
        parameters: [referenceParameter(), commentReferenceParameter()],
        requestBody: jsonRequest("#/components/schemas/CommentResolutionSet"),
        responses: { "200": envelopeResponse("Updated root comment", { $ref: "#/components/schemas/Comment" }), ...errorResponses },
      },
    },
  },
  components: {
    securitySchemes: {
      oauth2: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: "/oauth/authorize",
            tokenUrl: "/oauth/token",
            refreshUrl: "/oauth/token",
            scopes: {
              "api:read": "Read accessible tasks, projects, releases, and catalogs",
              "api:write": "Create and update accessible tasks",
            },
          },
        },
      },
      personalToken: { type: "http", scheme: "bearer", bearerFormat: "tm_pat" },
    },
    responses: {
      Error: {
        description: "Request failed",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorEnvelope" },
          },
        },
      },
    },
    schemas: {
      Meta: metaSchema,
      Page: pageSchema,
      ErrorEnvelope: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message", "requestId"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              requestId: { type: "string" },
              details: {},
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      StatusSummary: {
        type: "object",
        required: ["ref", "name", "category"],
        properties: {
          ref: { type: "string" },
          name: { type: "string" },
          category: {
            enum: ["backlog", "unstarted", "started", "completed", "canceled"],
          },
        },
        additionalProperties: true,
      },
      TaskSummary: {
        type: "object",
        required: [
          "ref",
          "identifier",
          "title",
          "status",
          "priority",
          "project",
          "release",
          "labels",
          "updatedAt",
          "version",
          "contextHints",
        ],
        properties: {
          ref: { type: "string" },
          identifier: { type: "string" },
          title: { type: "string" },
          status: { $ref: "#/components/schemas/StatusSummary" },
          priority: { enum: ["urgent", "high", "medium", "low", "none"] },
          project: { type: ["object", "null"] },
          release: { type: ["object", "null"] },
          assignee: { type: ["object", "null"] },
          labels: { type: "array", items: { type: "object" } },
          dueDate: { type: ["string", "null"], format: "date" },
          updatedAt: { type: "string", format: "date-time" },
          version: { type: "integer", minimum: 1 },
          contextHints: { type: "object" },
        },
        additionalProperties: false,
      },
      TaskDetail: {
        type: "object",
        required: [
          "ref",
          "identifier",
          "title",
          "status",
          "description",
          "lifecycle",
          "subtasks",
          "relations",
        ],
        properties: {
          ref: { type: "string" },
          identifier: { type: "string" },
          title: { type: "string" },
          status: { $ref: "#/components/schemas/StatusSummary" },
          description: { type: "string" },
          estimate: { type: ["integer", "null"] },
          rank: { type: "number" },
          access: { type: "object" },
          lifecycle: { type: "object" },
          parent: { type: ["object", "null"] },
          subtasks: { type: "array", items: { type: "object" } },
          relations: {
            type: "array",
            items: { $ref: "#/components/schemas/TaskRelation" },
          },
          provenance: { type: ["object", "null"] },
          availableStatuses: {
            type: "array",
            items: { $ref: "#/components/schemas/StatusSummary" },
          },
        },
        additionalProperties: true,
      },
      ProjectSummary: {
        type: "object",
        required: ["ref", "name", "summary", "status", "taskCounts", "updatedAt", "version"],
        properties: {
          ref: { type: "string" },
          name: { type: "string" },
          summary: { type: "string" },
          status: { type: "string" },
          targetDate: { type: ["string", "null"], format: "date" },
          taskCounts: { type: "object" },
          progress: { type: "number", minimum: 0, maximum: 1 },
          releaseCount: { type: "integer" },
          updatedAt: { type: "string", format: "date-time" },
          version: { type: "integer" },
        },
        additionalProperties: false,
      },
      ProjectDetail: {
        type: "object",
        required: ["ref", "name", "description", "releases"],
        properties: {
          ref: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          startDate: { type: ["string", "null"] },
          releases: { type: "array", items: { type: "object" } },
          workflowStatuses: {
            type: "array",
            items: { $ref: "#/components/schemas/StatusSummary" },
          },
        },
        additionalProperties: true,
      },
      ReleaseSummary: {
        type: "object",
        required: ["ref", "project", "name", "status", "taskCounts", "updatedAt", "version"],
        properties: {
          ref: { type: "string" },
          project: { type: "object" },
          name: { type: "string" },
          status: { enum: ["planned", "active", "released", "canceled"] },
          targetDate: { type: ["string", "null"] },
          releasedAt: { type: ["string", "null"] },
          taskCounts: { type: "object" },
          progress: { type: "number" },
          updatedAt: { type: "string" },
          version: { type: "integer" },
        },
        additionalProperties: false,
      },
      ReleaseDetail: {
        type: "object",
        required: ["ref", "name", "description", "releaseNotes"],
        properties: {
          ref: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          releaseNotes: { type: "string" },
          createdAt: { type: "string" },
          workflowStatuses: {
            type: "array",
            items: { $ref: "#/components/schemas/StatusSummary" },
          },
        },
        additionalProperties: true,
      },
      TaskCreate: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 500 },
          description: { type: "string", maxLength: 50000 },
          statusRef: { type: "string" },
          priority: { enum: ["urgent", "high", "medium", "low", "none"] },
          projectRef: { type: ["string", "null"] },
          releaseRef: { type: ["string", "null"] },
          estimate: { type: ["integer", "null"] },
          dueDate: { type: ["string", "null"], format: "date" },
        },
        additionalProperties: false,
      },
      TaskUpdate: {
        type: "object",
        required: ["version"],
        properties: {
          version: { type: "integer", minimum: 1 },
          title: { type: "string", minLength: 1, maxLength: 500 },
          description: { type: "string", maxLength: 50000 },
          statusRef: { type: "string" },
          priority: { enum: ["urgent", "high", "medium", "low", "none"] },
          projectRef: { type: ["string", "null"] },
          releaseRef: { type: ["string", "null"] },
          estimate: { type: ["integer", "null"] },
          dueDate: { type: ["string", "null"], format: "date" },
          rank: { type: "number" },
          archived: { type: "boolean" },
        },
        additionalProperties: false,
      },
      TaskRelation: {
        type: "object",
        required: [
          "ref",
          "type",
          "direction",
          "presentation",
          "version",
          "createdAt",
          "updatedAt",
          "task",
        ],
        properties: {
          ref: { type: "string" },
          type: { enum: ["blocks", "related", "duplicate_of"] },
          direction: { enum: ["outgoing", "incoming"] },
          presentation: {
            enum: ["blocks", "blocked_by", "related", "duplicate_of", "duplicates"],
          },
          version: { type: "integer", minimum: 1 },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          task: { type: "object" },
        },
        additionalProperties: false,
      },
      TaskRelationMutation: {
        type: "object",
        required: ["relation", "task"],
        properties: {
          relation: { $ref: "#/components/schemas/TaskRelation" },
          task: { $ref: "#/components/schemas/TaskDetail" },
        },
        additionalProperties: false,
      },
      TaskRelationCreate: {
        type: "object",
        required: ["targetTaskRef", "type", "direction", "idempotencyKey"],
        properties: {
          targetTaskRef: { type: "string", minLength: 1, maxLength: 200 },
          type: { enum: ["blocks", "related", "duplicate_of"] },
          direction: { enum: ["outgoing", "incoming"] },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
          taskVersion: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      TaskRelationUpdate: {
        type: "object",
        required: ["version", "type", "direction"],
        properties: {
          version: { type: "integer", minimum: 1 },
          type: { enum: ["blocks", "related", "duplicate_of"] },
          direction: { enum: ["outgoing", "incoming"] },
          taskVersion: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      TaskRelationDelete: {
        type: "object",
        required: ["version"],
        properties: { version: { type: "integer", minimum: 1 } },
        additionalProperties: false,
      },
      Attachment: {
        type: "object",
        required: [
          "ref",
          "filename",
          "mediaType",
          "byteSize",
          "checksumSha256",
          "kind",
          "state",
          "version",
          "links",
        ],
        properties: {
          ref: { type: "string" },
          filename: { type: "string" },
          mediaType: { type: "string" },
          byteSize: { type: "integer", minimum: 1 },
          checksumSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          kind: { enum: ["image", "file"] },
          state: { enum: ["uploading", "ready", "failed", "deleted"] },
          imageWidth: { type: ["integer", "null"] },
          imageHeight: { type: ["integer", "null"] },
          variants: { type: "object" },
          failureCode: { type: ["string", "null"] },
          version: { type: "integer", minimum: 1 },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          deletedAt: { type: ["string", "null"], format: "date-time" },
          links: {
            type: "object",
            required: ["metadata", "original", "thumbnail"],
            properties: {
              metadata: { type: "string", format: "uri" },
              original: { type: ["string", "null"], format: "uri" },
              thumbnail: { type: ["string", "null"], format: "uri" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      AttachmentRestore: {
        type: "object",
        required: ["version", "deleted"],
        properties: {
          version: { type: "integer", minimum: 1 },
          deleted: { const: false },
        },
        additionalProperties: false,
      },
      Comment: {
        type: "object",
        required: ["ref", "author", "body", "createdAt", "updatedAt", "version", "reactions", "permissions"],
        properties: {
          ref: { type: "string" },
          parentCommentRef: { type: ["string", "null"] },
          author: { type: "object" },
          body: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          deletedAt: { type: ["string", "null"] },
          resolvedAt: { type: ["string", "null"] },
          resolutionCommentRef: { type: ["string", "null"] },
          version: { type: "integer", minimum: 1 },
          reactions: { type: "array", items: { type: "object" } },
          permissions: { type: "object" },
        },
        additionalProperties: false,
      },
      CommentCreate: {
        type: "object",
        required: ["body", "idempotencyKey"],
        properties: {
          body: { type: "string", minLength: 1, maxLength: 100000 },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
          parentCommentRef: { type: "string" },
        },
        additionalProperties: false,
      },
      CommentEdit: {
        type: "object",
        required: ["version", "body"],
        properties: {
          version: { type: "integer", minimum: 1 },
          body: { type: "string", minLength: 1, maxLength: 100000 },
        },
        additionalProperties: false,
      },
      CommentVersion: {
        type: "object",
        required: ["version"],
        properties: { version: { type: "integer", minimum: 1 } },
        additionalProperties: false,
      },
      CommentReactionSet: {
        type: "object",
        required: ["emoji", "active"],
        properties: {
          emoji: { type: "string", minLength: 1, maxLength: 16 },
          active: { type: "boolean" },
        },
        additionalProperties: false,
      },
      CommentResolutionSet: {
        type: "object",
        required: ["version", "resolved"],
        properties: {
          version: { type: "integer", minimum: 1 },
          resolved: { type: "boolean" },
          resolutionCommentRef: { type: ["string", "null"] },
        },
        additionalProperties: false,
      },
    },
  },
} as const;

function referenceParameter() {
  return {
    name: "ref",
    in: "path",
    required: true,
    schema: { type: "string" },
  } as const;
}

function commentReferenceParameter() {
  return {
    name: "commentRef",
    in: "path",
    required: true,
    schema: { type: "string" },
  } as const;
}

function attachmentReferenceParameter() {
  return {
    name: "attachmentRef",
    in: "path",
    required: true,
    schema: { type: "string" },
  } as const;
}

function relationReferenceParameter() {
  return {
    name: "relationRef",
    in: "path",
    required: true,
    schema: { type: "string" },
  } as const;
}

function requiredHeader(name: string, description: string) {
  return {
    name,
    in: "header",
    required: true,
    description,
    schema: { type: "string" },
  } as const;
}

function jsonRequest(schemaReference: string) {
  return {
    required: true,
    content: {
      "application/json": { schema: { $ref: schemaReference } },
    },
  } as const;
}

function envelopeResponse(description: string, dataSchema: object) {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["data", "meta"],
          properties: { data: dataSchema, meta: metaSchema },
          additionalProperties: false,
        },
      },
    },
  } as const;
}

function binaryResponse(description: string) {
  return {
    description,
    content: {
      "application/octet-stream": {
        schema: { type: "string", format: "binary" },
      },
      "image/*": { schema: { type: "string", format: "binary" } },
    },
  } as const;
}

function listResponse(description: string, itemSchema: object) {
  return pagedResponse(description, { type: "array", items: itemSchema });
}

function pagedResponse(description: string, dataSchema: object) {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["data", "page", "meta"],
          properties: {
            data: dataSchema,
            page: pageSchema,
            meta: metaSchema,
          },
          additionalProperties: false,
        },
      },
    },
  } as const;
}
