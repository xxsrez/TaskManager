"use client";

import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useState,
} from "react";
import {
  pruneTaskSearchAfterDeletion,
} from "@/components/task-tracker-query-controller";
import {
  useRecoverableDeletionController,
  type RecoverableDeletionState,
} from "@/components/task-tracker-deletion-controller";
import type { TaskSearchState } from "@/components/task-tracker-state";
import { pruneDeletedEntityFromSnapshot } from "@/lib/deletion-client";
import type { Layout } from "@/lib/navigation";
import type { AppSnapshot, TaskDetailRecord } from "@/lib/types";

export function useTaskTrackerDeletionIntegrationController({
  dataRef,
  setData,
  setSelected,
  setTaskSearch,
  setTaskDetail,
  setForcedTaskDetailId,
  setPeekTaskId,
  invalidateQuery,
  invalidateCatalogs,
  refreshTaskList,
  activeTaskId,
  surface,
  closeTask,
  navigateSurface,
  workspaceScopeTokenRef,
  setDialog,
  onError,
}: {
  dataRef: MutableRefObject<AppSnapshot>;
  setData: Dispatch<SetStateAction<AppSnapshot>>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  setTaskSearch: Dispatch<SetStateAction<TaskSearchState | null>>;
  setTaskDetail: Dispatch<SetStateAction<TaskDetailRecord | null>>;
  setForcedTaskDetailId: Dispatch<SetStateAction<string | null>>;
  setPeekTaskId: Dispatch<SetStateAction<string | null>>;
  invalidateQuery: () => void;
  invalidateCatalogs: (clearPages?: boolean) => void;
  refreshTaskList: () => Promise<AppSnapshot>;
  activeTaskId: string | null;
  surface: string;
  closeTask: () => void;
  navigateSurface: (surface: string, layout?: Layout) => void;
  workspaceScopeTokenRef: MutableRefObject<string>;
  setDialog: Dispatch<SetStateAction<import("@/components/task-tracker-state").Dialog>>;
  onError: (message: string) => void;
}) {
  const [recentlyDeletedEpoch, setRecentlyDeletedEpoch] = useState(0);

  async function refreshAfterDeletionMutation() {
    // Catalog pages are independent lazy responses and can otherwise keep a
    // restored Project/Release/View hidden. Invalidate before the network read
    // so a failed bootstrap cannot retain privileged stale catalog controls.
    invalidateCatalogs(true);
    setRecentlyDeletedEpoch((current) => current + 1);
    const snapshot = await refreshTaskList();
    return snapshot;
  }

  function applyImmediateDeletionPrune(target: RecoverableDeletionState) {
    const { type, id } = target;
    const next = pruneDeletedEntityFromSnapshot(
      dataRef.current,
      type,
      id,
      target.projectActiveNavigation,
    );
    dataRef.current = next;
    setData(next);
    invalidateCatalogs(true);
    setSelected((current) => {
      if (type === "task") return new Set([...current].filter((taskId) => taskId !== id));
      if (type !== "project") return current;
      return new Set([...current].filter((taskId) => next.tasks.some((task) => task.id === taskId)));
    });
    setTaskSearch((current) => pruneTaskSearchAfterDeletion(current, type, id));
    setTaskDetail((current) => current && next.tasks.some((task) => task.id === current.task.id) ? current : null);
    setForcedTaskDetailId(null);
    setPeekTaskId((current) => current && next.tasks.some((task) => task.id === current) ? current : null);
    invalidateQuery();
    setRecentlyDeletedEpoch((current) => current + 1);
  }

  function navigateAfterRecoverableDelete(target: RecoverableDeletionState) {
    const activeTask = activeTaskId
      ? dataRef.current.tasks.find((task) => task.id === activeTaskId)
      : null;
    const removesActiveTask = target.type === "task" && activeTaskId === target.id ||
      target.type === "project" && activeTask?.projectId === target.id;
    if (removesActiveTask) closeTask();
    if (target.type === "project" && (
      surface === `project:${target.id}` ||
      surface === `project-releases:${target.id}`
    )) {
      navigateSurface("projects", "list");
    } else if (target.type === "release" && surface === `release:${target.id}`) {
      const release = dataRef.current.releases.find((item) => item.id === target.id);
      navigateSurface(release ? `project-releases:${release.projectId}` : "releases", "list");
    } else if (target.type === "saved_view" && surface === `view:${target.id}`) {
      navigateSurface("views", "list");
    }
  }

  const deletion = useRecoverableDeletionController({
    dataRef,
    workspaceScopeTokenRef,
    onError,
    onDismissDialog: () => setDialog(null),
    onDeleted: (target) => {
      navigateAfterRecoverableDelete(target);
      applyImmediateDeletionPrune(target);
    },
    refreshAfterMutation: refreshAfterDeletionMutation,
  });

  return {
    ...deletion,
    recentlyDeletedEpoch,
    setRecentlyDeletedEpoch,
    refreshAfterDeletionMutation,
  };
}
