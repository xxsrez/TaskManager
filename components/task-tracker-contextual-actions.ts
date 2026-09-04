"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import {
  buildTaskArchiveCommand,
  resolveContextualActions,
  resolveTaskTriggerContext,
  type ContextualActionContext,
  type ContextualActionEntity,
  type ResolvedContextualAction,
} from "@/lib/contextual-actions";
import type { AppSnapshot, TaskRecord } from "@/lib/types";
import type { Layout } from "@/lib/navigation";
import type { Dialog } from "@/components/task-tracker-state";
import {
  projectContextualEntity,
  releaseContextualEntity,
  taskContextualEntity,
  viewContextualEntity,
} from "@/components/task-tracker-view";

type ContextualMenuState = {
  context: ContextualActionContext;
  x: number;
  y: number;
  restoreFocus: HTMLElement | null;
};

export function useTaskTrackerContextualActions({
  data,
  selected,
  setSelected,
  surface,
  setDialog,
  mutate,
  openTask,
  navigateSurface,
  openRecoverableDelete,
  onError,
}: {
  data: AppSnapshot;
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  surface: string;
  setDialog: Dispatch<SetStateAction<Dialog | null>>;
  mutate: (path: string, method: string, body: unknown) => Promise<boolean>;
  openTask: (taskId: string) => void;
  navigateSurface: (nextSurface: string, nextLayout: Layout) => void;
  openRecoverableDelete: (entity: ContextualActionEntity) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [menu, setMenu] = useState<ContextualMenuState | null>(null);

  function open(
    context: ContextualActionContext,
    x: number,
    y: number,
    restoreFocus: HTMLElement | null,
  ) {
    if (!context.entities.length) return;
    setMenu({ context, x, y, restoreFocus });
  }

  function openForTask(
    task: TaskRecord,
    x: number,
    y: number,
    restoreFocus: HTMLElement | null,
  ) {
    const tasks = resolveTaskTriggerContext(
      data.tasks.map(taskContextualEntity),
      selected,
      task.id,
      null,
    );
    open({ entities: tasks }, x, y, restoreFocus);
  }

  function close() {
    const restoreFocus = menu?.restoreFocus;
    setMenu(null);
    if (restoreFocus) window.requestAnimationFrame(() => restoreFocus.focus());
  }

  function currentContext(context: ContextualActionContext): ContextualActionContext {
    return {
      entities: context.entities.flatMap((entity) => {
        if (entity.kind === "task") {
          const record = data.tasks.find((item) => item.id === entity.id);
          return record ? [taskContextualEntity(record)] : [];
        }
        if (entity.kind === "project") {
          const record = data.projects.find((item) => item.id === entity.id);
          return record ? [projectContextualEntity(record)] : [];
        }
        if (entity.kind === "release") {
          const record = data.releases.find((item) => item.id === entity.id);
          return record ? [releaseContextualEntity(record)] : [];
        }
        const record = data.views.find((item) => item.id === entity.id);
        return record ? [viewContextualEntity(record)] : [];
      }),
    };
  }

  function focusedEntity(element: HTMLElement): ContextualActionEntity | null {
    const contextElement = element.closest<HTMLElement>("[data-context-entity-id]");
    const id = contextElement?.dataset.contextEntityId;
    const kind = contextElement?.dataset.contextEntityKind;
    if (!id) return null;
    if (kind === "task") {
      const record = data.tasks.find((item) => item.id === id);
      return record ? taskContextualEntity(record) : null;
    }
    if (kind === "project") {
      const record = data.projects.find((item) => item.id === id);
      return record ? projectContextualEntity(record) : null;
    }
    if (kind === "release") {
      const record = data.releases.find((item) => item.id === id);
      return record ? releaseContextualEntity(record) : null;
    }
    if (kind === "saved_view") {
      const record = data.views.find((item) => item.id === id);
      return record ? viewContextualEntity(record) : null;
    }
    return null;
  }

  async function execute(action: ResolvedContextualAction) {
    if (!menu) return;
    try {
      const liveContext = currentContext(menu.context);
      const liveAction = resolveContextualActions(liveContext).find(
        (item) => item.id === action.id,
      );
      if (!liveAction || liveAction.contextKey !== action.contextKey) {
        throw new Error("The contextual action context changed. Open the menu again.");
      }
      if (liveAction.disabledReason) throw new Error(liveAction.disabledReason);
      const entity = liveContext.entities[0]!;

      if (action.id === "open") {
        if (entity.kind === "task") openTask(entity.id);
        else if (entity.kind === "project") navigateSurface(`project:${entity.id}`, "list");
        else if (entity.kind === "release") navigateSurface(`release:${entity.id}`, "list");
        else {
          const view = data.views.find((item) => item.id === entity.id);
          if (view) navigateSurface(`view:${view.id}`, view.display.layout);
        }
        close();
        return;
      }

      if (action.id === "delete") {
        close();
        await openRecoverableDelete(entity);
        return;
      }

      if (entity.kind === "task") {
        const command = buildTaskArchiveCommand(liveContext, action);
        const ok = await mutate(command.path, command.method, command.body);
        if (ok) {
          setSelected(new Set());
          close();
        }
        return;
      }

      const targetSurface = entity.kind === "project"
        ? `project:${entity.id}`
        : entity.kind === "release"
          ? `release:${entity.id}`
          : `view:${entity.id}`;
      const targetLayout = entity.kind === "saved_view"
        ? data.views.find((item) => item.id === entity.id)?.display.layout ?? "list"
        : "list";

      if (action.id === "edit" || action.id === "share") {
        navigateSurface(targetSurface, targetLayout);
        setDialog(action.id === "share"
          ? "share"
          : entity.kind === "project"
            ? "projectEdit"
            : entity.kind === "release"
              ? "releaseEdit"
              : "viewEdit");
        close();
        return;
      }

      if (entity.kind === "project") {
        const ok = await mutate(`/api/projects/${entity.id}`, "PATCH", {
          version: entity.version,
          archived: action.id === "archive",
        });
        if (ok) close();
      } else if (entity.kind === "saved_view") {
        const ok = await mutate(`/api/views/${entity.id}`, "PATCH", {
          version: entity.version,
          archived: action.id === "archive",
        });
        if (ok) {
          if (action.id === "archive" && surface === `view:${entity.id}`) {
            navigateSurface("views", "list");
          }
          close();
        }
      }
    } catch (actionError) {
      onError(actionError instanceof Error ? actionError.message : "Contextual action failed");
    }
  }

  return {
    menu,
    open,
    openForTask,
    close,
    focusedEntity,
    execute,
  };
}
