import { ValidationError } from "./domain";

export const GLOBAL_SEARCH_DEFAULT_LIMIT = 8;
export const GLOBAL_SEARCH_MAX_LIMIT = 20;
export const GLOBAL_SEARCH_MAX_OFFSET = 1_000;

export type GlobalSearchEntityType = "task" | "project" | "release" | "view";

type GlobalSearchResultBase = {
  id: string;
  publicId: string;
  title: string;
  context: string;
  href: string;
};

export type GlobalSearchResult =
  | (GlobalSearchResultBase & { type: "task"; identifier: string })
  | (GlobalSearchResultBase & { type: "project" })
  | (GlobalSearchResultBase & { type: "release" })
  | (GlobalSearchResultBase & { type: "view" });

export type GlobalSearchGroups = {
  tasks: Array<Extract<GlobalSearchResult, { type: "task" }>>;
  projects: Array<Extract<GlobalSearchResult, { type: "project" }>>;
  releases: Array<Extract<GlobalSearchResult, { type: "release" }>>;
  views: Array<Extract<GlobalSearchResult, { type: "view" }>>;
};

export type GlobalSearchResponse = {
  query: string;
  groups: GlobalSearchGroups;
  nextCursor: string | null;
  partialErrors: GlobalSearchEntityType[];
};

export type GlobalSearchInput = {
  query: string;
  limit?: number;
  cursor?: string | null;
};

export function normalizeGlobalSearchQuery(input: unknown): string {
  const query = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (query.length > 200) {
    throw new ValidationError("Workspace search is limited to 200 characters");
  }
  return query;
}

export function globalSearchLimit(input: unknown): number {
  if (input === undefined || input === null || input === "") {
    return GLOBAL_SEARCH_DEFAULT_LIMIT;
  }
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError("Workspace search limit must be a positive integer");
  }
  return Math.min(value, GLOBAL_SEARCH_MAX_LIMIT);
}

export function encodeGlobalSearchCursor(
  offset: number,
  query = "",
  limit = GLOBAL_SEARCH_DEFAULT_LIMIT,
): string {
  if (!Number.isInteger(offset) || offset < 0 || offset > GLOBAL_SEARCH_MAX_OFFSET) {
    throw new ValidationError("Workspace search cursor is invalid");
  }
  return btoa(JSON.stringify({ version: 1, offset, query, limit }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeGlobalSearchCursor(
  cursor: string | null | undefined,
  expected?: { query: string; limit: number },
): {
  offset: number;
  query?: string;
  limit?: number;
} {
  if (!cursor) return { offset: 0 };
  if (cursor.length > 512) {
    throw new ValidationError("Workspace search cursor is invalid");
  }
  try {
    const padded = cursor.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(cursor.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded)) as {
      version?: unknown;
      offset?: unknown;
      query?: unknown;
      limit?: unknown;
    };
    if (
      parsed.version !== 1 ||
      !Number.isInteger(parsed.offset) ||
      Number(parsed.offset) < 0 ||
      Number(parsed.offset) > GLOBAL_SEARCH_MAX_OFFSET ||
      typeof parsed.query !== "string" ||
      !Number.isInteger(parsed.limit) ||
      Number(parsed.limit) < 1 ||
      Number(parsed.limit) > GLOBAL_SEARCH_MAX_LIMIT ||
      (expected !== undefined && (
        parsed.query !== expected.query || Number(parsed.limit) !== expected.limit
      ))
    ) {
      throw new Error("invalid cursor payload");
    }
    return {
      offset: Number(parsed.offset),
      query: parsed.query,
      limit: Number(parsed.limit),
    };
  } catch {
    throw new ValidationError("Workspace search cursor is invalid");
  }
}

export function emptyGlobalSearchResponse(query = ""): GlobalSearchResponse {
  return {
    query,
    groups: { tasks: [], projects: [], releases: [], views: [] },
    nextCursor: null,
    partialErrors: [],
  };
}

export function flattenGlobalSearchResults(
  response: Pick<GlobalSearchResponse, "groups">,
): GlobalSearchResult[] {
  return [
    ...response.groups.tasks,
    ...response.groups.projects,
    ...response.groups.releases,
    ...response.groups.views,
  ];
}

export function mergeGlobalSearchResponses(
  current: GlobalSearchResponse,
  incoming: GlobalSearchResponse,
): GlobalSearchResponse {
  const merge = <T extends GlobalSearchResult>(left: T[], right: T[]) => {
    const ids = new Set(left.map((item) => item.id));
    return [...left, ...right.filter((item) => !ids.has(item.id))];
  };
  return {
    ...incoming,
    partialErrors: [...new Set([...current.partialErrors, ...incoming.partialErrors])],
    groups: {
      tasks: merge(current.groups.tasks, incoming.groups.tasks),
      projects: merge(current.groups.projects, incoming.groups.projects),
      releases: merge(current.groups.releases, incoming.groups.releases),
      views: merge(current.groups.views, incoming.groups.views),
    },
  };
}

export function nextGlobalSearchHighlight(
  current: number,
  direction: "next" | "previous",
  count: number,
): number {
  if (count < 1) return 0;
  return direction === "next"
    ? (current + 1) % count
    : (current - 1 + count) % count;
}

export function resolveSearchShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">,
  options: { typing: boolean; localSearchAvailable: boolean },
): "global" | "local" | null {
  if (options.typing) return null;
  if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    return "global";
  }
  if (
    event.key.toLowerCase() === "f" &&
    (event.metaKey || event.ctrlKey) &&
    options.localSearchAvailable
  ) {
    return "local";
  }
  return null;
}
