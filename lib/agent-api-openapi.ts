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
      "Standalone bearer-token API for compact task discovery and task execution. Administrative, backup, sharing, and credential-management operations are intentionally absent.",
  },
  servers: [{ url: "/api/agent/v1" }],
  security: [{ bearerAuth: [] }],
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
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "tm_pat" },
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
          relations: { type: "array", items: { type: "object" } },
          provenance: { type: ["object", "null"] },
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
