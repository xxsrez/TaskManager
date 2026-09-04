"use client";

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
} from "react";
import {
  mergeDeferredSnapshot,
  snapshotProvesCollectionAbsence,
} from "@/components/task-tracker-state";
import {
  useWorkspaceSyncCoordinator,
  type WorkspaceSyncCheckpoint,
} from "@/components/workspace-sync-coordinator";
import { workspaceSyncAffectsRecentlyDeleted } from "@/lib/deletion-client";
import { reconcileTaskDetailAfterReset, reconcileTaskDetailFromSync } from "@/lib/task-detail-reconciliation";
import type { AppSnapshot, TaskDetailRecord, WorkspaceSyncResponse } from "@/lib/types";
import { applyWorkspaceSync } from "@/lib/workspace-sync-contract";

export function useTaskTrackerSyncController({
  data,
  setData,
  setSelected,
  setPeekTaskId,
  setTaskDetail,
  setForcedTaskDetailId,
  activeTaskId,
  surface,
  workspaceScopeToken,
  captureSyncCheckpoint,
  reconcileIncrementalTasks,
  completeTaskWindow,
  invalidateQuery,
  invalidateCatalogs,
  setRecentlyDeletedEpoch,
  returnToWorkspaceAfterRemoval,
}: {
  data: AppSnapshot;
  setData: Dispatch<SetStateAction<AppSnapshot>>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  setPeekTaskId: Dispatch<SetStateAction<string | null>>;
  setTaskDetail: Dispatch<SetStateAction<TaskDetailRecord | null>>;
  setForcedTaskDetailId: Dispatch<SetStateAction<string | null>>;
  activeTaskId: string | null;
  surface: string;
  workspaceScopeToken: string;
  captureSyncCheckpoint: () => WorkspaceSyncCheckpoint;
  reconcileIncrementalTasks: (changes: WorkspaceSyncResponse["changes"]) => void;
  completeTaskWindow: () => void;
  invalidateQuery: () => void;
  invalidateCatalogs: (clearPages?: boolean) => void;
  setRecentlyDeletedEpoch: Dispatch<SetStateAction<number>>;
  returnToWorkspaceAfterRemoval: () => void;
}) {
  const applyIncrementalSync = useCallback((response: WorkspaceSyncResponse) => {
    const removedTaskIds = new Set(response.changes.tasks.remove);
    const removedProjectIds = new Set(response.changes.projects.remove);
    const removedReleaseIds = new Set(response.changes.releases.remove);
    const removedViewIds = new Set(response.changes.views.remove);
    const unavailableViewIds = new Set([
      ...removedViewIds,
      ...response.changes.views.upsert
        .filter((view) => Boolean(view.archivedAt))
        .map((view) => view.id),
    ]);
    setData((current) => applyWorkspaceSync(current, response));
    setSelected((current) => new Set(
      [...current].filter((taskId) => !removedTaskIds.has(taskId)),
    ));
    setPeekTaskId((current) => current && removedTaskIds.has(current) ? null : current);
    setTaskDetail((current) => current
      ? reconcileTaskDetailFromSync(current, response.changes, response.cursor)
      : current);
    reconcileIncrementalTasks(response.changes);
    if (
      response.changes.projects.upsert.length || removedProjectIds.size ||
      response.changes.releases.upsert.length || removedReleaseIds.size ||
      response.changes.views.upsert.length || removedViewIds.size
    ) {
      invalidateCatalogs();
    }
    if (workspaceSyncAffectsRecentlyDeleted(response)) {
      setRecentlyDeletedEpoch((current) => current + 1);
    }
    const activeTaskWasRemoved = activeTaskId !== null && removedTaskIds.has(activeTaskId);
    const surfaceWasRemoved =
      (surface.startsWith("project:") && removedProjectIds.has(surface.slice(8))) ||
      (surface.startsWith("project-releases:") && removedProjectIds.has(surface.slice("project-releases:".length))) ||
      (surface.startsWith("release:") && removedReleaseIds.has(surface.slice(8))) ||
      (surface.startsWith("view:") && unavailableViewIds.has(surface.slice(5)));
    if (activeTaskWasRemoved || surfaceWasRemoved) returnToWorkspaceAfterRemoval();
  }, [
    activeTaskId,
    invalidateCatalogs,
    reconcileIncrementalTasks,
    returnToWorkspaceAfterRemoval,
    setData,
    setPeekTaskId,
    setRecentlyDeletedEpoch,
    setSelected,
    setTaskDetail,
    surface,
  ]);

  const applySyncReset = useCallback((
    incoming: AppSnapshot,
    checkpoint: WorkspaceSyncCheckpoint,
  ) => {
    setData((current) => mergeDeferredSnapshot(current, incoming, {
      taskIdsAtRequest: checkpoint.taskIds,
      projectIdsAtRequest: checkpoint.projectIds,
      releaseIdsAtRequest: checkpoint.releaseIds,
      viewIdsAtRequest: checkpoint.viewIds,
    }));
    setTaskDetail((current) => current
      ? reconcileTaskDetailAfterReset(current, incoming)
      : current);
    setSelected((current) => new Set(
      [...current].filter(
        (taskId) => incoming.tasks.some((task) => task.id === taskId) ||
          !checkpoint.taskIds.has(taskId),
      ),
    ));
    setPeekTaskId((current) => current && checkpoint.taskIds.has(current) &&
      !incoming.tasks.some((task) => task.id === current)
      ? null
      : current);
    completeTaskWindow();
    invalidateQuery();
    invalidateCatalogs();
    setRecentlyDeletedEpoch((current) => current + 1);
    if (activeTaskId !== null) setForcedTaskDetailId(activeTaskId);
    const surfaceWasRemoved =
      (surface.startsWith("project:") &&
        snapshotProvesCollectionAbsence(incoming, "projects") &&
        checkpoint.projectIds.has(surface.slice(8)) &&
        !incoming.projects.some((project) => project.id === surface.slice(8))) ||
      (surface.startsWith("project-releases:") &&
        snapshotProvesCollectionAbsence(incoming, "projects") &&
        checkpoint.projectIds.has(surface.slice("project-releases:".length)) &&
        !incoming.projects.some((project) => project.id === surface.slice("project-releases:".length))) ||
      (surface.startsWith("release:") &&
        snapshotProvesCollectionAbsence(incoming, "releases") &&
        checkpoint.releaseIds.has(surface.slice(8)) &&
        !incoming.releases.some((release) => release.id === surface.slice(8))) ||
      (surface.startsWith("view:") &&
        snapshotProvesCollectionAbsence(incoming, "views") &&
        checkpoint.viewIds.has(surface.slice(5)) &&
        !incoming.views.some((view) => view.id === surface.slice(5) && !view.archivedAt));
    if (surfaceWasRemoved) returnToWorkspaceAfterRemoval();
  }, [
    activeTaskId,
    completeTaskWindow,
    invalidateCatalogs,
    invalidateQuery,
    returnToWorkspaceAfterRemoval,
    setData,
    setForcedTaskDetailId,
    setPeekTaskId,
    setRecentlyDeletedEpoch,
    setSelected,
    setTaskDetail,
    surface,
  ]);

  useWorkspaceSyncCoordinator({
    cursor: data.syncCursor,
    workspaceScope: workspaceScopeToken,
    captureCheckpoint: captureSyncCheckpoint,
    onIncremental: applyIncrementalSync,
    onReset: applySyncReset,
  });
}
