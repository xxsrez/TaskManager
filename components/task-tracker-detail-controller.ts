"use client";

import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useState,
} from "react";
import {
  mergeLoadedTask,
  mergeTaskDetailContext,
  taskNeedsDetailRefresh,
} from "@/lib/task-detail-reconciliation";
import { mergeTaskSummary } from "@/lib/workspace-sync-contract";
import type {
  AppSnapshot,
  TaskDetailRecord,
  TaskRecord,
  WorkspaceCatalogKind,
} from "@/lib/types";
import { taskDetailUiApiPath } from "@/components/task-tracker-state";

export function useTaskTrackerDetailState() {
  const [taskDetail, setTaskDetail] = useState<TaskDetailRecord | null>(null);
  const [forcedTaskDetailId, setForcedTaskDetailId] = useState<string | null>(null);
  return {
    taskDetail,
    setTaskDetail,
    forcedTaskDetailId,
    setForcedTaskDetailId,
  };
}

export function useTaskTrackerDetailController({
  data,
  dataRef,
  setData,
  taskPool,
  activeTaskId,
  peekTaskId,
  taskDetail,
  setTaskDetail,
  forcedTaskDetailId,
  setForcedTaskDetailId,
  workspaceScopeToken,
  ensureCompleteCatalogs,
  returnToWorkspaceAfterRemoval,
  onError,
}: {
  data: AppSnapshot;
  dataRef: MutableRefObject<AppSnapshot>;
  setData: Dispatch<SetStateAction<AppSnapshot>>;
  taskPool: TaskRecord[];
  activeTaskId: string | null;
  peekTaskId: string | null;
  taskDetail: TaskDetailRecord | null;
  setTaskDetail: Dispatch<SetStateAction<TaskDetailRecord | null>>;
  forcedTaskDetailId: string | null;
  setForcedTaskDetailId: Dispatch<SetStateAction<string | null>>;
  workspaceScopeToken: string;
  ensureCompleteCatalogs: (
    kinds: readonly WorkspaceCatalogKind[],
    trackLoading?: boolean,
  ) => Promise<unknown>;
  returnToWorkspaceAfterRemoval: () => void;
  onError: (message: string) => void;
}) {
  const activeTaskSummary = taskPool.find((task) => task.id === activeTaskId);
  const activeTask = taskDetail?.task.id === activeTaskId
    ? activeTaskSummary
      ? mergeTaskSummary(taskDetail.task, activeTaskSummary)
      : taskDetail.task
    : activeTaskSummary ?? null;
  const peekTask = taskPool.find((task) => task.id === peekTaskId) ?? null;
  const deferredTaskId = activeTask?.description === null
    ? activeTask.id
    : peekTask && taskNeedsDetailRefresh(peekTask)
      ? peekTask.id
      : null;
  const taskDetailRequestId = forcedTaskDetailId ?? deferredTaskId;

  useEffect(() => {
    if (!activeTaskId) return;
    void ensureCompleteCatalogs(["projects", "releases"]).catch((requestError: unknown) => {
      onError(requestError instanceof Error ? requestError.message : "Catalog could not be loaded");
    });
  }, [activeTaskId, ensureCompleteCatalogs, onError]);

  useEffect(() => {
    if (!taskDetailRequestId) return;
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(
        taskDetailUiApiPath(taskDetailRequestId, workspaceScopeToken),
        { cache: "no-store", signal: controller.signal },
      );
      const value = (await response.json()) as TaskDetailRecord | { error: string };
      if (response.status === 403 || response.status === 404) {
        setForcedTaskDetailId((current) => current === taskDetailRequestId ? null : current);
        setTaskDetail((current) => current?.task.id === taskDetailRequestId ? null : current);
        if (activeTaskId === taskDetailRequestId) returnToWorkspaceAfterRemoval();
        return;
      }
      if (!response.ok || "error" in value) {
        throw new Error("error" in value ? value.error : "Request failed");
      }
      setTaskDetail((current) => ({
        ...value,
        task: mergeLoadedTask(
          current?.task.id === value.task.id
            ? current.task
            : dataRef.current.tasks.find((task) => task.id === value.task.id),
          value.task,
        ),
      }));
      setData((current) => mergeTaskDetailContext(current, value));
      setForcedTaskDetailId((current) => current === taskDetailRequestId ? null : current);
    })().catch((requestError: unknown) => {
      if (requestError instanceof DOMException && requestError.name === "AbortError") return;
      setForcedTaskDetailId((current) => current === taskDetailRequestId ? null : current);
      onError(requestError instanceof Error ? requestError.message : "Could not load task details");
    });
    return () => controller.abort();
  }, [
    activeTaskId,
    dataRef,
    onError,
    returnToWorkspaceAfterRemoval,
    setData,
    setForcedTaskDetailId,
    setTaskDetail,
    taskDetailRequestId,
    workspaceScopeToken,
  ]);

  const activeDetailsData = activeTask && taskDetail?.task.id === activeTask.id
    ? mergeTaskDetailContext(data, { ...taskDetail, task: activeTask })
    : data;
  const taskPropertyCatalogReady =
    (data.catalogCoverage?.projects ?? "complete") === "complete" &&
    (data.catalogCoverage?.releases ?? "complete") === "complete";

  return {
    activeTask,
    peekTask,
    activeDetailsData,
    taskPropertyCatalogReady,
  };
}
