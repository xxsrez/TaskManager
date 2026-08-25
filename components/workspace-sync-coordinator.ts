"use client";

import { useEffect, useRef } from "react";
import type { AppSnapshot, WorkspaceSyncResponse } from "@/lib/types";
import {
  WORKSPACE_SYNC_INTERVAL_MS,
  WORKSPACE_SYNC_REQUEST_TIMEOUT_MS,
  workspaceSyncRetryDelay,
} from "@/lib/workspace-sync-contract";

export type WorkspaceSyncCheckpoint = {
  taskIds: ReadonlySet<string>;
  projectIds: ReadonlySet<string>;
  releaseIds: ReadonlySet<string>;
  viewIds: ReadonlySet<string>;
};

type WorkspaceSyncCoordinatorOptions = {
  cursor?: string;
  workspaceScope?: string;
  captureCheckpoint: () => WorkspaceSyncCheckpoint;
  onIncremental: (response: WorkspaceSyncResponse) => void;
  onReset: (
    snapshot: AppSnapshot,
    checkpoint: WorkspaceSyncCheckpoint,
  ) => void;
};

type WorkspaceSyncCycleOptions = WorkspaceSyncCoordinatorOptions & {
  signal: AbortSignal;
  fetcher?: typeof fetch;
};

export async function runWorkspaceSyncCycle({
  cursor,
  workspaceScope,
  captureCheckpoint,
  onIncremental,
  onReset,
  signal,
  fetcher = fetch,
}: WorkspaceSyncCycleOptions): Promise<string | undefined> {
  const scopedPath = (path: string) => {
    if (!workspaceScope) return path;
    const url = new URL(path, "https://task-manager.invalid");
    url.searchParams.set("workspace_scope", workspaceScope);
    return `${url.pathname}${url.search}`;
  };
  let nextCursor = cursor;
  let hasMore = true;
  while (hasMore && !signal.aborted) {
    if (!nextCursor) {
      const requestCheckpoint = captureCheckpoint();
      const snapshot = await readSyncJson<AppSnapshot>(
        await fetcher(scopedPath("/api/bootstrap"), { cache: "no-store", signal }),
      );
      nextCursor = snapshot.syncCursor;
      onReset(snapshot, requestCheckpoint);
      hasMore = false;
      continue;
    }

    const response = await readSyncJson<WorkspaceSyncResponse>(
      await fetcher(scopedPath(`/api/sync?cursor=${encodeURIComponent(nextCursor)}`), {
        cache: "no-store",
        signal,
      }),
    );
    nextCursor = response.cursor;
    if (response.resetRequired) {
      const requestCheckpoint = captureCheckpoint();
      const snapshot = await readSyncJson<AppSnapshot>(
        await fetcher(scopedPath("/api/bootstrap"), { cache: "no-store", signal }),
      );
      nextCursor = snapshot.syncCursor ?? response.cursor;
      onReset(snapshot, requestCheckpoint);
      hasMore = false;
    } else {
      onIncremental(response);
      hasMore = response.hasMore;
    }
  }
  return nextCursor;
}

async function readSyncJson<T>(response: Response): Promise<T> {
  const value = (await response.json()) as T | { error: string };
  if (!response.ok || (value && typeof value === "object" && "error" in value)) {
    throw new Error(
      value && typeof value === "object" && "error" in value
        ? value.error
        : "Workspace sync failed",
    );
  }
  return value as T;
}

export function useWorkspaceSyncCoordinator({
  cursor,
  workspaceScope,
  captureCheckpoint,
  onIncremental,
  onReset,
}: WorkspaceSyncCoordinatorOptions) {
  const cursorRef = useRef(cursor);
  const handlersRef = useRef({ workspaceScope, captureCheckpoint, onIncremental, onReset });

  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  useEffect(() => {
    handlersRef.current = { workspaceScope, captureCheckpoint, onIncremental, onReset };
  }, [workspaceScope, captureCheckpoint, onIncremental, onReset]);

  useEffect(() => {
    let timer: number | null = null;
    let controller: AbortController | null = null;
    let requestTimeout: number | null = null;
    let running = false;
    let failureCount = 0;
    let disposed = false;

    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const clearRequestTimeout = () => {
      if (requestTimeout !== null) window.clearTimeout(requestTimeout);
      requestTimeout = null;
    };
    const canPoll = () => document.visibilityState === "visible" && navigator.onLine;
    const schedule = (delay: number) => {
      clearTimer();
      if (disposed || !canPoll()) return;
      timer = window.setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (disposed || !canPoll()) return;
      if (running) {
        schedule(100);
        return;
      }
      running = true;
      controller = new AbortController();
      let timedOut = false;
      requestTimeout = window.setTimeout(() => {
        timedOut = true;
        controller?.abort();
      }, WORKSPACE_SYNC_REQUEST_TIMEOUT_MS);
      try {
        cursorRef.current = await runWorkspaceSyncCycle({
          cursor: cursorRef.current,
          signal: controller.signal,
          ...handlersRef.current,
        });
        failureCount = 0;
        schedule(WORKSPACE_SYNC_INTERVAL_MS);
      } catch (error) {
        if (timedOut || !(error instanceof DOMException && error.name === "AbortError")) {
          schedule(workspaceSyncRetryDelay(failureCount));
          failureCount += 1;
        }
      } finally {
        clearRequestTimeout();
        running = false;
        controller = null;
      }
    };
    const resume = () => {
      if (!canPoll()) return;
      schedule(0);
    };
    const pause = () => {
      clearTimer();
      controller?.abort();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") resume();
      else pause();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("online", resume);
    window.addEventListener("offline", pause);
    schedule(WORKSPACE_SYNC_INTERVAL_MS);

    return () => {
      disposed = true;
      clearTimer();
      clearRequestTimeout();
      controller?.abort();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", pause);
    };
  }, []);
}
