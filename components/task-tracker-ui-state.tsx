"use client";

import type { TaskGroup } from "@/lib/task-groups";
import type {
  AppSnapshot,
  Priority,
  ProjectRecord,
  TaskRecord,
  TaskRelationRecord,
  ViewDisplay,
} from "@/lib/types";
import type { PendingProjectGroupMove } from "@/components/task-tracker-shared-types";

export type CodexSetupMode = "desktop" | "cli";
export type CodexSetupModeAction =
  | { type: "select"; mode: CodexSetupMode }
  | { type: "open_cli_fallback" };

export function projectGroupMovePreview(
  task: TaskRecord,
  group: TaskGroup | null,
): PendingProjectGroupMove | null {
  return group?.kind === "project" && group.project && group.project.id !== task.projectId
    ? { taskId: task.id, targetProjectId: group.project.id }
    : null;
}

export function taskRowReorderDirection({
  draggable,
  reorderEnabled,
  altKey,
  key,
  targetIsRow,
}: {
  draggable: boolean;
  reorderEnabled: boolean;
  altKey: boolean;
  key: string;
  targetIsRow: boolean;
}): "up" | "down" | null {
  if (!targetIsRow || !draggable || !reorderEnabled || !altKey) return null;
  if (key === "ArrowUp") return "up";
  if (key === "ArrowDown") return "down";
  return null;
}

export const TASK_MANAGER_MARKETPLACE_URL = "https://github.com/xxsrez/marketplace";
export const TASK_MANAGER_CLI_SETUP = [
  "codex plugin marketplace add xxsrez/marketplace",
  "codex plugin add task-manager@srez-marketplace",
  "codex",
].join("\n");
export const TASK_MANAGER_DIAGNOSTIC_PROMPT = [
  "Help me diagnose a Task Manager plugin installation that redirected to web ChatGPT but did not appear in Codex.",
  "Do not repeat Install, and do not request tokens, secrets, credentials, or full redirect query strings.",
  "Collect: OS and ChatGPT/Codex version; output of `codex plugin marketplace list`; output of `codex plugin list`; the final redirect domain or URL with query parameters and fragments removed; visible error or confirmation messages; and screenshots of Plugins → Personal and Plugins → Installed.",
  "Identify whether the failure is marketplace discovery, plugin installation, OAuth connection, account/workspace mismatch, or stale client state. Do not claim the platform install bug is fixed.",
].join("\n\n");

export function nextCodexSetupMode(
  currentMode: CodexSetupMode,
  action: CodexSetupModeAction,
): CodexSetupMode {
  if (action.type === "open_cli_fallback") return "cli";
  return action.mode === currentMode ? currentMode : action.mode;
}

export function commentDraftStorageKey(
  userId: string,
  taskId: string,
  threadId: string | null = null,
) {
  return `tm:comment-draft:${userId}:${taskId}:${threadId ?? "root"}`;
}

export type RelativeRelationKind =
  | "blocks"
  | "blocked_by"
  | "related"
  | "duplicate_of"
  | "duplicates";

export function taskRelationSearchUiApiPath(
  query: string,
  anchorTaskId: string,
  kind: RelativeRelationKind,
) {
  const parameters = new URLSearchParams({
    search: query,
    relation_search: "true",
    relation_anchor: anchorTaskId,
    relation_kind: kind,
  });
  return `/api/tasks?${parameters}`;
}

export function relationCandidateProjectLabel(
  candidate: TaskRecord,
  projects: ProjectRecord[],
) {
  const project = projects.find((item) => item.id === candidate.projectId);
  return project ? `${project.taskCode} · ${project.name}` : "Project unavailable";
}

export const priorityMeta: Record<Priority, { label: string }> = {
  urgent: { label: "Urgent" },
  high: { label: "High" },
  medium: { label: "Medium" },
  low: { label: "Low" },
  none: { label: "No priority" },
};

export function PriorityIcon({ priority }: { priority: Priority }) {
  const label = priorityMeta[priority].label;
  if (priority === "urgent" || priority === "none") {
    return <span className={`priority-icon priority-${priority}`} data-priority={priority} role="img" aria-label={priority === "urgent" ? "Urgent priority" : label} title={label}><span className="priority-symbol" aria-hidden="true">{priority === "urgent" ? "!" : "−"}</span></span>;
  }
  const activeBars = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  return <span className={`priority-icon priority-${priority}`} data-priority={priority} data-active-bars={activeBars} role="img" aria-label={`${label} priority`} title={label}>{[1, 2, 3].map((bar) => <span key={bar} className={`priority-bar ${bar <= activeBars ? "active" : ""}`} aria-hidden="true" />)}</span>;
}

export const groupByOptions: Array<{ value: ViewDisplay["groupBy"]; label: string }> = [
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "assignee", label: "Assignee" },
  { value: "project", label: "Project" },
  { value: "release", label: "Release" },
  { value: "label_group", label: "Label group" },
  { value: "none", label: "No grouping" },
];
export const viewOrderOptions: Array<{ value: ViewDisplay["orderBy"]; label: string }> = [
  { value: "manual", label: "Manual" },
  { value: "priority", label: "Priority" },
  { value: "created", label: "Created" },
  { value: "updated", label: "Updated" },
  { value: "due", label: "Due date" },
  { value: "title", label: "Title" },
];
export const viewFieldOptions: Array<{
  value: ViewDisplay["visibleFields"][number];
  label: string;
}> = [
  { value: "priority", label: "Priority" },
  { value: "project", label: "Project" },
  { value: "release", label: "Release" },
  { value: "dueDate", label: "Due date" },
  { value: "assignee", label: "Assignee" },
];

export function toggleViewField(
  fields: ViewDisplay["visibleFields"],
  field: ViewDisplay["visibleFields"][number],
) {
  return fields.includes(field)
    ? fields.filter((item) => item !== field)
    : [...fields, field];
}

export function viewDisplayDependencies(display: Pick<ViewDisplay, "groupBy" | "orderBy">) {
  const directionReason = display.orderBy === "manual"
    ? "Direction is unavailable while tasks use manual order."
    : null;
  const emptyGroupsReason = display.groupBy === "status"
    ? "Empty status groups are always hidden."
    : display.groupBy === "none"
      ? "Choose a grouping to show empty groups."
      : null;
  return {
    directionDisabled: directionReason !== null,
    directionReason,
    emptyGroupsDisabled: emptyGroupsReason !== null,
    emptyGroupsReason,
  };
}

export function resolveArchiveBulkAction(
  tasks: Array<Pick<TaskRecord, "archivedAt">>,
) {
  const shouldRestore =
    tasks.length > 0 && tasks.every((task) => task.archivedAt !== null);
  return shouldRestore
    ? ({ archived: false, label: "Restore" } as const)
    : ({ archived: true, label: "Archive" } as const);
}

export type TaskRelationPresentation = {
  relation: TaskRelationRecord;
  target: TaskRecord;
  direction: "incoming" | "outgoing";
  group: "Blocked by" | "Blocking" | "Related" | "Duplicate of" | "Duplicates";
  label: "Blocked by" | "Blocks" | "Related" | "Resolved blocker" | "Duplicate of" | "Duplicate";
};

export const taskRelationGroupOrder: TaskRelationPresentation["group"][] = [
  "Blocked by",
  "Blocking",
  "Related",
  "Duplicate of",
  "Duplicates",
];

export function taskRelationPresentations(
  task: TaskRecord,
  data: Pick<AppSnapshot, "tasks" | "statuses" | "relations">,
): TaskRelationPresentation[] {
  const taskMap = new Map(data.tasks.map((item) => [item.id, item]));
  const statusMap = new Map(data.statuses.map((status) => [status.id, status]));
  const presentations: TaskRelationPresentation[] = [];
  for (const relation of data.relations) {
    const outgoing = relation.sourceTaskId === task.id;
    const incoming = relation.targetTaskId === task.id;
    if (!outgoing && !incoming) continue;
    const target = taskMap.get(outgoing ? relation.targetTaskId : relation.sourceTaskId);
    if (!target) continue;
    if (relation.type === "related") {
      presentations.push({ relation, target, direction: outgoing ? "outgoing" : "incoming", group: "Related", label: "Related" });
      continue;
    }
    if (relation.type === "duplicate_of") {
      presentations.push(outgoing
        ? { relation, target, direction: "outgoing", group: "Duplicate of", label: "Duplicate of" }
        : { relation, target, direction: "incoming", group: "Duplicates", label: "Duplicate" });
      continue;
    }
    if (outgoing) {
      presentations.push({ relation, target, direction: "outgoing", group: "Blocking", label: "Blocks" });
      continue;
    }
    const blockerStatus = statusMap.get(target.statusId)?.category;
    const resolved = blockerStatus === "completed" || blockerStatus === "canceled";
    presentations.push(resolved
      ? { relation, target, direction: "incoming", group: "Related", label: "Resolved blocker" }
      : { relation, target, direction: "incoming", group: "Blocked by", label: "Blocked by" });
  }
  return presentations.sort((left, right) =>
    taskRelationGroupOrder.indexOf(left.group) - taskRelationGroupOrder.indexOf(right.group) ||
    left.target.identifier.localeCompare(right.target.identifier));
}
