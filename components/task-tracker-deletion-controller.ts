"use client";

import { useState } from "react";
import type { RecoverableDeleteTarget } from "@/components/deletion-dialogs";
import { scopedUiApiPath } from "@/components/task-tracker-state";
import type { ContextualActionEntity } from "@/lib/contextual-actions";
import {
  convergeDeletionWorkspace,
  deletionErrorRequiresRefetch,
  fetchProjectDeletionPreview,
  fetchReleaseDeletionPreview,
  notifyRecentlyDeletedChanged,
  performDeletionAction,
  projectDeletionImpactLines,
  type DeletionLifecycleResult,
  type ProjectActiveNavigationCounts,
} from "@/lib/deletion-client";
import { taskMutationVersion } from "@/lib/task-detail-reconciliation";
import type { AppSnapshot } from "@/lib/types";

export type RecoverableDeletionState = RecoverableDeleteTarget & {
  id: string;
  version: number;
  confirmReleasedComposition: boolean;
  projectActiveNavigation?: ProjectActiveNavigationCounts;
};

type DeletionUndoState = {
  type: RecoverableDeletionState["type"];
  id: string;
  version: number;
  label: string;
};

export function useRecoverableDeletionController({
  dataRef,
  workspaceScopeTokenRef,
  onError,
  onDismissDialog,
  onDeleted,
  refreshAfterMutation,
}: {
  dataRef: { current: AppSnapshot };
  workspaceScopeTokenRef: { current: string };
  onError: (message: string) => void;
  onDismissDialog: () => void;
  onDeleted: (target: RecoverableDeletionState) => void;
  refreshAfterMutation: () => Promise<unknown>;
}) {
  const [pending, setPending] = useState<RecoverableDeletionState | null>(null);
  const [undo, setUndo] = useState<DeletionUndoState | null>(null);
  const [busy, setBusy] = useState(false);
  const [convergenceError, setConvergenceError] = useState("");

  const deletionFetcher: typeof fetch = (input, init) => {
    if (typeof input !== "string") return fetch(input, init);
    return fetch(scopedUiApiPath(input, workspaceScopeTokenRef.current), init);
  };

  async function convergeDeletionState() {
    const convergence = await convergeDeletionWorkspace(refreshAfterMutation);
    if (convergence.ok) {
      setConvergenceError("");
      return true;
    }
    setConvergenceError(convergence.message);
    return false;
  }

  async function selfHealStaleDeletionState() {
    setPending(null);
    setUndo(null);
    await convergeDeletionState();
  }

  async function retryConvergence() {
    if (busy) return;
    setBusy(true);
    await convergeDeletionState();
    setBusy(false);
  }

  async function openRecoverableDelete(entity: ContextualActionEntity) {
    if (busy) return;
    onError("");
    if (entity.kind === "release") {
      setBusy(true);
      try {
        const preview = await fetchReleaseDeletionPreview(
          entity.id,
          entity.version,
          deletionFetcher,
        );
        setPending({
          type: "release",
          id: preview.id,
          version: preview.version,
          displayName: preview.displayName,
          context: preview.context,
          description: "This moves the Release to Recently deleted for 30 days. Tasks stay available, and their saved Release membership returns on restore.",
          warning: preview.requiresReleasedCompositionConfirmation
            ? "This Release is already released. Removing it changes the visible composition of released work."
            : null,
          impactLines: [
            `${preview.taskMemberships.toLocaleString()} linked Task${preview.taskMemberships === 1 ? "" : "s"} will keep its content and temporarily show no Release.`,
          ],
          acknowledgement: preview.requiresReleasedCompositionConfirmation
            ? "Confirm changing the composition of this released Release."
            : null,
          confirmReleasedComposition: preview.requiresReleasedCompositionConfirmation,
        });
        onDismissDialog();
      } catch (requestError) {
        if (deletionErrorRequiresRefetch(requestError)) await selfHealStaleDeletionState();
        onError(requestError instanceof Error
          ? requestError.message
          : "Release deletion impact could not be loaded");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (entity.kind === "task") {
      const task = dataRef.current.tasks.find((item) => item.id === entity.id);
      if (!task) return;
      const project = dataRef.current.projects.find((item) => item.id === task.projectId);
      onDismissDialog();
      setPending({
        type: "task",
        id: task.id,
        version: taskMutationVersion(task),
        displayName: `${task.identifier} · ${task.title}`,
        context: project?.name ?? null,
        description: "This moves the Task to Recently deleted for 30 days. Its content, comments, relations, Activity, and Attachments are kept. Archive remains a separate action.",
        warning: null,
        impactLines: [],
        acknowledgement: null,
        confirmReleasedComposition: false,
      });
      return;
    }

    if (entity.kind === "project") {
      const project = dataRef.current.projects.find((item) => item.id === entity.id);
      if (!project) return;
      setBusy(true);
      try {
        const preview = await fetchProjectDeletionPreview(
          project.id,
          project.version,
          deletionFetcher,
        );
        setPending({
          type: "project",
          id: preview.id,
          version: preview.version,
          displayName: preview.displayName,
          context: preview.context,
          description: "This moves the Project to Recently deleted for 30 days. Its Tasks, Releases, and project-scoped Saved Views temporarily disappear, but those children are not deleted independently. Archive remains a separate action.",
          warning: "Restoring the Project removes only the Project shadow. Children deleted separately stay in Recently deleted.",
          impactLines: projectDeletionImpactLines(preview),
          acknowledgement: null,
          confirmReleasedComposition: false,
          projectActiveNavigation: preview.activeNavigation,
        });
        onDismissDialog();
      } catch (requestError) {
        if (deletionErrorRequiresRefetch(requestError)) await selfHealStaleDeletionState();
        onError(requestError instanceof Error
          ? requestError.message
          : "Project deletion impact could not be loaded");
      } finally {
        setBusy(false);
      }
      return;
    }

    const view = dataRef.current.views.find((item) => item.id === entity.id);
    if (!view || view.archivedAt) return;
    onDismissDialog();
    setPending({
      type: "saved_view",
      id: view.id,
      version: view.version,
      displayName: view.name,
      context: view.scopeProjectId ? "Project-scoped Saved View" : "Workspace Saved View",
      description: "This moves the Saved View to Recently deleted for 30 days. Tasks, its saved formula, Display, and scope are preserved; temporary URL filters are never materialized into it.",
      warning: null,
      impactLines: [],
      acknowledgement: null,
      confirmReleasedComposition: false,
    });
  }

  async function deleteRecoverably() {
    const target = pending;
    if (!target || busy) return;
    setBusy(true);
    onError("");
    try {
      const result = await performDeletionAction(
        target.type,
        target.id,
        "delete",
        target.version,
        {
          fetcher: deletionFetcher,
          input: target.confirmReleasedComposition
            ? { confirmReleasedComposition: true }
            : {},
        },
      );
      if (!("entity" in result)) throw new Error("Deletion response was incomplete");
      const entity: DeletionLifecycleResult = result.entity;
      onDeleted(target);
      setPending(null);
      setUndo({
        type: target.type,
        id: target.id,
        version: entity.version,
        label: target.displayName,
      });
      notifyRecentlyDeletedChanged();
      await convergeDeletionState();
    } catch (requestError) {
      if (deletionErrorRequiresRefetch(requestError)) await selfHealStaleDeletionState();
      onError(requestError instanceof Error ? requestError.message : "Deletion failed");
    } finally {
      setBusy(false);
    }
  }

  async function undoRecoverableDelete() {
    const currentUndo = undo;
    if (!currentUndo || busy) return;
    setBusy(true);
    onError("");
    try {
      const result = await performDeletionAction(
        currentUndo.type,
        currentUndo.id,
        "restore_deleted",
        currentUndo.version,
        { fetcher: deletionFetcher },
      );
      if (!("entity" in result)) throw new Error("Restore response was incomplete");
      setUndo(null);
      notifyRecentlyDeletedChanged();
      await convergeDeletionState();
    } catch (requestError) {
      if (deletionErrorRequiresRefetch(requestError)) await selfHealStaleDeletionState();
      onError(requestError instanceof Error ? requestError.message : "Restore failed");
    } finally {
      setBusy(false);
    }
  }

  return {
    pending,
    undo,
    busy,
    convergenceError,
    open: openRecoverableDelete,
    confirm: deleteRecoverably,
    undoDelete: undoRecoverableDelete,
    retryConvergence,
    closePending: () => setPending(null),
    dismissUndo: () => setUndo(null),
  };
}
