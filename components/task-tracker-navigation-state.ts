"use client";

import {
  navigationHistoryState,
  type ResolvedNavigation,
} from "@/lib/navigation";
import { parseWorkspaceScopeToken } from "@/lib/workspace-scope";

export const workspaceScopeHistoryKey = "taskManagerWorkspaceScope";

export function workspaceScopeStorageKey(userId: string) {
  return `tm-workspace-scope:${userId}`;
}

export function navigationStateWithWorkspaceScope(
  navigation: ResolvedNavigation,
  workspaceScope: string,
) {
  return {
    ...navigationHistoryState(navigation),
    [workspaceScopeHistoryKey]: workspaceScope,
  };
}

export function navigationStateForWorkspaceScope(
  navigation: ResolvedNavigation,
  workspaceScope: string,
) {
  return navigation.surface === "workspace"
    ? navigationStateWithWorkspaceScope(navigation, workspaceScope)
    : navigationHistoryState(navigation);
}

export function workspaceScopeFromHistory(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[workspaceScopeHistoryKey];
  return parseWorkspaceScopeToken(value)?.token ?? null;
}

export function scopedUiApiPath(path: string, workspaceScope: string) {
  if (!workspaceScope) return path;
  const url = new URL(path, "https://task-manager.invalid");
  url.searchParams.set("workspace_scope", workspaceScope);
  return `${url.pathname}${url.search}`;
}

export function taskDetailUiApiPath(taskId: string, workspaceScope: string) {
  return scopedUiApiPath(
    `/api/tasks/${encodeURIComponent(taskId)}`,
    workspaceScope,
  );
}
