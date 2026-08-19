export type TaskKeyboardCommand =
  | "escape"
  | "compose"
  | "global-search"
  | "filter"
  | "display"
  | "toggle-layout"
  | "highlight-next"
  | "highlight-previous"
  | "toggle-selection"
  | "extend-selection"
  | "select-visible"
  | "peek"
  | "open"
  | "contextual-actions"
  | "toggle-details";

export const TASK_KEYBOARD_COMMAND_EVENT = "task-manager:keyboard-command";
export type TaskKeyboardIntegrationDetail = {
  command: "global-search" | "contextual-actions";
  taskId: string | null;
  selectedTaskIds: string[];
  surface: string;
};

export type KeyboardEventLike = {
  key: string;
  target?: EventTarget | null;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

export type TaskInteractionState = {
  highlightedId: string | null;
  selected: ReadonlySet<string>;
  anchorId: string | null;
};

export function keyboardCommandFor(
  event: KeyboardEventLike,
  options: { layerOwnsKeyboard?: boolean } = {},
): TaskKeyboardCommand | null {
  const key = event.key.toLocaleLowerCase();
  if (event.defaultPrevented || event.isComposing) return null;
  if (key === "escape") return "escape";
  const primary = Boolean(event.metaKey || event.ctrlKey);
  if (
    options.layerOwnsKeyboard ||
    keyboardTargetIsEditor(event.target) ||
    event.altKey
  ) {
    return null;
  }

  if (primary) {
    if (event.shiftKey) return null;
    if (key === "b") return "toggle-layout";
    if (key === "k") return "contextual-actions";
    if (key === "i") return "toggle-details";
    if (key === "a") return "select-visible";
    return null;
  }

  if (event.shiftKey) {
    if (key === "v") return "display";
    if (key === "x") return "extend-selection";
    return null;
  }

  if (key === "c") return "compose";
  if (key === "/") return "global-search";
  if (key === "f") return "filter";
  if (key === "arrowdown" || key === "j") return "highlight-next";
  if (key === "arrowup" || key === "k") return "highlight-previous";
  if (key === "x") return "toggle-selection";
  if (key === " " || key === "spacebar") return "peek";
  if (key === "enter") return "open";
  return null;
}

export function keyboardTargetIsEditor(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  };
  if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName?.toUpperCase() ?? "")) {
    return true;
  }
  if (element.isContentEditable) return true;
  return Boolean(element.closest?.(
    "[contenteditable='true'], [role='textbox'], [data-keyboard-editor='true'], [data-keyboard-scope='local']",
  ));
}

export function toggleTaskSelection(
  selected: ReadonlySet<string>,
  anchorId: string | null,
  taskId: string,
): Pick<TaskInteractionState, "selected" | "anchorId"> {
  const next = new Set(selected);
  if (next.has(taskId)) next.delete(taskId);
  else next.add(taskId);
  return { selected: next, anchorId: taskId };
}

export function selectTaskRange(
  selected: ReadonlySet<string>,
  anchorId: string | null,
  taskId: string,
  visibleIds: readonly string[],
  selectableIds: ReadonlySet<string> = new Set(visibleIds),
): Pick<TaskInteractionState, "selected" | "anchorId"> {
  const resolvedAnchor = anchorId && visibleIds.includes(anchorId) ? anchorId : taskId;
  const anchorIndex = visibleIds.indexOf(resolvedAnchor);
  const taskIndex = visibleIds.indexOf(taskId);
  if (taskIndex < 0 || anchorIndex < 0) {
    return { selected: new Set(selected), anchorId: resolvedAnchor };
  }
  const start = Math.min(anchorIndex, taskIndex);
  const end = Math.max(anchorIndex, taskIndex);
  const selectedIds = new Set(
    [...selected].filter((id) => visibleIds.includes(id) && selectableIds.has(id)),
  );
  for (const id of visibleIds.slice(start, end + 1)) {
    if (selectableIds.has(id)) selectedIds.add(id);
  }
  const next = new Set(visibleIds.filter((id) => selectedIds.has(id)));
  return { selected: next, anchorId: resolvedAnchor };
}

export function moveTaskHighlight(
  highlightedId: string | null,
  visibleIds: readonly string[],
  direction: -1 | 1,
): string | null {
  if (!visibleIds.length) return null;
  const currentIndex = highlightedId ? visibleIds.indexOf(highlightedId) : -1;
  const start = currentIndex < 0 ? (direction > 0 ? -1 : visibleIds.length) : currentIndex;
  return visibleIds[Math.max(0, Math.min(visibleIds.length - 1, start + direction))] ?? null;
}

export function reconcileTaskInteraction(
  state: TaskInteractionState,
  visibleIds: readonly string[],
  selectableIds: ReadonlySet<string>,
  previousVisibleIds: readonly string[] = visibleIds,
): TaskInteractionState {
  const visible = new Set(visibleIds);
  const selected = new Set(
    [...state.selected].filter((id) => visible.has(id) && selectableIds.has(id)),
  );
  const anchorId = state.anchorId && visible.has(state.anchorId) && selectableIds.has(state.anchorId)
    ? state.anchorId
    : null;
  if (!visibleIds.length) return { highlightedId: null, selected, anchorId };
  if (state.highlightedId && visible.has(state.highlightedId)) {
    return { highlightedId: state.highlightedId, selected, anchorId };
  }

  const previousIndex = state.highlightedId
    ? previousVisibleIds.indexOf(state.highlightedId)
    : 0;
  const nextIndex = previousIndex < 0
    ? 0
    : Math.min(previousIndex, visibleIds.length - 1);
  return { highlightedId: visibleIds[nextIndex] ?? null, selected, anchorId };
}
