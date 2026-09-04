"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import {
  applyMutationResult,
  fetchTaskSnapshot,
  invalidateTaskActivity,
  mergeTaskMutation,
  scopedUiApiPath,
  taskDetailUiApiPath,
  type MutationResult,
  type TaskSearchState,
} from "@/components/task-tracker-state";
import {
  ALL_ACCESSIBLE_WORKSPACE_SCOPE,
} from "@/lib/workspace-scope";
import {
  mergeLoadedTask,
  mergeTaskDetailContext,
} from "@/lib/task-detail-reconciliation";
import { mergeTaskSummary } from "@/lib/workspace-sync-contract";
import type {
  AppSnapshot,
  TaskDetailRecord,
  TaskRecord,
} from "@/lib/types";
import type { TaskQueryDependency } from "@/lib/task-query-reconciliation";

type MutableValue<T> = { current: T };

export function useTaskTrackerMutationController({
  snapshot,
  workspace,
  tasks,
  onError,
}: {
  snapshot: {
    dataRef: MutableValue<AppSnapshot>;
    setCurrent: (value: AppSnapshot) => void;
    setData: Dispatch<SetStateAction<AppSnapshot>>;
  };
  workspace: {
    surface: string;
    scopeTokenRef: MutableValue<string>;
    focusTokenRef: MutableValue<string>;
    dataRef: MutableValue<AppSnapshot>;
    setCurrent: (value: AppSnapshot) => void;
    setData: Dispatch<SetStateAction<AppSnapshot>>;
    reloadFocus: (token: string) => Promise<unknown>;
  };
  tasks: {
    setDetail: Dispatch<SetStateAction<TaskDetailRecord | null>>;
    setSearch: Dispatch<SetStateAction<TaskSearchState | null>>;
    reconcileMutation: (
      affectedTasks: readonly TaskRecord[],
      before: AppSnapshot,
      after: AppSnapshot,
      additionalDependencies?: Iterable<TaskQueryDependency>,
      allowLocalMembership?: boolean,
    ) => void;
  };
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function refreshSavedViewsAfterConflict() {
    const refreshed = await fetchTaskSnapshot(
      fetch,
      workspace.scopeTokenRef.current || undefined,
    );
    snapshot.setCurrent({
      ...snapshot.dataRef.current,
      views: refreshed.views,
    });
    snapshot.setData((current) => ({
      ...current,
      views: refreshed.views,
    }));
  }

  async function mutate(
    path: string,
    method: string,
    body: unknown,
    options?: {
      onConflict?: () => Promise<void>;
      conflictMessage?: string;
    },
  ) {
    setBusy(true);
    onError("");
    try {
      const response = await fetch(scopedUiApiPath(path, workspace.scopeTokenRef.current), {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = (await response.json()) as MutationResult | { error: string };
      if (!response.ok || "error" in value) {
        if (response.status === 409 && options?.onConflict) {
          await options.onConflict();
          throw new Error(options.conflictMessage ??
            "The record changed in another session. Latest data was reloaded.");
        }
        throw new Error("error" in value ? value.error : "Request failed");
      }
      const before = snapshot.dataRef.current;
      const after = applyMutationResult(before, value);
      snapshot.setCurrent(after);
      snapshot.setData((current) => {
        const next = applyMutationResult(current, value);
        snapshot.setCurrent(next);
        return next;
      });
      if (workspace.surface === "workspace") {
        if (workspace.focusTokenRef.current === ALL_ACCESSIBLE_WORKSPACE_SCOPE) {
          workspace.setCurrent(after);
          workspace.setData(after);
        } else {
          void workspace.reloadFocus(workspace.focusTokenRef.current);
        }
      }
      if ("taskIds" in value && "taskLabels" in value) {
        const replaced = new Set(value.taskIds);
        tasks.setDetail((current) => current && replaced.has(current.task.id)
          ? {
              ...current,
              task: invalidateTaskActivity(current.task),
              labels: value.labels.filter((label) =>
                value.taskLabels.some((item) =>
                  item.taskId === current.task.id && item.labelId === label.id)),
              taskLabels: value.taskLabels.filter((item) =>
                item.taskId === current.task.id),
            }
          : current);
      }
      if ("task" in value) {
        tasks.setDetail((current) => current?.task.id === value.task.id
          ? { ...current, task: mergeTaskMutation(current.task, value.task) }
          : current);
        tasks.setSearch((current) => current
          ? {
              ...current,
              tasks: current.tasks.map((task) => task.id === value.task.id
                ? mergeTaskSummary(task, value.task)
                : task),
            }
          : current);
      }
      if ("taskUpdates" in value) {
        const updates = new Map(value.taskUpdates.map((task) => [task.id, task]));
        tasks.setDetail((current) => {
          const update = current ? updates.get(current.task.id) : undefined;
          return current && update
            ? { ...current, task: mergeTaskMutation(current.task, update) }
            : current;
        });
        tasks.setSearch((current) => current
          ? {
              ...current,
              tasks: current.tasks.map((task) => {
                const update = updates.get(task.id);
                return update ? mergeTaskSummary(task, update) : task;
              }),
            }
          : current);
      }
      if (path.startsWith("/api/tasks")) {
        const additionalDependencies = new Set<TaskQueryDependency>();
        let affectedTasks: TaskRecord[] = [];
        if ("task" in value) {
          affectedTasks = [value.task];
        } else if ("taskUpdates" in value) {
          affectedTasks = value.taskUpdates;
        } else if ("taskIds" in value && "taskLabels" in value) {
          additionalDependencies.add("label");
          additionalDependencies.add("label_group");
          const affected = new Set(value.taskIds);
          affectedTasks = after.tasks.filter((task) => affected.has(task.id));
        } else {
          const anchorMatch = path.match(/^\/api\/tasks\/([^/]+)\/(parent|subtasks)$/);
          if (anchorMatch) {
            const anchorId = decodeURIComponent(anchorMatch[1]!);
            const affected = new Set<string>([anchorId]);
            const beforeAnchor = before.tasks.find((task) => task.id === anchorId);
            const afterAnchor = after.tasks.find((task) => task.id === anchorId);
            if (beforeAnchor?.parentTaskId) affected.add(beforeAnchor.parentTaskId);
            if (afterAnchor?.parentTaskId) affected.add(afterAnchor.parentTaskId);
            if (anchorMatch[2] === "subtasks") {
              const beforeIds = new Set(before.tasks.map((task) => task.id));
              for (const task of after.tasks) {
                if (!beforeIds.has(task.id)) affected.add(task.id);
              }
            }
            additionalDependencies.add("parent");
            additionalDependencies.add("subtasks");
            affectedTasks = after.tasks.filter((task) => affected.has(task.id));
          }
        }
        tasks.reconcileMutation(
          affectedTasks,
          before,
          after,
          additionalDependencies,
        );
      }
      return true;
    } catch (requestError) {
      onError(requestError instanceof Error ? requestError.message : "Request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createTask(
    input: Record<string, unknown>,
  ): Promise<TaskRecord | null> {
    setBusy(true);
    onError("");
    try {
      const response = await fetch(
        scopedUiApiPath("/api/tasks", workspace.scopeTokenRef.current),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      const value = (await response.json()) as
        | (AppSnapshot & { createdTask: { id: string; publicId: string } })
        | { error: string };
      if (!response.ok || "error" in value) {
        throw new Error("error" in value ? value.error : "Task could not be created");
      }
      const { createdTask, ...nextSnapshot } = value;
      const task = nextSnapshot.tasks.find((item) => item.id === createdTask.id) ?? null;
      const before = snapshot.dataRef.current;
      snapshot.setCurrent(nextSnapshot);
      snapshot.setData(nextSnapshot);
      if (task) tasks.reconcileMutation([task], before, nextSnapshot);
      return task;
    } catch (requestError) {
      onError(requestError instanceof Error ? requestError.message : "Task could not be created");
      return null;
    } finally {
      setBusy(false);
    }
  }

  function updateClientTask(
    taskId: string,
    update: (task: TaskRecord) => TaskRecord,
  ) {
    snapshot.setData((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === taskId ? update(task) : task),
    }));
    tasks.setSearch((current) => current
      ? {
          ...current,
          tasks: current.tasks.map((task) => task.id === taskId ? update(task) : task),
        }
      : current);
    tasks.setDetail((current) => current?.task.id === taskId
      ? { ...current, task: update(current.task) }
      : current);
  }

  async function refreshTaskDetail(taskId: string): Promise<TaskRecord | null> {
    onError("");
    try {
      const response = await fetch(
        taskDetailUiApiPath(taskId, workspace.scopeTokenRef.current),
        { cache: "no-store" },
      );
      const value = (await response.json()) as TaskDetailRecord | { error: string };
      if (!response.ok || "error" in value) {
        throw new Error("error" in value ? value.error : "Could not refresh task");
      }
      const retained = snapshot.dataRef.current.tasks.find((task) => task.id === taskId);
      if (retained && retained.version > value.task.version) return retained;
      snapshot.setCurrent(mergeTaskDetailContext(snapshot.dataRef.current, value));
      tasks.setDetail((current) => current?.task.id === taskId
        ? { ...value, task: mergeLoadedTask(current.task, value.task) }
        : current);
      snapshot.setData((current) => {
        const currentTask = current.tasks.find((task) => task.id === taskId);
        if (currentTask && currentTask.version > value.task.version) return current;
        const next = mergeTaskDetailContext(current, value);
        snapshot.setCurrent(next);
        return next;
      });
      return value.task;
    } catch (requestError) {
      onError(requestError instanceof Error ? requestError.message : "Could not refresh task");
      return null;
    }
  }

  return {
    busy,
    mutate,
    createTask,
    updateClientTask,
    refreshTaskDetail,
    refreshSavedViewsAfterConflict,
  };
}
