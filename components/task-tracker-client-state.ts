"use client";

import type { UserPreferenceChanges } from "@/lib/user-preference-save";
import type {
  AppSnapshot,
  TaskRecord,
  UserProfile,
  WorkspaceCatalogKind,
  WorkspaceCatalogPage,
} from "@/lib/types";
import { mergeUnique } from "@/components/task-tracker-snapshot-state";

export class ProfileRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function patchUserPreferences(
  version: number,
  changes: UserPreferenceChanges,
): Promise<UserProfile> {
  const response = await fetch("/api/settings/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version, ...changes }),
  });
  const value = await response.json() as UserProfile | { error: string };
  if (!response.ok || "error" in value) {
    throw new ProfileRequestError(
      "error" in value ? value.error : "Preference could not be saved",
      response.status,
    );
  }
  return value;
}

export async function fetchUserProfile(): Promise<UserProfile> {
  const response = await fetch("/api/settings/profile", { cache: "no-store" });
  const value = await response.json() as UserProfile | { error: string };
  if (!response.ok || "error" in value) {
    throw new ProfileRequestError(
      "error" in value ? value.error : "Profile could not be refreshed",
      response.status,
    );
  }
  return value;
}

export const PULL_REFRESH_THRESHOLD = 72;

export function canStartPullRefresh(input: {
  mobile: boolean;
  coarsePointer: boolean;
  scrollTop: number;
  refreshing: boolean;
  touchCount: number;
}) {
  return input.mobile
    && input.coarsePointer
    && input.scrollTop <= 0
    && !input.refreshing
    && input.touchCount === 1;
}

export function pullRefreshDistance(deltaY: number) {
  return Math.min(104, Math.max(0, deltaY * 0.55));
}

export function shouldTriggerPullRefresh(distance: number) {
  return distance >= PULL_REFRESH_THRESHOLD;
}

export async function fetchTaskSnapshot(
  fetcher: typeof fetch = fetch,
  workspaceScope?: string,
) {
  const path = workspaceScope
    ? `/api/bootstrap?workspace_scope=${encodeURIComponent(workspaceScope)}`
    : "/api/bootstrap";
  const response = await fetcher(path, { cache: "no-store" });
  const value = (await response.json()) as AppSnapshot | { error: string };
  if (!response.ok || "error" in value) {
    throw new Error("error" in value ? value.error : "Refresh failed");
  }
  return value;
}

export async function fetchCompleteWorkspaceCatalog(
  kind: WorkspaceCatalogKind,
  fetcher: typeof fetch = fetch,
  workspaceScope?: string,
): Promise<WorkspaceCatalogPage> {
  let cursor: string | null = null;
  let complete: WorkspaceCatalogPage = {
    kind,
    projects: [],
    releases: [],
    views: [],
    page: { hasMore: false, nextCursor: null },
    total: 0,
  };
  const seenCursors = new Set<string>();
  do {
    const parameters = new URLSearchParams({
      kind,
      limit: "50",
      order: "name",
      direction: "asc",
    });
    if (kind !== "releases") parameters.set("active_only", "1");
    if (workspaceScope) parameters.set("workspace_scope", workspaceScope);
    if (cursor) parameters.set("cursor", cursor);
    const response = await fetcher(`/api/catalog?${parameters}`, { cache: "no-store" });
    const page = await response.json() as WorkspaceCatalogPage | { error: string };
    if (!response.ok || "error" in page) {
      throw new Error("error" in page ? page.error : "Catalog could not be loaded");
    }
    if (page.kind !== kind) throw new Error("Catalog kind did not match the request");
    complete = {
      ...page,
      projects: mergeUnique(complete.projects, page.projects, (item) => item.id),
      releases: mergeUnique(complete.releases, page.releases, (item) => item.id),
      views: mergeUnique(complete.views, page.views, (item) => item.id),
    };
    cursor = page.page.hasMore ? page.page.nextCursor : null;
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error("Catalog pagination did not advance");
      seenCursors.add(cursor);
    }
  } while (cursor);
  return {
    ...complete,
    page: { hasMore: false, nextCursor: null },
  };
}

export function runSingleFlight<T>(
  holder: { current: Promise<T> | null },
  operation: () => Promise<T>,
) {
  if (holder.current) return holder.current;
  const promise = operation().finally(() => {
    if (holder.current === promise) holder.current = null;
  });
  holder.current = promise;
  return promise;
}

export function taskMatchesSearch(
  task: TaskRecord,
  needle: string,
  remoteMatches: ReadonlySet<string> | null,
): boolean {
  if (remoteMatches) return remoteMatches.has(task.id);
  return task.identifier.toLowerCase() === needle ||
    task.identifier.toLowerCase().includes(needle) ||
    task.title.toLowerCase().includes(needle) ||
    (task.description?.toLowerCase().includes(needle) ?? false);
}

export function mergeWorkspaceCatalogPage(
  current: AppSnapshot,
  page: WorkspaceCatalogPage,
): AppSnapshot {
  return {
    ...current,
    projects: mergeUnique(page.projects, current.projects, (item) => item.id),
    releases: mergeUnique(page.releases, current.releases, (item) => item.id),
    views: mergeUnique(page.views, current.views, (item) => item.id),
  };
}

export const builtInViews = [
  { id: "mine", label: "My tasks" },
  { id: "all", label: "All tasks" },
  { id: "active", label: "Active" },
  { id: "backlog", label: "Backlog" },
  { id: "archived", label: "Archived" },
];
