import type { ApiScope } from "./api-credential-crypto";
import {
  authenticateApiCredential,
  type ApiCredentialContext,
} from "./api-credentials";
import {
  AGENT_API_VERSION,
  AgentApiError,
  type AgentApiErrorCode,
} from "./agent-api-contract";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from "./domain";

export type AgentApiPage = {
  nextCursor: string | null;
  hasMore: boolean;
};

export type AgentApiResult<T> = {
  data: T;
  page?: AgentApiPage;
  status?: number;
};

export async function withAgentApi<T>(
  request: Request,
  requiredScope: ApiScope,
  action: (
    context: ApiCredentialContext,
  ) => Promise<AgentApiResult<T>>,
): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    const context = await authenticateApiCredential(request, requiredScope);
    const result = await action(context);
    return agentJson(
      {
        data: result.data,
        ...(result.page ? { page: result.page } : {}),
        meta: {
          apiVersion: AGENT_API_VERSION,
          asOf: new Date().toISOString(),
          requestId,
        },
      },
      result.status ?? 200,
      requestId,
    );
  } catch (error) {
    const mapped = mapApiError(error);
    if (mapped.status >= 500) console.error(error);
    const response = agentJson(
      {
        error: {
          code: mapped.code,
          message: mapped.message,
          requestId,
          ...(mapped.details === undefined
            ? {}
            : { details: mapped.details }),
        },
      },
      mapped.status,
      requestId,
    );
    if (mapped.status === 401) {
      response.headers.set(
        "WWW-Authenticate",
        'Bearer realm="task-manager", error="invalid_token"',
      );
    }
    return response;
  }
}

function agentJson(
  value: unknown,
  status: number,
  requestId: string,
): Response {
  const response = Response.json(value, { status });
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Request-Id", requestId);
  return response;
}

function mapApiError(error: unknown): {
  code: AgentApiErrorCode;
  message: string;
  status: number;
  details?: unknown;
} {
  if (error instanceof AgentApiError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      details: error.details,
    };
  }
  if (error instanceof ValidationError) {
    return { code: "invalid_argument", message: error.message, status: 400 };
  }
  if (error instanceof NotFoundError) {
    return { code: "not_found", message: "Resource not found", status: 404 };
  }
  if (error instanceof PermissionError) {
    return { code: "forbidden", message: error.message, status: 403 };
  }
  if (error instanceof ConflictError) {
    return {
      code: "version_conflict",
      message: error.message,
      status: 409,
    };
  }
  return {
    code: "internal_error",
    message: "Something went wrong",
    status: 500,
  };
}
