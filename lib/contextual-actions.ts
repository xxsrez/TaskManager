import type { AccessRole } from "@/lib/types";

export type ContextualEntityKind = "task" | "project" | "release" | "saved_view";
export type ContextualActionId = "open" | "edit" | "share" | "archive" | "restore" | "delete";

export type ContextualActionEntity = {
  kind: ContextualEntityKind;
  id: string;
  label: string;
  accessRole: AccessRole;
  archivedAt: string | null;
  version: number;
};

export type ContextualActionContext = {
  entities: ContextualActionEntity[];
};

export type ResolvedContextualAction = {
  id: ContextualActionId;
  label: string;
  icon: "open" | "edit" | "share" | "archive" | "restore" | "delete";
  shortcut: string | null;
  destructive: boolean;
  disabledReason: string | null;
  confirmation: string | null;
  contextKey: string;
};

export type ContextualMutationCommand = {
  path: string;
  method: "POST";
  body: {
    ids: string[];
    versions: Record<string, number>;
    field: "archived";
    value: boolean;
  };
};

const READ_ONLY_REASON = "Viewer access is read-only.";

function contextKey(context: ContextualActionContext): string {
  return context.entities
    .map((entity) => `${entity.kind}:${entity.id}:${entity.version}:${entity.archivedAt ?? "active"}:${entity.accessRole}`)
    .join("|");
}

function action(
  context: ContextualActionContext,
  value: Omit<ResolvedContextualAction, "contextKey">,
): ResolvedContextualAction {
  return { ...value, contextKey: contextKey(context) };
}

function editReason(entity: ContextualActionEntity): string | null {
  return entity.accessRole === "viewer" ? READ_ONLY_REASON : null;
}

function shareReason(entity: ContextualActionEntity): string | null {
  if (entity.kind === "project" || entity.kind === "release") {
    return entity.accessRole === "owner" || entity.accessRole === "manager"
      ? null
      : "Only Project owners and managers can manage access.";
  }
  return entity.accessRole === "owner"
    ? null
    : "Only the owner can manage access.";
}

function taskArchiveReason(entities: ContextualActionEntity[]): string | null {
  const archivedCount = entities.filter((entity) => entity.archivedAt !== null).length;
  if (archivedCount > 0 && archivedCount < entities.length) {
    return "Select either active or archived Tasks, not both.";
  }
  const readOnlyCount = entities.filter((entity) => entity.accessRole === "viewer").length;
  if (!readOnlyCount) return null;
  return entities.length === 1
    ? READ_ONLY_REASON
    : "One or more selected Tasks are read-only.";
}

function taskActions(context: ContextualActionContext): ResolvedContextualAction[] {
  const count = context.entities.length;
  const archived = count > 0 && context.entities.every((entity) => entity.archivedAt !== null);
  const archiveId = archived ? "restore" : "archive";
  const noun = count === 1 ? "Task" : "Tasks";
  const actions: ResolvedContextualAction[] = [
    action(context, {
      id: "open",
      label: "Open",
      icon: "open",
      shortcut: "Enter",
      destructive: false,
      disabledReason: count === 1 ? null : "Open is available for a single item.",
      confirmation: null,
    }),
  ];
  if (context.entities.every((entity) => entity.accessRole === "viewer")) {
    return actions;
  }
  actions.push(action(context, {
      id: archiveId,
      label: count === 1 ? (archived ? "Restore" : "Archive") : `${archived ? "Restore" : "Archive"} ${count} ${noun}`,
      icon: archiveId,
      shortcut: null,
      destructive: archiveId === "archive",
      disabledReason: taskArchiveReason(context.entities),
      confirmation: null,
    }));
  if (count === 1) {
    actions.push(action(context, {
      id: "delete",
      label: "Delete task…",
      icon: "delete",
      shortcut: null,
      destructive: true,
      disabledReason: editReason(context.entities[0]!),
      confirmation: null,
    }));
  }
  return actions;
}

function singleEntityActions(context: ContextualActionContext): ResolvedContextualAction[] {
  const entity = context.entities[0]!;
  if (entity.kind === "saved_view" && entity.archivedAt !== null) {
    if (entity.accessRole === "viewer") return [];
    return [action(context, {
      id: "restore",
      label: "Restore",
      icon: "restore",
      shortcut: null,
      destructive: false,
      disabledReason: editReason(entity),
      confirmation: null,
    })];
  }
  const common: ResolvedContextualAction[] = [action(context, {
    id: "open",
    label: "Open",
    icon: "open",
    shortcut: "Enter",
    destructive: false,
    disabledReason: null,
    confirmation: null,
  })];
  if (entity.accessRole === "viewer") return common;

  common.push(action(context, {
    id: "edit",
    label: `Edit ${entity.kind === "saved_view" ? "view" : entity.kind}`,
    icon: "edit",
    shortcut: null,
    destructive: false,
    disabledReason: editReason(entity),
    confirmation: null,
  }));

  common.push(action(context, {
    id: "share",
    label: "Members & access",
    icon: "share",
    shortcut: null,
    destructive: false,
    disabledReason: shareReason(entity),
    confirmation: null,
  }));
  if (entity.kind !== "release" && entity.kind !== "saved_view") {
    const restoring = entity.archivedAt !== null;
    common.push(action(context, {
      id: restoring ? "restore" : "archive",
      label: restoring ? "Restore" : "Archive",
      icon: restoring ? "restore" : "archive",
      shortcut: null,
      destructive: !restoring,
      disabledReason: editReason(entity),
      confirmation: restoring ? null : `Archive ${entity.label}?`,
    }));
  }
  common.push(action(context, {
    id: "delete",
    label: `Delete ${entity.kind === "saved_view" ? "view" : entity.kind}…`,
    icon: "delete",
    shortcut: null,
    destructive: true,
    disabledReason: editReason(entity),
    confirmation: null,
  }));
  return common;
}

export function resolveContextualActions(
  context: ContextualActionContext,
): ResolvedContextualAction[] {
  if (!context.entities.length) return [];
  const kind = context.entities[0]!.kind;
  if (context.entities.some((entity) => entity.kind !== kind)) return [];
  if (kind === "task") return taskActions(context);
  if (context.entities.length > 1) return [];
  return singleEntityActions(context);
}

export function contextualActionIds(
  context: ContextualActionContext,
): ContextualActionId[] {
  return resolveContextualActions(context).map((item) => item.id);
}

export function resolveTaskTriggerContext(
  entities: ContextualActionEntity[],
  selectedIds: ReadonlySet<string>,
  triggerTaskId: string | null,
  fallbackTaskId: string | null,
): ContextualActionEntity[] {
  const tasks = entities.filter((entity) => entity.kind === "task");
  const byId = new Map(tasks.map((entity) => [entity.id, entity]));
  const selected = tasks.filter((entity) => selectedIds.has(entity.id));
  if (triggerTaskId) {
    const trigger = byId.get(triggerTaskId);
    if (!trigger) return [];
    return selectedIds.has(triggerTaskId) ? selected : [trigger];
  }
  if (selected.length) return selected;
  const fallback = fallbackTaskId ? byId.get(fallbackTaskId) : undefined;
  return fallback ? [fallback] : [];
}

export function resolveKeyboardContextualEntities(
  tasks: ContextualActionEntity[],
  selectedTaskIds: ReadonlySet<string>,
  focusedEntity: ContextualActionEntity | null,
  activeTaskEntity: ContextualActionEntity | null,
  highlightedTaskId: string | null,
) {
  if (focusedEntity && focusedEntity.kind !== "task") return [focusedEntity];
  if (!focusedEntity && activeTaskEntity?.kind === "task") return [activeTaskEntity];
  return resolveTaskTriggerContext(
    tasks,
    selectedTaskIds,
    focusedEntity?.kind === "task" ? focusedEntity.id : null,
    highlightedTaskId,
  );
}

export function nextContextualActionIndex(
  actions: ResolvedContextualAction[],
  current: number,
  direction: 1 | -1,
): number {
  if (!actions.length) return -1;
  for (let offset = 1; offset <= actions.length; offset += 1) {
    const candidate = (current + direction * offset + actions.length) % actions.length;
    if (!actions[candidate]?.disabledReason) return candidate;
  }
  return current;
}

export function buildTaskArchiveCommand(
  context: ContextualActionContext,
  resolved: ResolvedContextualAction,
): ContextualMutationCommand {
  if (resolved.contextKey !== contextKey(context)) {
    throw new Error("The contextual action context changed. Open the menu again.");
  }
  if (resolved.disabledReason) throw new Error(resolved.disabledReason);
  if (resolved.id !== "archive" && resolved.id !== "restore") {
    throw new Error("This action is not a Task archive command.");
  }
  if (!context.entities.length || context.entities.some((entity) => entity.kind !== "task")) {
    throw new Error("Task archive commands require a Task context.");
  }
  return {
    path: "/api/tasks/bulk",
    method: "POST",
    body: {
      ids: context.entities.map((entity) => entity.id),
      versions: Object.fromEntries(context.entities.map((entity) => [entity.id, entity.version])),
      field: "archived",
      value: resolved.id === "archive",
    },
  };
}
