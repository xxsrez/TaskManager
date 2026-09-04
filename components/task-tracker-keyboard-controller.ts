"use client";

import { useEffect, type Dispatch, type SetStateAction } from "react";
import { resolveSearchShortcut } from "@/lib/global-search";
import {
  dispatchTaskKeyboardIntegrationCommand,
  keyboardCommandFor,
  moveTaskHighlight,
  reconcileTaskInteraction,
} from "@/lib/task-keyboard";
import {
  resolveKeyboardContextualEntities,
  type ContextualActionEntity,
} from "@/lib/contextual-actions";
import type { AppSnapshot, ViewQuery } from "@/lib/types";
import type {
  Dialog,
  PendingProjectGroupMove,
} from "@/components/task-tracker-state";
import type { RecoverableDeletionState } from "@/components/task-tracker-deletion-controller";
import {
  isCollectionSurface,
  setsEqual,
  taskContextualEntity,
} from "@/components/task-tracker-view";

type MutableValue<T> = { current: T };

export function useTaskTrackerKeyboardController({
  context,
  layers,
  selection,
  controls,
  actions,
  resetKeys,
}: {
  context: {
    surface: string;
    data: AppSnapshot;
    activeTaskId: string | null;
    canCreateTask: boolean;
  };
  layers: {
    globalSearchOpen: boolean;
    mobileActionsOpen: boolean;
    mobileSidebarOpen: boolean;
    accountMenuOpen: boolean;
    pendingProjectMove: PendingProjectGroupMove | null;
    dialog: Dialog | null;
    peekTaskId: string | null;
    filterOpen: boolean;
    displayOpen: boolean;
    contextualMenuOpen: boolean;
    recoverableDeletion: RecoverableDeletionState | null;
    busy: boolean;
    systemBackupBusy: boolean;
  };
  selection: {
    highlightedTaskId: string | null;
    keyboardTaskIds: string[];
    keyboardTaskIdsKey: string;
    selectableTaskIds: Set<string>;
    selectableTaskIdsKey: string;
    selected: Set<string>;
    surfaceContextualEntity: ContextualActionEntity | null;
    getAnchor: () => string | null;
    setAnchor: (value: string | null) => void;
    getPreviousTaskIds: () => string[];
    setPreviousTaskIds: (value: string[]) => void;
  };
  controls: {
    setHighlightedTaskId: Dispatch<SetStateAction<string | null>>;
    setSelected: Dispatch<SetStateAction<Set<string>>>;
    setPendingProjectMove: Dispatch<SetStateAction<PendingProjectGroupMove | null>>;
    setDialog: Dispatch<SetStateAction<Dialog | null>>;
    setPeekTaskId: Dispatch<SetStateAction<string | null>>;
    setDisplayOpen: Dispatch<SetStateAction<boolean>>;
    setFilterOpen: Dispatch<SetStateAction<boolean>>;
    setMobileActionsOpen: Dispatch<SetStateAction<boolean>>;
    setAccountMenuOpen: Dispatch<SetStateAction<boolean>>;
    displayTriggerRef: MutableValue<HTMLButtonElement | null>;
    filterTriggerRef: MutableValue<HTMLButtonElement | null>;
    accountTriggerRef: MutableValue<HTMLButtonElement | null>;
  };
  actions: {
    focusLocalSearch: () => void;
    closeContextualActions: () => void;
    closeGlobalSearch: () => void;
    closeTask: () => void;
    closeMobileSidebar: () => void;
    openGlobalSearch: () => void;
    openCreate: () => Promise<unknown>;
    focusedContextualActionEntity: (element: HTMLElement) => ContextualActionEntity | null;
    openContextualActions: (
      context: { entities: ContextualActionEntity[] },
      x: number,
      y: number,
      restoreFocus: HTMLElement | null,
    ) => void;
    toggleFilters: (focusEditor?: boolean) => Promise<void>;
    toggleSelection: (id: string, extendRange?: boolean) => void;
    openTask: (taskId: string) => void;
    toggleLayout: () => void;
  };
  resetKeys: {
    search: string;
    temporaryQuery: ViewQuery;
  };
}) {
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
      const searchShortcut = resolveSearchShortcut(event, {
        typing,
        localSearchAvailable: !isCollectionSurface(context.surface) &&
          context.surface !== "admin" && context.surface !== "workspace",
      });
      if (searchShortcut === "local") {
        event.preventDefault();
        actions.focusLocalSearch();
        return;
      }
      const layerOwnsKeyboard = Boolean(
        layers.globalSearchOpen || layers.mobileActionsOpen || layers.mobileSidebarOpen ||
        layers.accountMenuOpen || layers.pendingProjectMove || layers.dialog || layers.peekTaskId ||
        layers.filterOpen || layers.displayOpen || layers.contextualMenuOpen ||
        layers.recoverableDeletion,
      );
      const command = keyboardCommandFor(event, { layerOwnsKeyboard });
      if (!command) return;
      if (
        command === "escape" &&
        context.activeTaskId &&
        !layers.dialog &&
        event.target instanceof Element &&
        event.target.closest("[role='dialog'][aria-modal='true']")
      ) return;
      if (
        context.activeTaskId &&
        command !== "escape" &&
        command !== "toggle-details" &&
        command !== "contextual-actions"
      ) return;

      const focusHighlightedTask = () => {
        const taskId = selection.highlightedTaskId;
        if (!taskId) return;
        window.setTimeout(() => {
          document.querySelector<HTMLElement>(
            `[data-task-keyboard-id="${CSS.escape(taskId)}"]`,
          )?.focus();
        }, 0);
      };

      if (command === "escape") {
        let handled = true;
        if (layers.contextualMenuOpen) actions.closeContextualActions();
        else if (layers.globalSearchOpen) actions.closeGlobalSearch();
        else if (layers.pendingProjectMove) {
          if (!layers.busy) controls.setPendingProjectMove(null);
          else handled = false;
        } else if (layers.dialog) {
          if (layers.dialog !== "systemImport" || !layers.systemBackupBusy) {
            controls.setDialog(null);
          } else handled = false;
        } else if (context.activeTaskId) {
          actions.closeTask();
          focusHighlightedTask();
        } else if (layers.peekTaskId) {
          controls.setPeekTaskId(null);
          focusHighlightedTask();
        } else if (layers.displayOpen) {
          controls.setDisplayOpen(false);
          controls.displayTriggerRef.current?.focus();
        } else if (layers.filterOpen) {
          controls.setFilterOpen(false);
          controls.filterTriggerRef.current?.focus();
        } else if (layers.mobileActionsOpen) controls.setMobileActionsOpen(false);
        else if (layers.mobileSidebarOpen) actions.closeMobileSidebar();
        else if (layers.accountMenuOpen) {
          controls.setAccountMenuOpen(false);
          controls.accountTriggerRef.current?.focus();
        } else if (selection.selected.size) {
          controls.setSelected(new Set());
          selection.setAnchor(null);
        } else handled = false;
        if (handled) event.preventDefault();
        return;
      }

      if (command === "global-search") {
        const claimed = dispatchTaskKeyboardIntegrationCommand(window, {
          command,
          taskId: selection.highlightedTaskId ?? selection.keyboardTaskIds[0] ?? null,
          selectedTaskIds: [...selection.selected],
          surface: context.surface,
        });
        event.preventDefault();
        if (!claimed) actions.openGlobalSearch();
        return;
      }
      if (context.surface === "admin") return;
      if (command === "compose") {
        if (!context.canCreateTask) return;
        event.preventDefault();
        void actions.openCreate();
        return;
      }

      const integrationTaskId = selection.highlightedTaskId ?? selection.keyboardTaskIds[0] ?? null;
      if (command === "contextual-actions") {
        const focusedEntity = actions.focusedContextualActionEntity(target);
        const activeTaskEntity = context.activeTaskId
          ? context.data.tasks.find((task) => task.id === context.activeTaskId)
          : null;
        const entities = resolveKeyboardContextualEntities(
          context.data.tasks.map(taskContextualEntity),
          selection.selected,
          focusedEntity,
          activeTaskEntity ? taskContextualEntity(activeTaskEntity) : null,
          integrationTaskId,
        );
        const taskEntities = entities.filter((entity) => entity.kind === "task");
        const primaryEntity = entities.length === 1 ? entities[0]! : null;
        const claimed = primaryEntity?.kind === "task" || taskEntities.length > 1
          ? dispatchTaskKeyboardIntegrationCommand(window, {
              command,
              taskId: primaryEntity?.kind === "task" ? primaryEntity.id : null,
              selectedTaskIds: taskEntities.map((entity) => entity.id),
              surface: context.surface,
            })
          : false;
        event.preventDefault();
        if (!claimed) {
          const contextualEntities = entities.length
            ? entities
            : selection.surfaceContextualEntity
              ? [selection.surfaceContextualEntity]
              : [];
          if (contextualEntities.length) {
            actions.openContextualActions(
              { entities: contextualEntities },
              Math.max(8, window.innerWidth / 2 - 120),
              Math.max(8, window.innerHeight / 3),
              document.activeElement instanceof HTMLElement ? document.activeElement : null,
            );
          }
        }
        return;
      }

      if (isCollectionSurface(context.surface)) return;
      if (command === "filter") {
        event.preventDefault();
        controls.setDisplayOpen(false);
        void actions.toggleFilters(true);
      } else if (command === "display") {
        event.preventDefault();
        controls.setFilterOpen(false);
        controls.setDisplayOpen(true);
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(
            ".display-anchor .popover select, .display-anchor .popover button",
          )?.focus();
        });
      } else if (command === "toggle-layout") {
        event.preventDefault();
        actions.toggleLayout();
      } else if (command === "highlight-next" || command === "highlight-previous") {
        event.preventDefault();
        const next = moveTaskHighlight(
          selection.highlightedTaskId,
          selection.keyboardTaskIds,
          command === "highlight-next" ? 1 : -1,
        );
        controls.setHighlightedTaskId(next);
        if (next) {
          window.requestAnimationFrame(() => {
            document.querySelector<HTMLElement>(
              `[data-task-keyboard-id="${CSS.escape(next)}"]`,
            )?.scrollIntoView({ block: "nearest" });
          });
        }
      } else if (
        (command === "toggle-selection" || command === "extend-selection") &&
        integrationTaskId
      ) {
        event.preventDefault();
        actions.toggleSelection(integrationTaskId, command === "extend-selection");
      } else if (command === "peek" && integrationTaskId) {
        event.preventDefault();
        controls.setHighlightedTaskId(integrationTaskId);
        controls.setPeekTaskId(integrationTaskId);
      } else if (command === "open" && integrationTaskId) {
        event.preventDefault();
        controls.setHighlightedTaskId(integrationTaskId);
        actions.openTask(integrationTaskId);
      } else if (command === "select-visible") {
        event.preventDefault();
        controls.setSelected(new Set(
          selection.keyboardTaskIds.filter((id) => selection.selectableTaskIds.has(id)),
        ));
        selection.setAnchor(integrationTaskId);
      } else if (command === "toggle-details" && context.activeTaskId) {
        event.preventDefault();
        actions.closeTask();
        focusHighlightedTask();
      } else if (command === "toggle-details" && integrationTaskId) {
        event.preventDefault();
        controls.setHighlightedTaskId(integrationTaskId);
        actions.openTask(integrationTaskId);
      }
    }

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
    // The handler closes over the state represented by the stable ID keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    context.activeTaskId,
    context.canCreateTask,
    context.data,
    context.surface,
    layers.accountMenuOpen,
    layers.busy,
    layers.contextualMenuOpen,
    layers.dialog,
    layers.displayOpen,
    layers.filterOpen,
    layers.globalSearchOpen,
    layers.mobileActionsOpen,
    layers.mobileSidebarOpen,
    layers.peekTaskId,
    layers.pendingProjectMove,
    layers.recoverableDeletion,
    layers.systemBackupBusy,
    selection.highlightedTaskId,
    selection.keyboardTaskIdsKey,
    selection.selectableTaskIdsKey,
    selection.selected,
    selection.surfaceContextualEntity,
  ]);

  useEffect(() => {
    // Navigation changes deliberately reset ephemeral list state.
    controls.setHighlightedTaskId(null);
    controls.setSelected(new Set());
    controls.setPendingProjectMove(null);
    selection.setAnchor(null);
    // The reset is keyed only by navigation state; setters are render-stable inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.surface, resetKeys.search, resetKeys.temporaryQuery]);

  useEffect(() => {
    const result = reconcileTaskInteraction(
      {
        highlightedId: selection.highlightedTaskId,
        selected: selection.selected,
        anchorId: selection.getAnchor(),
      },
      selection.keyboardTaskIds,
      selection.selectableTaskIds,
      selection.getPreviousTaskIds(),
    );
    selection.setPreviousTaskIds(selection.keyboardTaskIds);
    selection.setAnchor(result.anchorId);
    if (result.highlightedId !== selection.highlightedTaskId) {
      controls.setHighlightedTaskId(result.highlightedId);
    }
    if (!setsEqual(result.selected, selection.selected)) {
      controls.setSelected(new Set(result.selected));
    }
    // Stable ID keys represent the derived arrays without reacting to rebuilt groups.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selection.highlightedTaskId,
    selection.keyboardTaskIdsKey,
    selection.selectableTaskIdsKey,
    selection.selected,
  ]);
}
