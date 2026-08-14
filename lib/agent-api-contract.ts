import { PRIORITIES, STATUS_CATEGORIES, ValidationError } from "./domain";
import type { Priority, StatusCategory } from "./types";

export const AGENT_API_VERSION = "1";
export const DEFAULT_AGENT_API_LIMIT = 50;
export const MAX_AGENT_API_LIMIT = 200;

export type AgentApiErrorCode =
  | "unauthenticated"
  | "insufficient_scope"
  | "invalid_argument"
  | "not_found"
  | "ambiguous_reference"
  | "version_conflict"
  | "forbidden"
  | "internal_error";

export class AgentApiError extends Error {
  constructor(
    readonly code: AgentApiErrorCode,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export type AgentTaskOrder =
  | "manual"
  | "updated"
  | "created"
  | "priority"
  | "due"
  | "title";

export type AgentTaskListQuery = {
  limit: number;
  offset: number;
  projectRef: string | null;
  releaseRef: string | null;
  statusCategories: StatusCategory[];
  priorities: Priority[];
  assignee: "me" | "unassigned" | null;
  archived: boolean;
  search: string | null;
  order: AgentTaskOrder;
  direction: "asc" | "desc";
  fingerprint: string;
};

export type AgentProjectListQuery = {
  limit: number;
  offset: number;
  search: string | null;
  archived: boolean;
  fingerprint: string;
};

export type AgentReleaseListQuery = {
  limit: number;
  offset: number;
  projectRef: string | null;
  statuses: Array<"planned" | "active" | "released" | "canceled">;
  search: string | null;
  fingerprint: string;
};

export type AgentExternalContextQuery = {
  limit: number;
  offset: number;
  fingerprint: string;
};

const taskQueryParameters = new Set([
  "limit",
  "cursor",
  "project_ref",
  "release_ref",
  "status_category",
  "priority",
  "assignee",
  "archived",
  "search",
  "order",
  "direction",
]);

export async function parseAgentTaskListQuery(
  searchParams: URLSearchParams,
): Promise<AgentTaskListQuery> {
  for (const key of searchParams.keys()) {
    if (!taskQueryParameters.has(key)) {
      throw new AgentApiError(
        "invalid_argument",
        `Unknown query parameter: ${key}`,
        400,
      );
    }
  }

  const limit = integerParameter(
    searchParams.get("limit"),
    DEFAULT_AGENT_API_LIMIT,
    1,
    MAX_AGENT_API_LIMIT,
    "limit",
  );
  const projectRef = optionalBounded(searchParams.get("project_ref"), 200);
  const releaseRef = optionalBounded(searchParams.get("release_ref"), 200);
  const statusCategories = repeatedCatalogValues(
    searchParams.getAll("status_category"),
    STATUS_CATEGORIES,
    "status_category",
  );
  const priorities = repeatedCatalogValues(
    searchParams.getAll("priority"),
    PRIORITIES,
    "priority",
  );
  const assigneeValue = searchParams.get("assignee");
  if (
    assigneeValue !== null &&
    assigneeValue !== "me" &&
    assigneeValue !== "unassigned"
  ) {
    throw new AgentApiError(
      "invalid_argument",
      "assignee must be me or unassigned",
      400,
    );
  }
  const archived = booleanParameter(searchParams.get("archived"), false);
  const search = optionalBounded(searchParams.get("search"), 200);
  const orderValue = searchParams.get("order") ?? "updated";
  if (
    orderValue !== "manual" &&
    orderValue !== "updated" &&
    orderValue !== "created" &&
    orderValue !== "priority" &&
    orderValue !== "due" &&
    orderValue !== "title"
  ) {
    throw new AgentApiError("invalid_argument", "Unknown task order", 400);
  }
  const directionValue = searchParams.get("direction") ??
    (orderValue === "manual" ||
    orderValue === "priority" ||
    orderValue === "due" ||
    orderValue === "title"
      ? "asc"
      : "desc");
  if (directionValue !== "asc" && directionValue !== "desc") {
    throw new AgentApiError(
      "invalid_argument",
      "direction must be asc or desc",
      400,
    );
  }

  const fingerprint = await digestReference(
    "query",
    JSON.stringify({
      limit,
      projectRef,
      releaseRef,
      statusCategories,
      priorities,
      assignee: assigneeValue,
      archived,
      search,
      order: orderValue,
      direction: directionValue,
    }),
  );
  const offset = decodeCursorOffset(searchParams.get("cursor"), fingerprint);

  return {
    limit,
    offset,
    projectRef,
    releaseRef,
    statusCategories,
    priorities,
    assignee: assigneeValue,
    archived,
    search,
    order: orderValue,
    direction: directionValue,
    fingerprint,
  };
}

export async function parseAgentProjectListQuery(
  searchParams: URLSearchParams,
): Promise<AgentProjectListQuery> {
  rejectUnknownParameters(
    searchParams,
    new Set(["limit", "cursor", "search", "archived"]),
  );
  const limit = integerParameter(
    searchParams.get("limit"),
    DEFAULT_AGENT_API_LIMIT,
    1,
    MAX_AGENT_API_LIMIT,
    "limit",
  );
  const search = optionalBounded(searchParams.get("search"), 200);
  const archived = booleanParameter(searchParams.get("archived"), false);
  const fingerprint = await digestReference(
    "query",
    JSON.stringify({ limit, search, archived, resource: "projects" }),
  );
  return {
    limit,
    offset: decodeCursorOffset(searchParams.get("cursor"), fingerprint),
    search,
    archived,
    fingerprint,
  };
}

export async function parseAgentReleaseListQuery(
  searchParams: URLSearchParams,
): Promise<AgentReleaseListQuery> {
  rejectUnknownParameters(
    searchParams,
    new Set(["limit", "cursor", "project_ref", "status", "search"]),
  );
  const limit = integerParameter(
    searchParams.get("limit"),
    DEFAULT_AGENT_API_LIMIT,
    1,
    MAX_AGENT_API_LIMIT,
    "limit",
  );
  const projectRef = optionalBounded(searchParams.get("project_ref"), 200);
  const statuses = repeatedCatalogValues(
    searchParams.getAll("status"),
    ["planned", "active", "released", "canceled"] as const,
    "status",
  );
  const search = optionalBounded(searchParams.get("search"), 200);
  const fingerprint = await digestReference(
    "query",
    JSON.stringify({ limit, projectRef, statuses, search, resource: "releases" }),
  );
  return {
    limit,
    offset: decodeCursorOffset(searchParams.get("cursor"), fingerprint),
    projectRef,
    statuses,
    search,
    fingerprint,
  };
}

export async function parseAgentExternalContextQuery(
  searchParams: URLSearchParams,
  taskReference: string,
): Promise<AgentExternalContextQuery> {
  rejectUnknownParameters(searchParams, new Set(["limit", "cursor"]));
  const limit = integerParameter(searchParams.get("limit"), 50, 1, 100, "limit");
  const fingerprint = await digestReference(
    "query",
    JSON.stringify({ limit, taskReference, resource: "external-context" }),
  );
  return {
    limit,
    offset: decodeCursorOffset(searchParams.get("cursor"), fingerprint),
    fingerprint,
  };
}

export function encodeCursor(offset: number, fingerprint: string): string {
  return base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ offset, fingerprint })),
  );
}

export async function catalogReference(
  kind: "status" | "label",
  internalId: string,
): Promise<string> {
  return digestReference(kind === "status" ? "sts" : "lbl", internalId);
}

export async function digestReference(
  prefix: string,
  value: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `${prefix}_${base64UrlEncode(new Uint8Array(digest)).slice(0, 22)}`;
}

export function decodeCursorOffset(
  value: string | null,
  fingerprint: string,
): number {
  if (value === null) return 0;
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(value)),
    ) as { offset?: unknown; fingerprint?: unknown };
    if (
      !Number.isInteger(parsed.offset) ||
      Number(parsed.offset) < 0 ||
      parsed.fingerprint !== fingerprint
    ) {
      throw new Error("invalid cursor");
    }
    return Number(parsed.offset);
  } catch {
    throw new AgentApiError("invalid_argument", "Cursor is invalid", 400);
  }
}

function rejectUnknownParameters(
  searchParams: URLSearchParams,
  allowed: ReadonlySet<string>,
) {
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new AgentApiError(
        "invalid_argument",
        `Unknown query parameter: ${key}`,
        400,
      );
    }
  }
}

function integerParameter(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new AgentApiError(
      "invalid_argument",
      `${name} must be an integer between ${minimum} and ${maximum}`,
      400,
    );
  }
  return number;
}

function booleanParameter(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new AgentApiError(
    "invalid_argument",
    "archived must be true or false",
    400,
  );
}

function optionalBounded(value: string | null, maximum: number): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new AgentApiError("invalid_argument", "Query value is invalid", 400);
  }
  return normalized;
}

function repeatedCatalogValues<T extends string>(
  values: string[],
  catalog: readonly T[],
  name: string,
): T[] {
  const result: T[] = [];
  for (const value of values.flatMap((item) => item.split(","))) {
    if (!catalog.includes(value as T)) {
      throw new AgentApiError(
        "invalid_argument",
        `Unknown ${name} value`,
        400,
      );
    }
    if (!result.includes(value as T)) result.push(value as T);
  }
  return result;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ValidationError("Invalid base64url");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
