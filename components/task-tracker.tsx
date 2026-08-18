"use client";
/* eslint-disable @next/next/no-html-link-for-pages */

import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowDownWideNarrow,
  ArrowUp,
  Boxes,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleHelp,
  CircleDot,
  Columns3,
  Copy,
  Download,
  FolderKanban,
  GitBranch,
  Inbox,
  LayoutList,
  Link2,
  ListFilter,
  LogOut,
  Monitor,
  Moon,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Rocket,
  Save,
  Search,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Tag,
  Upload,
  UsersRound,
  X,
  Zap,
} from "lucide-react";
import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { canAssignRole, canEditContent, canManageGrant } from "@/lib/access";
import {
  buildTaskGroups,
  canMoveTaskToGroup,
  projectTaskGroupMove,
  rollbackTaskGroupMove,
  shouldShowEmptyTaskGroups,
  taskGroupCreateDefaults,
  taskGroupMutation,
  taskMatchesGroup,
  tasksInGroupOrder,
  type TaskGroup,
} from "@/lib/task-groups";
import {
  navigationHistoryState,
  navigationPath,
  parseNavigationPath,
  projectReleasesPath,
  resolveNavigationHistoryState,
  resolveNavigationTarget,
  taskPath,
  type Layout,
  type ResolvedNavigation,
} from "@/lib/navigation";
import { formatReleaseName } from "@/lib/release-presentation";
import {
  applyWorkspaceSync,
  mergeTaskSummary,
} from "@/lib/workspace-sync-contract";
import {
  useWorkspaceSyncCoordinator,
  type WorkspaceSyncCheckpoint,
} from "@/components/workspace-sync-coordinator";
import {
  type PublicAttachmentRecord,
  startTaskAttachmentUpload,
  TaskAttachments,
  TaskDescriptionImage,
} from "@/components/task-attachments";
import { TaskDescriptionEditor } from "@/components/task-description-editor";
import { parseTaskImageLine } from "@/lib/task-description-format";
import type {
  AdminOverview,
  AccessRole,
  AppliedSystemBackup,
  AppSnapshot,
  CommentPage,
  CommentRecord,
  CommentThreadRecord,
  ExternalSourceRecord,
  Priority,
  ProjectRecord,
  ReleaseRecord,
  SavedViewRecord,
  StatusCategory,
  StagedSystemBackup,
  TaskRecord,
  TaskDetailRecord,
  TaskRelationRecord,
  UserRecord,
  ViewDisplay,
  ViewQuery,
  WorkflowStatusRecord,
  WorkspaceSyncResponse,
} from "@/lib/types";

type ShareTarget = {
  resourceType: "project" | "task" | "saved_view";
  resourceId: string;
  label: string;
  accessRole: AccessRole;
  ownerUserId: string;
  inherited: boolean;
};

type Dialog = "task" | "project" | "release" | "view" | "share" | "systemImport" | "codexSetup" | "workflowSettings" | null;
type CodexSetupMode = "desktop" | "cli";
type TaskCreateDefaults = Partial<{
  statusId: string;
  priority: Priority;
  assigneeUserId: string | null;
  projectId: string | null;
  releaseId: string | null;
}>;
export type TaskSearchState = {
  query: string;
  taskIds: string[];
  tasks: TaskRecord[];
  status: "ready" | "error";
};

export const TASK_MANAGER_MARKETPLACE_URL = "https://github.com/xxsrez/marketplace";
export const TASK_MANAGER_CLI_SETUP = [
  "codex plugin marketplace add xxsrez/marketplace",
  "codex plugin add task-manager@srez-marketplace",
  "codex",
].join("\n");

export function commentDraftStorageKey(
  userId: string,
  taskId: string,
  threadId: string | null = null,
) {
  return `tm:comment-draft:${userId}:${taskId}:${threadId ?? "root"}`;
}

const priorityMeta: Record<Priority, { label: string }> = {
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

const groupByOptions: Array<{ value: ViewDisplay["groupBy"]; label: string }> = [
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "assignee", label: "Assignee" },
  { value: "project", label: "Project" },
  { value: "release", label: "Release" },
  { value: "none", label: "No grouping" },
];

export function resolveArchiveBulkAction(
  tasks: Array<Pick<TaskRecord, "archivedAt">>,
) {
  const shouldRestore =
    tasks.length > 0 && tasks.every((task) => task.archivedAt !== null);
  return shouldRestore
    ? ({ archived: false, label: "Restore" } as const)
    : ({ archived: true, label: "Archive" } as const);
}

type MutationResult = AppSnapshot | { task: TaskRecord } | { taskUpdates: TaskRecord[] };

export type TaskRelationPresentation = {
  relation: TaskRelationRecord;
  target: TaskRecord;
  direction: "incoming" | "outgoing";
  group: "Blocked by" | "Blocking" | "Related" | "Duplicate of" | "Duplicates";
  label: "Blocked by" | "Blocks" | "Related" | "Resolved blocker" | "Duplicate of" | "Duplicate";
};

const taskRelationGroupOrder: TaskRelationPresentation["group"][] = [
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

export function applyMutationResult(
  current: AppSnapshot,
  result: MutationResult,
): AppSnapshot {
  if ("taskUpdates" in result) {
    const updates = new Map(result.taskUpdates.map((task) => [task.id, task]));
    return {
      ...current,
      tasks: current.tasks.map((task) => {
        const updated = updates.get(task.id);
        return updated ? mergeTaskMutation(task, updated) : task;
      }),
    };
  }
  if (!("task" in result)) return result;
  return {
    ...current,
    tasks: current.tasks.map((task) =>
      task.id === result.task.id ? mergeTaskMutation(task, result.task) : task,
    ),
  };
}

function mergeTaskMutation(
  retained: TaskRecord | undefined,
  incoming: TaskRecord,
): TaskRecord {
  if (!retained) return incoming;
  const clientState: Partial<TaskRecord> = {};
  const hasLoadedDetailState = retained.detailVersion !== undefined ||
    retained.detailStale !== undefined ||
    retained.detailInvalidationCursor !== undefined;
  if (hasLoadedDetailState) {
    clientState.detailVersion = incoming.description === null
      ? retained.detailVersion
      : incoming.version;
    clientState.detailStale = incoming.description === null
      ? retained.detailStale
      : false;
  }
  if (retained.detailInvalidationCursor !== undefined) {
    clientState.detailInvalidationCursor = retained.detailInvalidationCursor;
  }
  if (retained.commentInvalidationCursor !== undefined) {
    clientState.commentInvalidationCursor = retained.commentInvalidationCursor;
  }
  if (retained.attachmentInvalidationCursor !== undefined) {
    clientState.attachmentInvalidationCursor = retained.attachmentInvalidationCursor;
  }
  if (retained.externalSourceInvalidationCursor !== undefined) {
    clientState.externalSourceInvalidationCursor =
      retained.externalSourceInvalidationCursor;
  }
  return Object.keys(clientState).length
    ? { ...incoming, ...clientState }
    : incoming;
}

export function mergeDeferredSnapshot(
  current: AppSnapshot,
  incoming: AppSnapshot,
  options: {
    taskIdsAtRequest?: ReadonlySet<string>;
    projectIdsAtRequest?: ReadonlySet<string>;
    releaseIdsAtRequest?: ReadonlySet<string>;
    viewIdsAtRequest?: ReadonlySet<string>;
  } = {},
): AppSnapshot {
  const currentTasks = new Map(current.tasks.map((task) => [task.id, task]));
  const incomingIds = new Set(incoming.tasks.map((task) => task.id));
  const retainedTasks = current.tasks.filter((task) => {
    if (incomingIds.has(task.id)) return false;
    if (!options.taskIdsAtRequest) return true;
    return !options.taskIdsAtRequest.has(task.id);
  });
  const tasks = incoming.tasks.map((task) =>
    mergeTaskSummary(currentTasks.get(task.id), task),
  );
  const mergedTasks = [...retainedTasks, ...tasks];
  const mergedTaskIds = new Set(mergedTasks.map((task) => task.id));
  const mergedTaskLabels = mergeUnique(
    incoming.taskLabels,
    current.taskLabels,
    (assignment) => `${assignment.taskId}:${assignment.labelId}`,
  ).filter(
    (assignment) => !options.taskIdsAtRequest || mergedTaskIds.has(assignment.taskId),
  );
  const mergedRelations = mergeUnique(
    incoming.relations,
    current.relations,
    (relation) => `${relation.sourceTaskId}:${relation.type}:${relation.targetTaskId}`,
  ).filter(
    (relation) => !options.taskIdsAtRequest ||
      (mergedTaskIds.has(relation.sourceTaskId) && mergedTaskIds.has(relation.targetTaskId)),
  );
  const retainedLabelIds = new Set(mergedTaskLabels.map((assignment) => assignment.labelId));
  const incomingLabelIds = new Set(incoming.labels.map((label) => label.id));

  return {
    ...incoming,
    tasks: mergedTasks,
    projects: mergeResetCollection(
      current.projects,
      incoming.projects,
      options.projectIdsAtRequest,
    ),
    releases: mergeResetCollection(
      current.releases,
      incoming.releases,
      options.releaseIdsAtRequest,
    ),
    views: mergeResetCollection(
      current.views,
      incoming.views,
      options.viewIdsAtRequest,
    ),
    labels: mergeUnique(incoming.labels, current.labels, (label) => label.id)
      .filter((label) => !options.taskIdsAtRequest ||
        incomingLabelIds.has(label.id) || retainedLabelIds.has(label.id)),
    taskLabels: mergedTaskLabels,
    relations: mergedRelations,
  };
}

export const PULL_REFRESH_THRESHOLD = 72;

export function canStartPullRefresh(input: {
  mobile: boolean;
  coarsePointer: boolean;
  scrollTop: number;
  refreshing: boolean;
  touchCount: number;
}) {
  return input.mobile
    && input.coarsePointer
    && input.scrollTop <= 0
    && !input.refreshing
    && input.touchCount === 1;
}

export function pullRefreshDistance(deltaY: number) {
  return Math.min(104, Math.max(0, deltaY * 0.55));
}

export function shouldTriggerPullRefresh(distance: number) {
  return distance >= PULL_REFRESH_THRESHOLD;
}

export async function fetchTaskSnapshot(fetcher: typeof fetch = fetch) {
  const response = await fetcher("/api/bootstrap", { cache: "no-store" });
  const value = (await response.json()) as AppSnapshot | { error: string };
  if (!response.ok || "error" in value) {
    throw new Error("error" in value ? value.error : "Refresh failed");
  }
  return value;
}

export function runSingleFlight<T>(
  holder: { current: Promise<T> | null },
  operation: () => Promise<T>,
) {
  if (holder.current) return holder.current;
  const promise = operation().finally(() => {
    if (holder.current === promise) holder.current = null;
  });
  holder.current = promise;
  return promise;
}

export function mergeSearchTaskSummaries(
  current: TaskRecord[],
  incoming: TaskRecord[],
): TaskRecord[] {
  const incomingIds = new Set(incoming.map((task) => task.id));
  const currentTasks = new Map(current.map((task) => [task.id, task]));
  return [
    ...current.filter((task) => !incomingIds.has(task.id)),
    ...incoming.map((task) => mergeTaskSummary(currentTasks.get(task.id), task)),
  ];
}

function mergeResetCollection<T extends { id: string; version: number }>(
  current: T[],
  incoming: T[],
  idsAtRequest?: ReadonlySet<string>,
): T[] {
  const currentById = new Map(current.map((item) => [item.id, item]));
  const incomingIds = new Set(incoming.map((item) => item.id));
  const retained = current.filter((item) => {
    if (incomingIds.has(item.id)) return false;
    if (!idsAtRequest) return true;
    return !idsAtRequest.has(item.id);
  });
  return [
    ...retained,
    ...incoming.map((item) => {
      const existing = currentById.get(item.id);
      return existing && existing.version > item.version ? existing : item;
    }),
  ];
}

export function taskMutationVersion(task: TaskRecord): number {
  return task.detailVersion ?? task.version;
}

export function taskNeedsDetailRefresh(task: TaskRecord): boolean {
  return task.description === null ||
    Boolean(task.detailStale) ||
    (task.detailVersion !== undefined && task.detailVersion < task.version);
}

type TaskDraft = {
  title: string;
  description: string;
  estimate: string;
};

type TaskDraftDirty = Record<keyof TaskDraft, boolean>;

export function rebaseTaskDraft(
  current: TaskDraft,
  dirty: TaskDraftDirty,
  latest: TaskRecord,
): TaskDraft {
  return {
    title: dirty.title ? current.title : latest.title,
    description: dirty.description
      ? current.description
      : latest.description ?? "",
    estimate: dirty.estimate
      ? current.estimate
      : latest.estimate?.toString() ?? "",
  };
}

export function taskDraftSyncMode(
  hasVersionConflict: boolean,
  dirty: TaskDraftDirty,
): "none" | "auto" | "manual" {
  if (!hasVersionConflict) return "none";
  return Object.values(dirty).some(Boolean) ? "manual" : "auto";
}

export function taskDraftValueChanged(value: string, baseline: string): boolean {
  return value !== baseline;
}

export function resizeTaskTitle(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return;
  textarea.style.height = "0px";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

export function mergeTaskDetailContext(
  current: AppSnapshot,
  detail: TaskDetailRecord,
): AppSnapshot {
  const currentById = new Map(current.tasks.map((task) => [task.id, task]));
  const focusedTask = mergeLoadedTask(
    currentById.get(detail.task.id),
    detail.task,
  );
  const contextualTasks = [
    focusedTask,
    ...detail.relatedTasks.map((task) =>
      mergeTaskSummary(currentById.get(task.id), task)
    ),
  ];
  const contextualIds = new Set(contextualTasks.map((task) => task.id));
  return {
    ...current,
    tasks: [
      ...current.tasks.filter((task) => !contextualIds.has(task.id)),
      ...contextualTasks,
    ],
    labels: mergeUnique(detail.labels, current.labels, (label) => label.id),
    taskLabels: [
      ...current.taskLabels.filter(
        (assignment) => assignment.taskId !== detail.task.id,
      ),
      ...detail.taskLabels,
    ],
    relations: [
      ...current.relations.filter(
        (relation) =>
          relation.sourceTaskId !== detail.task.id &&
          relation.targetTaskId !== detail.task.id,
      ),
      ...detail.relations,
    ],
  };
}

function mergeLoadedTask(
  retained: TaskRecord | undefined,
  incoming: TaskRecord,
): TaskRecord {
  if (retained && retained.version > incoming.version) return retained;
  return {
    ...incoming,
    detailVersion: incoming.version,
    detailStale: false,
    ...(retained?.detailInvalidationCursor !== undefined
      ? { detailInvalidationCursor: retained.detailInvalidationCursor }
      : {}),
    ...(retained?.commentInvalidationCursor !== undefined
      ? { commentInvalidationCursor: retained.commentInvalidationCursor }
      : {}),
    ...(retained?.externalSourceInvalidationCursor !== undefined
      ? {
          externalSourceInvalidationCursor:
            retained.externalSourceInvalidationCursor,
        }
      : {}),
  };
}

export function reconcileTaskDetail(
  current: TaskDetailRecord,
  nextTask: TaskRecord,
  collections: Pick<AppSnapshot, "tasks" | "labels" | "taskLabels" | "relations">,
  removedTaskIds: ReadonlySet<string> = new Set(),
): TaskDetailRecord {
  const taskLabels = collections.taskLabels.filter(
    (assignment) => assignment.taskId === nextTask.id,
  );
  const labelIds = new Set(taskLabels.map((assignment) => assignment.labelId));
  const labels = mergeUnique(
    collections.labels.filter((label) => labelIds.has(label.id)),
    current.labels,
    (label) => label.id,
  ).filter((label) => labelIds.has(label.id));
  const relations = collections.relations.filter(
    (relation) =>
      relation.sourceTaskId === nextTask.id ||
      relation.targetTaskId === nextTask.id,
  );
  const relatedPool = mergeSearchTaskSummaries(
    current.relatedTasks.filter((task) => !removedTaskIds.has(task.id)),
    collections.tasks.filter((task) => task.id !== nextTask.id),
  );
  const relatedIds = new Set<string>();
  if (nextTask.parentTaskId) relatedIds.add(nextTask.parentTaskId);
  for (const relation of relations) {
    relatedIds.add(
      relation.sourceTaskId === nextTask.id
        ? relation.targetTaskId
        : relation.sourceTaskId,
    );
  }
  for (const task of relatedPool) {
    if (task.parentTaskId === nextTask.id) relatedIds.add(task.id);
  }

  return {
    ...current,
    task: nextTask,
    labels,
    taskLabels,
    relations,
    relatedTasks: relatedPool.filter(
      (task) => relatedIds.has(task.id) || task.parentTaskId === nextTask.id,
    ),
  };
}

export function reconcileTaskDetailFromSync(
  current: TaskDetailRecord,
  changes: WorkspaceSyncResponse["changes"],
  cursor?: string,
): TaskDetailRecord | null {
  const removedTaskIds = new Set(changes.tasks.remove);
  if (removedTaskIds.has(current.task.id)) return null;

  const nextFocusedTask = changes.tasks.upsert.find(
    (task) => task.id === current.task.id,
  );
  const detailInvalidated = changes.invalidations.taskDetails.includes(
    current.task.id,
  ) && (!cursor || current.task.detailInvalidationCursor !== cursor);
  const focusedTask = nextFocusedTask
    ? mergeTaskSummary(current.task, nextFocusedTask)
    : current.task;
  const nextCurrent = detailInvalidated
    ? {
        ...current,
        task: {
          ...focusedTask,
          detailStale: true,
          ...(cursor ? { detailInvalidationCursor: cursor } : {}),
        },
      }
    : { ...current, task: focusedTask };

  const relationPeerIds = new Set<string>();
  for (const relation of nextCurrent.relations) {
    if (relation.sourceTaskId === nextCurrent.task.id) {
      relationPeerIds.add(relation.targetTaskId);
    } else if (relation.targetTaskId === nextCurrent.task.id) {
      relationPeerIds.add(relation.sourceTaskId);
    }
  }
  const incomingById = new Map(
    changes.tasks.upsert.map((task) => [task.id, task]),
  );
  incomingById.delete(nextCurrent.task.id);
  const reconciled = nextCurrent.relatedTasks.flatMap((task) => {
    if (removedTaskIds.has(task.id)) return [];
    const incoming = incomingById.get(task.id);
    if (!incoming) return [task];
    incomingById.delete(task.id);
    const merged = mergeTaskSummary(task, incoming);
    return merged.parentTaskId === nextCurrent.task.id ||
        nextCurrent.task.parentTaskId === merged.id ||
        relationPeerIds.has(merged.id)
      ? [merged]
      : [];
  });
  for (const task of incomingById.values()) {
    if (
      task.parentTaskId === nextCurrent.task.id ||
      nextCurrent.task.parentTaskId === task.id ||
      relationPeerIds.has(task.id)
    ) {
      reconciled.push(task);
    }
  }
  return { ...nextCurrent, relatedTasks: reconciled };
}

export function reconcileTaskDetailAfterReset(
  current: TaskDetailRecord,
  incoming: AppSnapshot,
): TaskDetailRecord {
  const incomingTask = incoming.tasks.find((task) => task.id === current.task.id);
  return incomingTask
    ? { ...current, task: mergeTaskSummary(current.task, incomingTask) }
    : current;
}

export function reconcileTaskSearch(
  current: TaskSearchState | null,
  changes: Pick<WorkspaceSyncResponse["changes"], "tasks">,
): TaskSearchState | null {
  if (!current) return current;
  const removedTaskIds = new Set(changes.tasks.remove);
  const incomingById = new Map(
    changes.tasks.upsert.map((task) => [task.id, task]),
  );
  return {
    ...current,
    taskIds: current.taskIds.filter((taskId) => !removedTaskIds.has(taskId)),
    tasks: current.tasks
      .filter((task) => !removedTaskIds.has(task.id))
      .map((task) => {
        const incoming = incomingById.get(task.id);
        return incoming ? mergeTaskSummary(task, incoming) : task;
      }),
  };
}

export function taskMatchesSearch(
  task: TaskRecord,
  needle: string,
  remoteMatches: ReadonlySet<string> | null,
): boolean {
  if (remoteMatches) return remoteMatches.has(task.id);
  return task.identifier.toLowerCase() === needle ||
    task.identifier.toLowerCase().includes(needle) ||
    task.title.toLowerCase().includes(needle) ||
    (task.description?.toLowerCase().includes(needle) ?? false);
}

function mergeUnique<T>(incoming: T[], current: T[], key: (item: T) => string): T[] {
  const seen = new Set(incoming.map(key));
  return [...incoming, ...current.filter((item) => !seen.has(key(item)))];
}

const builtInViews = [
  { id: "all", label: "All tasks" },
  { id: "active", label: "Active" },
  { id: "backlog", label: "Backlog" },
  { id: "archived", label: "Archived" },
];

type BreadcrumbItem = {
  label: string;
  surface?: string;
  layout?: Layout;
};

export function TaskTracker({
  initialData,
  initialNavigation,
  signOutPath,
}: {
  initialData: AppSnapshot;
  initialNavigation: ResolvedNavigation;
  signOutPath: string;
}) {
  const [data, setData] = useState(initialData);
  const dataRef = useRef(data);
  const [surface, setSurface] = useState(initialNavigation.surface);
  const [layout, setLayout] = useState<Layout>(initialNavigation.layout);
  const [search, setSearch] = useState("");
  const [taskSearch, setTaskSearch] = useState<TaskSearchState | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetailRecord | null>(null);
  const [forcedTaskDetailId, setForcedTaskDetailId] = useState<string | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<Priority | "all">("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [createDefaults, setCreateDefaults] = useState<TaskCreateDefaults>({});
  const [groupByOverrides, setGroupByOverrides] = useState<Partial<Record<string, ViewDisplay["groupBy"]>>>({});
  const [activeTaskId, setActiveTaskId] = useState<string | null>(
    initialNavigation.taskId,
  );
  const [peekTaskId, setPeekTaskId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [highlighted, setHighlighted] = useState(0);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [taskWindowLoading, setTaskWindowLoading] = useState(
    Boolean(initialData.taskWindow?.truncated),
  );
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [pullRefreshError, setPullRefreshError] = useState("");
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const pullRefreshFlight = useRef<Promise<AppSnapshot> | null>(null);
  const [systemBackupBusy, setSystemBackupBusy] = useState(false);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [viewReferenceTime] = useState(() => Date.now());
  const searchRef = useRef<HTMLInputElement>(null);
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const mobileActionsRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileMenuRef = useRef<HTMLButtonElement>(null);
  const mobileSidebarCloseRef = useRef<HTMLButtonElement>(null);
  const taskReturnPath = useRef(
    navigationPath({ ...initialNavigation, taskId: null }, initialData),
  );

  const captureSyncCheckpoint = useCallback((): WorkspaceSyncCheckpoint => ({
    taskIds: new Set(dataRef.current.tasks.map((task) => task.id)),
    projectIds: new Set(dataRef.current.projects.map((project) => project.id)),
    releaseIds: new Set(dataRef.current.releases.map((release) => release.id)),
    viewIds: new Set(dataRef.current.views.map((view) => view.id)),
  }), []);
  const returnToWorkspaceAfterRemoval = useCallback(() => {
    setSurface("workspace");
    setLayout("list");
    setActiveTaskId(null);
    setPeekTaskId(null);
    setTaskDetail(null);
    setForcedTaskDetailId(null);
    taskReturnPath.current = navigationPath(
      { surface: "workspace", layout: "list", taskId: null },
      dataRef.current,
    );
    window.history.replaceState(
      navigationHistoryState({ surface: "workspace", layout: "list", taskId: null }),
      "",
      taskReturnPath.current,
    );
  }, []);
  const applyIncrementalSync = useCallback((response: WorkspaceSyncResponse) => {
    const removedTaskIds = new Set(response.changes.tasks.remove);
    const removedProjectIds = new Set(response.changes.projects.remove);
    const removedReleaseIds = new Set(response.changes.releases.remove);
    const removedViewIds = new Set(response.changes.views.remove);
    setData((current) => applyWorkspaceSync(current, response));
    setSelected((current) => new Set(
      [...current].filter((taskId) => !removedTaskIds.has(taskId)),
    ));
    setPeekTaskId((current) => current && removedTaskIds.has(current) ? null : current);
    setTaskDetail((current) => current
      ? reconcileTaskDetailFromSync(current, response.changes, response.cursor)
      : current);
    if (response.changes.tasks.upsert.length || removedTaskIds.size) {
      setTaskSearch((current) => reconcileTaskSearch(current, response.changes));
      setRefreshEpoch((current) => current + 1);
    }
    const activeTaskWasRemoved = activeTaskId !== null && removedTaskIds.has(activeTaskId);
    const surfaceWasRemoved =
      (surface.startsWith("project:") && removedProjectIds.has(surface.slice(8))) ||
      (surface.startsWith("project-releases:") &&
        removedProjectIds.has(surface.slice("project-releases:".length))) ||
      (surface.startsWith("release:") && removedReleaseIds.has(surface.slice(8))) ||
      (surface.startsWith("view:") && removedViewIds.has(surface.slice(5)));
    if (activeTaskWasRemoved || surfaceWasRemoved) returnToWorkspaceAfterRemoval();
  }, [activeTaskId, returnToWorkspaceAfterRemoval, surface]);
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
    setTaskDetail((current) => {
      if (!current) return current;
      return reconcileTaskDetailAfterReset(current, incoming);
    });
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
    setTaskWindowLoading(false);
    setRefreshEpoch((current) => current + 1);
    if (activeTaskId !== null) setForcedTaskDetailId(activeTaskId);
    const surfaceWasRemoved =
      (surface.startsWith("project:") &&
        checkpoint.projectIds.has(surface.slice(8)) &&
        !incoming.projects.some((project) => project.id === surface.slice(8))) ||
      (surface.startsWith("project-releases:") &&
        checkpoint.projectIds.has(surface.slice("project-releases:".length)) &&
        !incoming.projects.some(
          (project) => project.id === surface.slice("project-releases:".length),
        )) ||
      (surface.startsWith("release:") &&
        checkpoint.releaseIds.has(surface.slice(8)) &&
        !incoming.releases.some((release) => release.id === surface.slice(8))) ||
      (surface.startsWith("view:") &&
        checkpoint.viewIds.has(surface.slice(5)) &&
        !incoming.views.some((view) => view.id === surface.slice(5)));
    if (surfaceWasRemoved) returnToWorkspaceAfterRemoval();
  }, [activeTaskId, returnToWorkspaceAfterRemoval, surface]);

  useWorkspaceSyncCoordinator({
    cursor: data.syncCursor,
    captureCheckpoint: captureSyncCheckpoint,
    onIncremental: applyIncrementalSync,
    onReset: applySyncReset,
  });

  const statusMap = useMemo(
    () => new Map(data.statuses.map((status) => [status.id, status])),
    [data.statuses],
  );
  const projectMap = useMemo(
    () => new Map(data.projects.map((project) => [project.id, project])),
    [data.projects],
  );
  const releaseMap = useMemo(
    () => new Map(data.releases.map((release) => [release.id, release])),
    [data.releases],
  );
  const userMap = useMemo(
    () => new Map([...data.users, data.user].map((user) => [user.id, user])),
    [data.user, data.users],
  );

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    const saved = window.localStorage.getItem("tm-theme");
    if (saved === "light" || saved === "dark" || saved === "system") {
      // Local storage is the external source for this device preference.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTheme(saved);
    }
    const sidebar = window.localStorage.getItem("tm-sidebar");
    setSidebarCollapsed(sidebar === "collapsed");
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("tm-theme", theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(
      "tm-sidebar",
      sidebarCollapsed ? "collapsed" : "expanded",
    );
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    function handlePointerDown(event: PointerEvent) {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [accountMenuOpen]);

  useEffect(() => {
    if (!mobileActionsOpen) return;
    function handlePointerDown(event: PointerEvent) {
      if (!mobileActionsRef.current?.contains(event.target as Node)) {
        setMobileActionsOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [mobileActionsOpen]);

  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const timer = window.setTimeout(() => {
      mobileSidebarCloseRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [mobileSidebarOpen]);

  useEffect(() => {
    window.history.replaceState(
      navigationHistoryState(initialNavigation),
      "",
      window.location.href,
    );
  }, [initialNavigation]);

  useEffect(() => {
    if (!taskWindowLoading) return;
    const controller = new AbortController();
    let idleId: number | null = null;
    let timerId: number | null = null;
    const idleWindow = window as unknown as {
      requestIdleCallback?: (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const loadRemainingTasks = () => {
      const checkpoint = captureSyncCheckpoint();
      void fetch("/api/bootstrap", { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          const value = (await response.json()) as AppSnapshot | { error: string };
          if (!response.ok || "error" in value) {
            throw new Error("error" in value ? value.error : "Task loading failed");
          }
          setData((current) => mergeDeferredSnapshot(current, value, {
            taskIdsAtRequest: checkpoint.taskIds,
            projectIdsAtRequest: checkpoint.projectIds,
            releaseIdsAtRequest: checkpoint.releaseIds,
            viewIdsAtRequest: checkpoint.viewIds,
          }));
          setTaskWindowLoading(false);
        })
        .catch((requestError: unknown) => {
          if (requestError instanceof DOMException && requestError.name === "AbortError") {
            return;
          }
          setTaskWindowLoading(false);
          setError(requestError instanceof Error ? requestError.message : "Could not load remaining tasks");
        });
    };

    if (idleWindow.requestIdleCallback) {
      idleId = idleWindow.requestIdleCallback(loadRemainingTasks, { timeout: 800 });
    } else {
      timerId = window.setTimeout(loadRemainingTasks, 0);
    }

    return () => {
      controller.abort();
      if (idleId !== null) idleWindow.cancelIdleCallback?.(idleId);
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [captureSyncCheckpoint, taskWindowLoading]);

  const activeSavedView = surface.startsWith("view:")
    ? data.views.find((view) => view.id === surface.slice(5))
    : undefined;
  const savedGroupBy = activeSavedView?.display.groupBy ?? "status";
  const currentGroupBy = groupByOverrides[surface] ?? savedGroupBy;
  const searchNeedle = (search || activeSavedView?.query.search || "").trim().toLowerCase();

  useEffect(() => {
    if (!searchNeedle) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch(`/api/tasks?search=${encodeURIComponent(searchNeedle)}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          const value = (await response.json()) as
            | { taskIds: string[]; tasks: TaskRecord[] }
            | { error: string };
          if (!response.ok || "error" in value) {
            throw new Error("error" in value ? value.error : "Task search failed");
          }
          if (controller.signal.aborted) return;
          setTaskSearch({
            query: searchNeedle,
            taskIds: value.taskIds,
            tasks: value.tasks,
            status: "ready",
          });
        })
        .catch((requestError: unknown) => {
          if (requestError instanceof DOMException && requestError.name === "AbortError") {
            return;
          }
          setTaskSearch({
            query: searchNeedle,
            taskIds: [],
            tasks: [],
            status: "error",
          });
          setError(requestError instanceof Error ? requestError.message : "Task search failed");
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [refreshEpoch, searchNeedle]);

  function refreshTaskList() {
    return runSingleFlight(pullRefreshFlight, async () => {
      setPullRefreshing(true);
      setPullRefreshError("");
      const checkpoint = captureSyncCheckpoint();
      try {
        const incoming = await fetchTaskSnapshot();
        setData((current) => mergeDeferredSnapshot(current, incoming, {
          taskIdsAtRequest: checkpoint.taskIds,
          projectIdsAtRequest: checkpoint.projectIds,
          releaseIdsAtRequest: checkpoint.releaseIds,
          viewIdsAtRequest: checkpoint.viewIds,
        }));
        setTaskWindowLoading(false);
        setRefreshEpoch((current) => current + 1);
        return incoming;
      } catch (requestError) {
        setPullRefreshError(
          requestError instanceof Error ? requestError.message : "Refresh failed",
        );
        throw requestError;
      } finally {
        setPullRefreshing(false);
      }
    });
  }

  const taskPool = useMemo(
    () => taskSearch?.query === searchNeedle
      ? mergeSearchTaskSummaries(data.tasks, taskSearch.tasks)
      : data.tasks,
    [data.tasks, searchNeedle, taskSearch],
  );

  const visibleTasks = useMemo(() => {
    let tasks = taskPool;
    const query: ViewQuery = activeSavedView?.query ?? {};
    if (surface === "shared") {
      tasks = tasks.filter((task) => task.accessRole !== "owner");
    } else if (surface.startsWith("project:")) {
      tasks = tasks.filter((task) => task.projectId === surface.slice(8));
    } else if (surface.startsWith("release:")) {
      tasks = tasks.filter((task) => task.releaseId === surface.slice(8));
    } else if (surface === "active") {
      tasks = tasks.filter((task) => {
        const category = statusMap.get(task.statusId)?.category;
        return category === "unstarted" || category === "started";
      });
    } else if (surface === "backlog") {
      tasks = tasks.filter(
        (task) => statusMap.get(task.statusId)?.category === "backlog",
      );
    }

    const showArchived = surface === "archived" || query.archived === true;
    tasks = tasks.filter((task) => (showArchived ? task.archivedAt : !task.archivedAt));
    if (query.projectId !== undefined) {
      tasks = tasks.filter((task) => task.projectId === query.projectId);
    }
    if (activeSavedView?.scopeProjectId) {
      tasks = tasks.filter(
        (task) => task.projectId === activeSavedView.scopeProjectId,
      );
    }
    if (query.releaseId !== undefined) {
      tasks = tasks.filter((task) => task.releaseId === query.releaseId);
    }
    if (query.statusIds?.length) {
      tasks = tasks.filter((task) => query.statusIds?.includes(task.statusId));
    }
    if (query.priorities?.length) {
      tasks = tasks.filter((task) => query.priorities?.includes(task.priority));
    }
    if (query.updatedWithinHours && query.updatedWithinHours > 0) {
      const cutoff = viewReferenceTime - query.updatedWithinHours * 60 * 60 * 1000;
      tasks = tasks.filter((task) => new Date(task.updatedAt).getTime() >= cutoff);
    }
    if (statusFilter !== "all") tasks = tasks.filter((task) => task.statusId === statusFilter);
    if (priorityFilter !== "all") tasks = tasks.filter((task) => task.priority === priorityFilter);
    const needle = searchNeedle;
    if (needle) {
      const remoteMatches = taskSearch?.query === needle
        ? new Set(taskSearch.taskIds)
        : null;
      tasks = tasks.filter((task) => taskMatchesSearch(task, needle, remoteMatches));
    }
    return sortTasks(tasks, activeSavedView?.display);
  }, [
    activeSavedView,
    taskPool,
    priorityFilter,
    searchNeedle,
    statusFilter,
    statusMap,
    surface,
    taskSearch,
    viewReferenceTime,
  ]);
  const taskSearchStatus = searchNeedle && visibleTasks.length === 0
    ? taskSearch?.query !== searchNeedle
      ? "loading"
      : taskSearch.status === "error"
        ? "error"
        : null
    : null;

  const breadcrumbs = surfaceBreadcrumbs(surface, data, activeSavedView);
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
    if (!taskDetailRequestId) return;
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(
        `/api/tasks/${encodeURIComponent(taskDetailRequestId)}`,
        { cache: "no-store", signal: controller.signal },
      );
        const value = (await response.json()) as
          | TaskDetailRecord
          | { error: string };
        if (response.status === 403 || response.status === 404) {
          setForcedTaskDetailId((current) =>
            current === taskDetailRequestId ? null : current);
          setTaskDetail((current) =>
            current?.task.id === taskDetailRequestId ? null : current);
          if (activeTaskId === taskDetailRequestId) {
            returnToWorkspaceAfterRemoval();
          }
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
        setForcedTaskDetailId((current) =>
          current === taskDetailRequestId ? null : current);
      })()
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") {
          return;
        }
        setForcedTaskDetailId((current) =>
          current === taskDetailRequestId ? null : current);
        setError(requestError instanceof Error ? requestError.message : "Could not load task details");
      });
    return () => controller.abort();
  }, [activeTaskId, returnToWorkspaceAfterRemoval, taskDetailRequestId]);
  const activeDetailsData = activeTask && taskDetail?.task.id === activeTask.id
    ? mergeTaskDetailContext(data, { ...taskDetail, task: activeTask })
    : data;
  const selectedTasks = [...selected]
    .map((id) => data.tasks.find((task) => task.id === id))
    .filter(Boolean) as TaskRecord[];
  const archiveAction = resolveArchiveBulkAction(selectedTasks);
  const projectReleaseSurfaceId = surface.startsWith("project-releases:")
    ? surface.slice("project-releases:".length)
    : null;
  const contextRelease = surface.startsWith("release:") ? surface.slice(8) : null;
  const contextReleaseRecord = contextRelease
    ? data.releases.find((release) => release.id === contextRelease)
    : undefined;
  const contextProject = surface.startsWith("project:")
    ? surface.slice(8)
    : projectReleaseSurfaceId ??
      contextReleaseRecord?.projectId ??
      activeSavedView?.scopeProjectId ??
      null;
  const scopedReleases = projectReleaseSurfaceId
    ? data.releases.filter((release) => release.projectId === projectReleaseSurfaceId)
    : data.releases;
  const surfaceCount = surface === "workspace"
    ? data.tasks.filter((task) => !task.archivedAt).length +
      data.projects.length + data.releases.length + data.views.length
    : surface === "views"
    ? builtInViews.length + data.views.length
    : surface === "admin" && data.admin
      ? data.admin.registeredUserCount
    : projectReleaseSurfaceId
      ? scopedReleases.length
      : visibleTasks.length;
  const contextProjectRecord = contextProject
    ? data.projects.find((project) => project.id === contextProject)
    : undefined;
  const groupingOwnerIds = new Set(visibleTasks.map((task) => task.ownerUserId));
  if (!groupingOwnerIds.size) {
    groupingOwnerIds.add(contextProjectRecord?.ownerUserId ?? data.user.id);
  }
  const visibleStatuses = data.statuses
    .filter((status) => groupingOwnerIds.has(status.ownerUserId))
    .filter((status) => !status.archivedAt || visibleTasks.some((task) => task.statusId === status.id))
    .sort((left, right) => left.position - right.position);
  const groupingProjects = contextProject
    ? data.projects.filter((project) => project.id === contextProject)
    : data.projects;
  const groupingReleases = contextProject
    ? data.releases.filter((release) => release.projectId === contextProject)
    : data.releases;
  const groupingUsers = contextProject
    ? taskAssigneeOptions(data, contextProject)
    : [...userMap.values()];
  const createAssigneeUserIds = new Set<string>([data.user.id]);
  if (contextProjectRecord) {
    createAssigneeUserIds.add(contextProjectRecord.ownerUserId);
    for (const collaborator of data.collaborators) {
      if (
        collaborator.resourceType === "project" &&
        collaborator.resourceId === contextProjectRecord.id
      ) {
        createAssigneeUserIds.add(collaborator.userId);
      }
    }
  }
  const taskGroups = buildTaskGroups({
    tasks: visibleTasks,
    statuses: visibleStatuses,
    projects: groupingProjects,
    releases: groupingReleases,
    users: groupingUsers,
    groupBy: currentGroupBy,
    showEmptyGroups: shouldShowEmptyTaskGroups(
      currentGroupBy,
      activeSavedView?.display.showEmptyGroups ?? true,
      draggingTaskId !== null,
    ),
  });
  const keyboardTasks = layout === "list" && currentGroupBy !== "none"
    ? tasksInGroupOrder(taskGroups, collapsedGroups)
    : visibleTasks;
  const currentShareTarget = shareTarget(surface, activeTask, data);
  const canCreateTask = contextProjectRecord
    ? canEditContent(contextProjectRecord.accessRole)
    : data.projects.some((project) => canEditContent(project.accessRole));
  const canSaveView = contextProjectRecord
    ? canEditContent(contextProjectRecord.accessRole)
    : activeSavedView
      ? canEditContent(activeSavedView.accessRole)
      : true;
  const sidebarCompact = sidebarCollapsed && !mobileSidebarOpen;
  const hasViewChanges = Boolean(
    search || priorityFilter !== "all" || statusFilter !== "all" || currentGroupBy !== savedGroupBy,
  );

  async function mutate(path: string, method: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = (await response.json()) as MutationResult | { error: string };
      if (!response.ok || "error" in value) {
        throw new Error("error" in value ? value.error : "Request failed");
      }
      setData((current) => applyMutationResult(current, value));
      if ("task" in value) {
        setTaskDetail((current) =>
          current?.task.id === value.task.id
            ? { ...current, task: mergeTaskMutation(current.task, value.task) }
            : current,
        );
        setTaskSearch((current) => current
          ? {
              ...current,
              tasks: current.tasks.map((task) =>
                task.id === value.task.id
                  ? mergeTaskSummary(task, value.task)
                  : task,
              ),
            }
          : current,
        );
      }
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createTaskForComposer(
    input: Record<string, unknown>,
  ): Promise<TaskRecord | null> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const value = (await response.json()) as
        | (AppSnapshot & { createdTask: { id: string; publicId: string } })
        | { error: string };
      if (!response.ok || "error" in value) {
        throw new Error("error" in value ? value.error : "Task could not be created");
      }
      const { createdTask, ...snapshot } = value;
      const task = snapshot.tasks.find((item) => item.id === createdTask.id) ?? null;
      setData(snapshot);
      return task;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Task could not be created");
      return null;
    } finally {
      setBusy(false);
    }
  }

  function updateClientTask(
    taskId: string,
    update: (task: TaskRecord) => TaskRecord,
  ) {
    setData((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === taskId ? update(task) : task),
    }));
    setTaskSearch((current) => current
      ? {
          ...current,
          tasks: current.tasks.map((task) => task.id === taskId ? update(task) : task),
        }
      : current,
    );
    setTaskDetail((current) => current?.task.id === taskId
      ? { ...current, task: update(current.task) }
      : current,
    );
  }

  async function moveTaskToGroup(
    task: TaskRecord,
    group: TaskGroup,
    rank: number,
  ) {
    if (
      !canMoveTaskToGroup(task, group) ||
      taskMatchesGroup(task, group) ||
      (group.kind === "status" && Boolean(statusMap.get(group.value ?? "")?.archivedAt))
    ) {
      return false;
    }
    const optimistic = projectTaskGroupMove(task, group, rank);
    updateClientTask(
      task.id,
      (current) => projectTaskGroupMove(current, group, rank),
    );
    const saved = await mutate(`/api/tasks/${task.id}`, "PATCH", {
      version: taskMutationVersion(task),
      ...taskGroupMutation(group, rank),
    });
    if (!saved) {
      updateClientTask(
        task.id,
        (current) => rollbackTaskGroupMove(current, task, optimistic),
      );
    }
    return saved;
  }

  const refreshTaskDetail = useCallback(async (taskId: string): Promise<TaskRecord | null> => {
    setError("");
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        cache: "no-store",
      });
      const value = (await response.json()) as TaskDetailRecord | { error: string };
      if (!response.ok || "error" in value) {
        throw new Error("error" in value ? value.error : "Could not refresh task");
      }
      const retained = dataRef.current.tasks.find((task) => task.id === taskId);
      if (retained && retained.version > value.task.version) return retained;
      setTaskDetail((current) => current?.task.id === taskId
        ? { ...value, task: mergeLoadedTask(current.task, value.task) }
        : current);
      setData((current) => {
        const currentTask = current.tasks.find((task) => task.id === taskId);
        if (currentTask && currentTask.version > value.task.version) return current;
        return mergeTaskDetailContext(current, value);
      });
      return value.task;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not refresh task");
      return null;
    }
  }, []);

  async function downloadSystemBackup() {
    setSystemBackupBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/export", {
        method: "POST",
        headers: { "x-task-manager-action": "system-backup" },
      });
      if (!response.ok) {
        const value = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(value?.error ?? "Could not export the system backup");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1]
        ?? `task-manager-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not export the system backup");
      return false;
    } finally {
      setSystemBackupBusy(false);
    }
  }

  async function downloadProjectBackup(project: ProjectRecord) {
    setSystemBackupBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/export`, {
        method: "POST",
        headers: { "x-task-manager-action": "project-backup" },
      });
      if (!response.ok) {
        const value = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(value?.error ?? "Could not export the project backup");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1]
        ?? `task-manager-project-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not export the project backup");
    } finally {
      setSystemBackupBusy(false);
    }
  }

  function applyNavigation(
    next: ResolvedNavigation,
    historyMode: "push" | "replace" | "none" = "push",
  ) {
    setSurface(next.surface);
    setLayout(next.layout);
    setActiveTaskId(next.taskId);
    if (!next.taskId) taskReturnPath.current = navigationPath(next, data);
    if (historyMode === "push") {
      window.history.pushState(
        navigationHistoryState(next),
        "",
        navigationPath(next, data),
      );
    } else if (historyMode === "replace") {
      window.history.replaceState(
        navigationHistoryState(next),
        "",
        navigationPath(next, data),
      );
    }
  }

  function navigateSurface(nextSurface: string, nextLayout?: Layout) {
    setMobileSidebarOpen(false);
    setMobileActionsOpen(false);
    applyNavigation({
      surface: nextSurface,
      layout: nextLayout ?? defaultLayoutForSurface(nextSurface, data),
      taskId: null,
    });
  }

  function closeMobileSidebar() {
    setMobileSidebarOpen(false);
    window.setTimeout(() => {
      mobileMenuRef.current?.focus();
    }, 0);
  }

  function changeLayout(nextLayout: Layout) {
    setMobileActionsOpen(false);
    applyNavigation({ surface, layout: nextLayout, taskId: null });
  }

  function changeGroupBy(nextGroupBy: ViewDisplay["groupBy"]) {
    setGroupByOverrides((current) => ({ ...current, [surface]: nextGroupBy }));
    setCollapsedGroups(new Set());
  }

  function openTask(taskId: string) {
    if (!activeTaskId) {
      taskReturnPath.current = navigationPath(
        { surface, layout, taskId: null },
        data,
      );
    }
    applyNavigation({ surface, layout, taskId });
  }

  function closeTask() {
    setActiveTaskId(null);
    const target = parseNavigationPath(taskReturnPath.current);
    const next = target ? resolveNavigationTarget(target, data) : null;
    window.history.replaceState(
      next ? navigationHistoryState(next) : null,
      "",
      taskReturnPath.current,
    );
  }

  async function copyCurrentLink() {
    await navigator.clipboard.writeText(window.location.href);
  }

  function openCreate(defaults: TaskCreateDefaults = {}) {
    if (!canCreateTask) return;
    setMobileSidebarOpen(false);
    setMobileActionsOpen(false);
    setCreateDefaults(defaults);
    setDialog("task");
  }

  function focusSearch() {
    const mobile = window.matchMedia("(max-width: 900px)").matches;
    setMobileSidebarOpen(false);
    if (mobile) setMobileActionsOpen(true);
    window.requestAnimationFrame(() => {
      const target = mobile ? mobileSearchRef.current : searchRef.current;
      target?.focus();
    });
  }

  function toggleSelection(id: string, additive = true) {
    const task = data.tasks.find((item) => item.id === id);
    if (!task || !canEditContent(task.accessRole)) return;
    setSelected((current) => {
      const next = additive ? new Set(current) : new Set<string>();
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    function handlePopState(event: PopStateEvent) {
      const target = parseNavigationPath(window.location.pathname);
      const resolved =
        resolveNavigationHistoryState(
          event.state,
          window.location.pathname,
          data,
        ) ?? (target ? resolveNavigationTarget(target, data) : null);
      if (resolved) {
        setSurface(resolved.surface);
        setLayout(resolved.layout);
        setActiveTaskId(resolved.taskId);
        if (!resolved.taskId) {
          taskReturnPath.current = navigationPath(resolved, data);
        }
      }
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [data]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
      if (event.key === "Escape") {
        if (mobileActionsOpen) setMobileActionsOpen(false);
        else if (mobileSidebarOpen) closeMobileSidebar();
        else if (accountMenuOpen) {
          setAccountMenuOpen(false);
          accountTriggerRef.current?.focus();
        }
        else if (dialog && !systemBackupBusy) setDialog(null);
        else if (activeTaskId) {
          setActiveTaskId(null);
          const target = parseNavigationPath(taskReturnPath.current);
          const next = target ? resolveNavigationTarget(target, data) : null;
          window.history.replaceState(
            next ? navigationHistoryState(next) : null,
            "",
            taskReturnPath.current,
          );
        }
        else if (peekTaskId) setPeekTaskId(null);
        else if (selected.size) setSelected(new Set());
        return;
      }
      if (typing) return;
      if (surface === "admin") return;
      if (surface === "workspace") {
        if (event.key.toLowerCase() === "c") {
          event.preventDefault();
          openCreate();
        }
        return;
      }
      if (event.key.toLowerCase() === "c") {
        event.preventDefault();
        if (canCreateTask) openCreate();
      } else if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFilterOpen((value) => !value);
      } else if (event.key.toLowerCase() === "b" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        const nextLayout = layout === "list" ? "board" : "list";
        const next: ResolvedNavigation = { surface, layout: nextLayout, taskId: null };
        setLayout(nextLayout);
        setActiveTaskId(null);
        taskReturnPath.current = navigationPath(next, data);
        window.history.pushState(
          navigationHistoryState(next),
          "",
          navigationPath(next, data),
        );
      } else if (["j", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        setHighlighted((value) =>
          Math.min(value + 1, Math.max(0, keyboardTasks.length - 1)),
        );
      } else if (["k", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        setHighlighted((value) => Math.max(0, value - 1));
      } else if (event.key.toLowerCase() === "x" && keyboardTasks[highlighted]) {
        event.preventDefault();
        toggleSelection(keyboardTasks[highlighted].id);
      } else if (event.key === " " && keyboardTasks[highlighted]) {
        event.preventDefault();
        setPeekTaskId(keyboardTasks[highlighted].id);
      } else if (event.key.toLowerCase() === "a" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSelected(new Set(visibleTasks.filter((task) => canEditContent(task.accessRole)).map((task) => task.id)));
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
    // The handlers close over the state listed below; adding the local wrapper
    // functions themselves would recreate this listener on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountMenuOpen, activeTaskId, canCreateTask, data, dialog, highlighted, keyboardTasks, layout, mobileActionsOpen, mobileSidebarOpen, peekTaskId, selected.size, surface, systemBackupBusy, visibleTasks]);

  useEffect(() => {
    // Navigation changes deliberately reset ephemeral list state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHighlighted(0);
    setSelected(new Set());
  }, [surface, search, priorityFilter, statusFilter]);

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${mobileSidebarOpen ? "mobile-sidebar-open" : ""}`}>
      {mobileSidebarOpen && (
        <button
          className="mobile-sidebar-backdrop"
          type="button"
          aria-label="Close navigation"
          onMouseDown={(event) => event.preventDefault()}
          onClick={closeMobileSidebar}
        />
      )}
      <aside className="sidebar" id="workspace-sidebar">
        <div className="sidebar-head">
          <a
            className="workspace-switcher"
            href={navigationPath({ surface: "workspace", layout: "list", taskId: null }, data)}
            title="Go to workspace"
            aria-current={surface === "workspace" ? "page" : undefined}
            onClick={(event) => handleLocalLink(event, () => navigateSurface("workspace", "list"))}
          >
            <span className="product-mark">T</span>
            {!sidebarCompact && <span className="workspace-name">Task Manager</span>}
          </a>
          {!sidebarCompact && (
            <button className="icon-button" onClick={() => openCreate()} title="Create task (C)">
              <Plus size={15} />
            </button>
          )}
          {mobileSidebarOpen && (
            <button
              ref={mobileSidebarCloseRef}
              className="icon-button mobile-sidebar-close"
              type="button"
              aria-label="Close navigation"
              onClick={closeMobileSidebar}
              autoFocus
            >
              <X size={16} />
            </button>
          )}
        </div>
        {!sidebarCompact && (
          <button className="sidebar-search" onClick={focusSearch}>
            <Search size={14} /><span>Search</span><kbd>/</kbd>
          </button>
        )}
        <nav className="nav-scroll" aria-label="Workspace">
          <NavItem compact={sidebarCompact} icon={<Inbox size={15} />} label="My tasks" active={builtInViews.some((view) => view.id === surface)} href="/issues" onNavigate={() => navigateSurface("all", "list")} />
          <NavItem compact={sidebarCompact} icon={<UsersRound size={15} />} label="Shared with me" active={surface === "shared"} href="/shared" onNavigate={() => navigateSurface("shared", "list")} />
          {!sidebarCompact && (
            <>
              <SidebarSection title="Views" action={() => setDialog("view")}>
                <NavItem compact={false} icon={<Boxes size={13} />} label="All views" active={surface === "views"} href="/views" onNavigate={() => navigateSurface("views", "list")} />
                {builtInViews.map((view) => (
                  <NavItem key={view.id} compact={false} icon={<Circle size={9} />} label={view.label} active={surface === view.id} href={navigationPath({ surface: view.id, layout: "list", taskId: null }, data)} onNavigate={() => navigateSurface(view.id, "list")} count={taskCountForView(view.id, data, statusMap)} />
                ))}
                {data.views.map((view) => (
                  <NavItem key={view.id} compact={false} icon={<Zap size={13} />} label={view.name} active={surface === `view:${view.id}`} href={navigationPath({ surface: `view:${view.id}`, layout: view.display.layout, taskId: null }, data)} onNavigate={() => navigateSurface(`view:${view.id}`, view.display.layout)} />
                ))}
              </SidebarSection>
              <SidebarSection title="Projects" action={() => setDialog("project")}>
                <NavItem compact={false} icon={<Boxes size={13} />} label="All projects" active={surface === "projects"} href="/projects" onNavigate={() => navigateSurface("projects", "list")} />
                {data.projects.map((project) => (
                  <NavItem key={project.id} compact={false} icon={<span className="project-dot" style={{ background: project.color }} />} label={project.name} active={surface === `project:${project.id}`} href={navigationPath({ surface: `project:${project.id}`, layout: "list", taskId: null }, data)} onNavigate={() => navigateSurface(`project:${project.id}`, "list")} />
                ))}
              </SidebarSection>
              <SidebarSection title="Releases" action={() => setDialog("release")}>
                <NavItem compact={false} icon={<Rocket size={13} />} label="All releases" active={surface === "releases"} href="/releases" onNavigate={() => navigateSurface("releases", "list")} />
                {data.releases.slice(0, 6).map((release) => (
                  <NavItem key={release.id} compact={false} icon={<CircleDot size={12} />} label={formatReleaseName(projectMap.get(release.projectId)?.name, release.name)} active={surface === `release:${release.id}`} href={navigationPath({ surface: `release:${release.id}`, layout: "list", taskId: null }, data)} onNavigate={() => navigateSurface(`release:${release.id}`, "list")} />
                ))}
              </SidebarSection>
            </>
          )}
        </nav>
        <div className="sidebar-foot">
          <div className="account-control" ref={accountMenuRef}>
            {accountMenuOpen && (
              <div className="account-menu" role="menu" aria-label="Account menu">
                <div className="account-menu-user">
                  <span className="avatar">{initials(data.user.displayName)}</span>
                  <span>
                    <b>{data.user.displayName}</b>
                    <small>{data.user.email}</small>
                  </span>
                </div>
                <p className="account-provider">Signed in with ChatGPT</p>
                <div className="account-menu-separator" role="separator" />
                <a
                  className="account-menu-item"
                  href={navigationPath({ surface: "all", layout: "list", taskId: null }, data)}
                  role="menuitem"
                  onClick={(event) => handleLocalLink(event, () => {
                    navigateSurface("all", "list");
                    setAccountMenuOpen(false);
                  })}
                >
                  <Inbox size={14} />
                  <span>My tasks</span>
                </a>
                <button
                  className="account-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAccountMenuOpen(false);
                    setDialog("codexSetup");
                  }}
                >
                  <CircleHelp size={14} />
                  <span>Codex setup</span>
                </button>
                <button
                  className="account-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAccountMenuOpen(false);
                    setDialog("workflowSettings");
                  }}
                >
                  <SlidersHorizontal size={14} />
                  <span>Workflow statuses</span>
                </button>
                <a className="account-menu-item" href="/import/project" role="menuitem">
                  <Download size={14} />
                  <span>Project backup</span>
                </a>
                {data.isAdmin && (
                  <a
                    className="account-menu-item"
                    href={navigationPath({ surface: "admin", layout: "list", taskId: null }, data)}
                    role="menuitem"
                  >
                    <ShieldCheck size={14} />
                    <span>Administration</span>
                  </a>
                )}
                <div className="account-menu-separator" role="separator" />
                <div className="account-theme" role="group" aria-label="Appearance">
                  <span>Appearance</span>
                  <div>
                    <button role="menuitemradio" aria-checked={theme === "system"} className={theme === "system" ? "active" : ""} onClick={() => setTheme("system")} title="Use system theme"><Monitor size={13} /></button>
                    <button role="menuitemradio" aria-checked={theme === "light"} className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")} title="Use light theme"><Sun size={13} /></button>
                    <button role="menuitemradio" aria-checked={theme === "dark"} className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")} title="Use dark theme"><Moon size={13} /></button>
                  </div>
                </div>
              </div>
            )}
            <div className="profile-row">
              <button
                className="profile-trigger"
                ref={accountTriggerRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={accountMenuOpen}
                title={sidebarCompact ? "Open account menu" : undefined}
                onClick={() => setAccountMenuOpen((value) => !value)}
              >
                <span className="avatar small">{initials(data.user.displayName)}</span>
                {!sidebarCompact && <span className="profile-label"><b>{data.user.displayName}</b><small>{data.user.email}</small></span>}
                {!sidebarCompact && <ChevronDown size={13} className={`profile-chevron ${accountMenuOpen ? "open" : ""}`} />}
              </button>
              <a className="profile-logout" href={signOutPath} title="Sign out" aria-label="Sign out">
                <LogOut size={14} />
              </a>
            </div>
          </div>
        </div>
      </aside>

      <section className="main-surface">
        <header className="surface-header">
          <div className="title-row">
            <div className="title-cluster">
              <button
                className="icon-button desktop-sidebar-toggle"
                type="button"
                aria-controls="workspace-sidebar"
                aria-expanded={!sidebarCollapsed}
                aria-label={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
                onClick={() => setSidebarCollapsed((value) => !value)}
                title="Toggle navigation"
              >
                {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              </button>
              <button
                ref={mobileMenuRef}
                className="icon-button mobile-menu"
                type="button"
                aria-controls="workspace-sidebar"
                aria-expanded={mobileSidebarOpen}
                aria-label={mobileSidebarOpen ? "Close navigation" : "Open navigation"}
                onClick={() => {
                  if (mobileSidebarOpen) closeMobileSidebar();
                  else setMobileSidebarOpen(true);
                  setMobileActionsOpen(false);
                }}
                title="Toggle navigation"
              >
                {mobileSidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
              </button>
              <nav className="breadcrumbs" aria-label="Breadcrumb">
                {breadcrumbs.map((item, index) => {
                  const current = index === breadcrumbs.length - 1;
                  const targetSurface = item.surface;
                  return (
                    <div className="breadcrumb-step" key={`${item.label}:${index}`} aria-current={current ? "page" : undefined}>
                      {index > 0 && <ChevronRight size={12} className="breadcrumb-chevron" aria-hidden="true" />}
                      {current || !targetSurface ? (
                        <h1 className="breadcrumb-current" title={item.label}>{item.label}</h1>
                      ) : (
                        <a
                          className="breadcrumb-link"
                          href={navigationPath({ surface: targetSurface, layout: item.layout ?? "list", taskId: null }, data)}
                          onClick={(event) => handleLocalLink(event, () => navigateSurface(targetSurface, item.layout))}
                        >
                          {item.label}
                        </a>
                      )}
                    </div>
                  );
                })}
              </nav>
              <span className="count-pill">{surfaceCount}</span>
            </div>
            <div className="title-actions">
              {surface === "admin" && data.admin && <button className="button ghost" disabled={systemBackupBusy} onClick={() => void downloadSystemBackup()}><Download size={14} />{systemBackupBusy ? "Exporting…" : "Export"}</button>}
              {surface === "admin" && data.admin && <button className="button ghost danger" disabled={systemBackupBusy} onClick={() => setDialog("systemImport")}><Upload size={14} />Import</button>}
              {surface.startsWith("project:") && contextProjectRecord && <a className="button ghost" href={projectReleasesPath(contextProjectRecord.publicId)} onClick={(event) => handleLocalLink(event, () => navigateSurface(`project-releases:${contextProjectRecord.id}`, "list"))}><Rocket size={14} />Releases</a>}
              {surface.startsWith("project:") && contextProjectRecord?.accessRole === "owner" && <button className="button ghost" disabled={systemBackupBusy} onClick={() => void downloadProjectBackup(contextProjectRecord)}><Download size={14} />{systemBackupBusy ? "Exporting…" : "Backup"}</button>}
              {currentShareTarget && <button className="button ghost" onClick={() => setDialog("share")}><Share2 size={14} />Members &amp; access</button>}
              <button className="icon-button" title="Copy direct link" onClick={() => void copyCurrentLink()}><Link2 size={16} /></button>
            </div>
          </div>
          {!isCollectionSurface(surface) && (
            <div className="toolbar-row">
              <div className="toolbar-left">
                <div className="desktop-view-controls">
                  <div className="search-control">
                    <Search size={13} />
                    <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tasks…" aria-label="Search tasks" />
                    {search && <button onClick={() => setSearch("")}><X size={12} /></button>}
                  </div>
                  <div className="popover-anchor">
                    <button className={`button ghost ${filterOpen ? "active" : ""}`} onClick={() => setFilterOpen((value) => !value)}><ListFilter size={14} />Filter{(priorityFilter !== "all" || statusFilter !== "all") && <span className="filter-count">{Number(priorityFilter !== "all") + Number(statusFilter !== "all")}</span>}</button>
                    {filterOpen && <FilterPopover statuses={data.statuses} priority={priorityFilter} status={statusFilter} onPriority={setPriorityFilter} onStatus={setStatusFilter} onClose={() => setFilterOpen(false)} />}
                  </div>
                  <div className="segmented" aria-label="Layout">
                    <button className={layout === "list" ? "active" : ""} onClick={() => changeLayout("list")} title="List"><LayoutList size={14} /></button>
                    <button className={layout === "board" ? "active" : ""} onClick={() => changeLayout("board")} title="Board"><Columns3 size={14} /></button>
                  </div>
                  <div className="popover-anchor display-anchor">
                    <button className={`button ghost ${displayOpen ? "active" : ""}`} onClick={() => setDisplayOpen((value) => !value)}><SlidersHorizontal size={14} />Display</button>
                    {displayOpen && <DisplayPopover layout={layout} groupBy={currentGroupBy} orderBy={activeSavedView?.display.orderBy ?? "manual"} onLayout={changeLayout} onGroupBy={changeGroupBy} onClose={() => setDisplayOpen(false)} />}
                  </div>
                  {hasViewChanges && canSaveView && <button className="button ghost save-view" onClick={() => setDialog("view")}><Save size={13} />Save view</button>}
                </div>
                <div className="segmented mobile-layout-switcher" role="group" aria-label="Layout">
                  <button type="button" className={layout === "list" ? "active" : ""} aria-label="List view" aria-pressed={layout === "list"} onClick={() => changeLayout("list")}><LayoutList size={16} /></button>
                  <button type="button" className={layout === "board" ? "active" : ""} aria-label="Kanban view" aria-pressed={layout === "board"} onClick={() => changeLayout("board")}><Columns3 size={16} /></button>
                </div>
                <div className="mobile-view-controls-anchor" ref={mobileActionsRef}>
                  <button
                    className={`icon-button mobile-view-controls-trigger ${mobileActionsOpen ? "active" : ""}`}
                    type="button"
                    aria-controls="mobile-view-controls"
                    aria-expanded={mobileActionsOpen}
                    aria-haspopup="dialog"
                    aria-label="Open view controls"
                    onClick={() => {
                      setMobileActionsOpen((value) => !value);
                      setMobileSidebarOpen(false);
                    }}
                  >
                    <SlidersHorizontal size={17} />
                    {(priorityFilter !== "all" || statusFilter !== "all") && <span className="filter-count">{Number(priorityFilter !== "all") + Number(statusFilter !== "all")}</span>}
                  </button>
                  <div
                    className="mobile-view-controls"
                    id="mobile-view-controls"
                    role="dialog"
                    aria-modal="false"
                    aria-label="View controls"
                    hidden={!mobileActionsOpen}
                  >
                    <header>
                      <b>View controls</b>
                      <button type="button" className="icon-button" aria-label="Close view controls" onClick={() => setMobileActionsOpen(false)}><X size={15} /></button>
                    </header>
                    <label className="mobile-search-control">
                      <Search size={15} />
                      <input ref={mobileSearchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tasks…" aria-label="Search tasks on mobile" />
                      {search && <button type="button" aria-label="Clear search" onClick={() => setSearch("")}><X size={13} /></button>}
                    </label>
                    <section className="mobile-control-section">
                      <h3>Filter</h3>
                      <label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">Any status</option>{data.statuses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                      <label><span>Priority</span><select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as Priority | "all")}><option value="all">Any priority</option>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select></label>
                    </section>
                    <section className="mobile-control-section">
                      <h3>Display</h3>
                      <div className="segmented wide" aria-label="Mobile layout">
                        <button className={layout === "list" ? "active" : ""} onClick={() => changeLayout("list")}><LayoutList size={14} />List</button>
                        <button className={layout === "board" ? "active" : ""} onClick={() => changeLayout("board")}><Columns3 size={14} />Board</button>
                      </div>
                      <label className="mobile-display-summary"><span>Group by</span><select value={currentGroupBy} onChange={(event) => changeGroupBy(event.target.value as ViewDisplay["groupBy"])}>{groupByOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                      <div className="mobile-display-summary"><span>Order</span><b>{displayLabel(activeSavedView?.display.orderBy ?? "manual")}</b></div>
                    </section>
                    <div className="mobile-controls-footer">
                      <button className="button ghost" type="button" onClick={() => { setPriorityFilter("all"); setStatusFilter("all"); }}>Clear filters</button>
                      {hasViewChanges && canSaveView && <button className="button secondary" type="button" onClick={() => { setMobileActionsOpen(false); setDialog("view"); }}><Save size={14} />Save view</button>}
                    </div>
                  </div>
                </div>
              </div>
              {canCreateTask && <button className="button primary" onClick={() => openCreate()}><Plus size={14} />New task</button>}
            </div>
          )}
        </header>

        {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")}><X size={14} /></button></div>}
        {data.taskWindow?.truncated && !taskWindowLoading && !searchNeedle && <div className="snapshot-warning" role="status">Showing the {data.taskWindow.limit.toLocaleString()} most recently updated tasks. Narrow the workspace with a saved view or use the Agent API for the full collection.</div>}
        {(busy || taskWindowLoading) && <div className="progress-line" aria-label={busy ? "Saving" : "Loading remaining tasks"} />}

        {surface === "workspace" ? (
          <WorkspaceOverviewSurface
            data={data}
            statusMap={statusMap}
            projectMap={projectMap}
            onOpen={(nextSurface, nextLayout = "list") => navigateSurface(nextSurface, nextLayout)}
            onOpenTask={openTask}
            onCreateTask={() => openCreate()}
            onCreateProject={() => setDialog("project")}
            onCreateRelease={() => setDialog("release")}
          />
        ) : surface === "admin" && data.admin ? (
          <AdminSurface overview={data.admin} timeZone={data.user.timezone} />
        ) : surface === "views" ? (
          <ViewsSurface data={data} statusMap={statusMap} onOpen={(nextSurface, nextLayout) => navigateSurface(nextSurface, nextLayout)} />
        ) : surface === "projects" ? (
          <ProjectsSurface projects={data.projects} tasks={data.tasks} statuses={data.statuses} onOpen={(id) => navigateSurface(`project:${id}`, "list")} onCreate={() => setDialog("project")} />
        ) : surface === "releases" || projectReleaseSurfaceId ? (
          <ReleasesSurface releases={scopedReleases} projects={projectMap} tasks={data.tasks} statuses={data.statuses} onOpen={(id) => navigateSurface(`release:${id}`, "list")} onCreate={() => canCreateTask && setDialog("release")} />
        ) : taskSearchStatus ? (
          <TaskSearchNotice status={taskSearchStatus} />
        ) : layout === "board" ? (
          <TaskBoard tasks={visibleTasks} groups={taskGroups} groupBy={currentGroupBy} statuses={statusMap} projects={projectMap} releases={releaseMap} users={userMap} selected={selected} canCreate={canCreateTask} createOwnerUserId={contextProjectRecord?.ownerUserId ?? data.user.id} createAssigneeUserIds={createAssigneeUserIds} onSelect={toggleSelection} onOpen={openTask} onCreate={(defaults) => openCreate(defaults)} onMove={moveTaskToGroup} onDragState={setDraggingTaskId} />
        ) : (
          <TaskList tasks={visibleTasks} groups={taskGroups} statuses={statusMap} groupBy={currentGroupBy} projects={projectMap} releases={releaseMap} users={userMap} selected={selected} highlighted={highlighted} collapsed={collapsedGroups} canCreate={canCreateTask} createOwnerUserId={contextProjectRecord?.ownerUserId ?? data.user.id} createAssigneeUserIds={createAssigneeUserIds} pullRefreshing={pullRefreshing} pullRefreshError={pullRefreshError} pullRefreshDisabled={busy || taskWindowLoading} onRefresh={refreshTaskList} onToggleGroup={(id) => setCollapsedGroups((current) => toggleSet(current, id))} onSelect={toggleSelection} onHighlight={setHighlighted} onOpen={openTask} onCreate={(defaults) => openCreate(defaults)} onMove={moveTaskToGroup} onDragState={setDraggingTaskId} />
        )}
      </section>

      {selected.size > 0 && (
        <BulkBar count={selected.size} statuses={statusGroupsForTasks(selectedTasks, data.statuses)} archiveAction={archiveAction} onStatus={(value) => mutate("/api/tasks/bulk", "POST", { ids: [...selected], field: "statusId", value }).then((ok) => ok && setSelected(new Set()))} onPriority={(value) => mutate("/api/tasks/bulk", "POST", { ids: [...selected], field: "priority", value }).then((ok) => ok && setSelected(new Set()))} onArchive={() => mutate("/api/tasks/bulk", "POST", { ids: [...selected], field: "archived", value: archiveAction.archived }).then((ok) => ok && setSelected(new Set()))} onClose={() => setSelected(new Set())} />
      )}

      {activeTask && <div className={currentShareTarget ? undefined : "details-no-share"}>{activeTask.description === null ? <TaskDetailsLoading task={activeTask} onClose={closeTask} /> : <TaskDetails key={activeTask.id} task={activeTask} data={activeDetailsData} onClose={closeTask} onOpenTask={openTask} onSave={async (changes) => mutate(`/api/tasks/${activeTask.id}`, "PATCH", { version: taskMutationVersion(activeTask), ...changes })} onRebase={refreshTaskDetail} onShare={() => setDialog("share")} busy={busy} />}</div>}
      {peekTask && <Peek task={peekTask} status={statusMap.get(peekTask.statusId)} project={peekTask.projectId ? projectMap.get(peekTask.projectId) : undefined} onClose={() => setPeekTaskId(null)} onOpen={() => { openTask(peekTask.id); setPeekTaskId(null); }} />}
      {dialog === "task" && canCreateTask && <TaskComposer data={data} contextProject={contextProject} contextRelease={contextRelease} defaults={createDefaults} onClose={() => setDialog(null)} onSubmit={createTaskForComposer} busy={busy} />}
      {dialog === "project" && <ProjectDialog onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/projects", "POST", input); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "release" && <ReleaseDialog projects={data.projects.filter((project) => canEditContent(project.accessRole))} initialProjectId={contextProject} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/releases", "POST", input); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "view" && canSaveView && <ViewDialog search={search} status={statusFilter} priority={priorityFilter} layout={layout} groupBy={currentGroupBy} scopeProjectId={contextProject} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/views", "POST", input); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "share" && <ShareDialog target={currentShareTarget} currentUser={data.user} users={data.users} collaborators={data.collaborators} onClose={() => setDialog(null)} onShare={(input) => mutate("/api/shares", "POST", input)} onRoleChange={(grantId, permission) => mutate("/api/shares", "PATCH", { grantId, permission })} onRevoke={(grantId) => mutate("/api/shares", "DELETE", { grantId })} onTransfer={(projectId, targetUserId) => mutate("/api/shares/transfer", "POST", { projectId, targetUserId })} busy={busy} />}
      {dialog === "systemImport" && <SystemImportDialog onClose={() => setDialog(null)} onDownloadCurrent={downloadSystemBackup} onBusyChange={setSystemBackupBusy} onApplied={() => window.location.assign("/admin")} />}
      {dialog === "codexSetup" && <CodexSetupDialog onClose={() => setDialog(null)} />}
      {dialog === "workflowSettings" && <WorkflowSettingsDialog initialStatuses={data.statuses.filter((status) => status.ownerUserId === data.user.id)} onClose={() => setDialog(null)} onStatuses={(statuses) => setData((current) => ({ ...current, statuses: [...current.statuses.filter((status) => status.ownerUserId !== current.user.id), ...statuses] }))} />}
    </main>
  );
}

function NavItem({ compact, icon, label, active, href, onNavigate, count }: { compact: boolean; icon: React.ReactNode; label: string; active: boolean; href: string; onNavigate: () => void; count?: number }) {
  return <a className={`nav-item ${active ? "active" : ""}`} href={href} aria-current={active ? "page" : undefined} aria-label={label} onClick={(event) => handleLocalLink(event, onNavigate)} title={label}><span className="nav-icon">{icon}</span>{!compact && <><span className="nav-label">{label}</span>{count !== undefined && <small className="nav-count">{count}</small>}</>}</a>;
}

function SidebarSection({ title, action, children }: { title: string; action: () => void; children: React.ReactNode }) {
  return <section className="sidebar-section"><div className="section-label"><span>{title}</span><button onClick={action} title={`Add ${title.toLowerCase()}`}><Plus size={12} /></button></div>{children}</section>;
}

function TaskList({ tasks, groups, statuses, groupBy, projects, releases, users, selected, highlighted, collapsed, canCreate, createOwnerUserId, createAssigneeUserIds, pullRefreshing, pullRefreshError, pullRefreshDisabled, onRefresh, onToggleGroup, onSelect, onHighlight, onOpen, onCreate, onMove, onDragState }: { tasks: TaskRecord[]; groups: TaskGroup[]; statuses: Map<string, WorkflowStatusRecord>; groupBy: ViewDisplay["groupBy"]; projects: Map<string, ProjectRecord>; releases: Map<string, ReleaseRecord>; users: Map<string, UserRecord>; selected: Set<string>; highlighted: number; collapsed: Set<string>; canCreate: boolean; createOwnerUserId: string; createAssigneeUserIds: ReadonlySet<string>; pullRefreshing: boolean; pullRefreshError: string; pullRefreshDisabled: boolean; onRefresh: () => Promise<AppSnapshot>; onToggleGroup: (id: string) => void; onSelect: (id: string) => void; onHighlight: (index: number) => void; onOpen: (id: string) => void; onCreate: (defaults?: TaskCreateDefaults) => void; onMove: (task: TaskRecord, group: TaskGroup, rank: number) => Promise<unknown>; onDragState: (taskId: string | null) => void }) {
  const [over, setOver] = useState<string | null>(null);
  const pullListRef = useRef<HTMLDivElement>(null);
  const pullStart = useRef<{ y: number; active: boolean } | null>(null);
  const pullDistanceRef = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  let content: React.ReactNode;

  function updatePullDistance(distance: number) {
    pullDistanceRef.current = distance;
    setPullDistance(distance);
  }

  function handlePullStart(event: ReactTouchEvent<HTMLDivElement>) {
    const mobile = window.matchMedia("(max-width: 900px)").matches;
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    const active = canStartPullRefresh({
      mobile,
      coarsePointer,
      scrollTop: pullListRef.current?.scrollTop ?? 0,
      refreshing: pullRefreshing || pullRefreshDisabled,
      touchCount: event.touches.length,
    }) && !hasNestedScrollContainer(event.target, pullListRef.current);
    pullStart.current = active ? { y: event.touches[0].clientY, active } : null;
  }

  function handlePullMove(event: ReactTouchEvent<HTMLDivElement>) {
    if (!pullStart.current?.active || event.touches.length !== 1) return;
    const distance = pullRefreshDistance(
      event.touches[0].clientY - pullStart.current.y,
    );
    if (distance > 0) event.preventDefault();
    updatePullDistance(distance);
  }

  function finishPull() {
    const shouldRefresh = pullStart.current?.active
      && shouldTriggerPullRefresh(pullDistanceRef.current)
      && !pullRefreshing
      && !pullRefreshDisabled;
    pullStart.current = null;
    if (shouldRefresh) {
      updatePullDistance(52);
      void onRefresh().finally(() => updatePullDistance(0)).catch(() => undefined);
    } else if (!pullRefreshing && !pullRefreshError) {
      updatePullDistance(0);
    }
  }

  if (!tasks.length) {
    content = <EmptyState onCreate={canCreate ? () => onCreate() : undefined} />;
  } else if (groupBy === "none") {
    content = tasks.map((task, index) => {
      const status = statuses.get(task.statusId);
      return status ? <TaskRow key={task.id} task={task} status={status} project={task.projectId ? projects.get(task.projectId) : undefined} release={task.releaseId ? releases.get(task.releaseId) : undefined} assignee={task.assigneeUserId ? users.get(task.assigneeUserId) : undefined} selected={selected.has(task.id)} highlighted={highlighted === index} canDrag={false} onSelect={() => onSelect(task.id)} onHighlight={() => onHighlight(index)} onOpen={() => onOpen(task.id)} onDragState={onDragState} /> : null;
    });
  } else {
    let flatIndex = -1;
    content = groups.map((group) => {
      const isCollapsed = collapsed.has(group.id);
      const groupCanCreate = canCreateInTaskGroup(group, canCreate, createOwnerUserId, createAssigneeUserIds);
      return <section
        className={`task-group ${over === group.id ? "drag-over" : ""}`}
        data-drop-target={group.kind}
        key={group.id}
        onDragOver={(event) => {
          if (group.kind !== "status") return;
          event.preventDefault();
          setOver(group.id);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
        }}
        onDrop={(event) => {
          if (group.kind !== "status") return;
          event.preventDefault();
          const id = event.dataTransfer.getData("text/task-id");
          const task = tasks.find((item) => item.id === id);
          setOver(null);
          onDragState(null);
          if (task && canMoveTaskToGroup(task, group) && !taskMatchesGroup(task, group)) {
            const lastRank = group.tasks.at(-1)?.rank ?? 0;
            void onMove(task, group, lastRank + 1000);
          }
        }}
      ><div className="group-header"><button className="group-title" onClick={() => onToggleGroup(group.id)}><ChevronDown size={13} className={isCollapsed ? "rotated" : ""} /><TaskGroupIcon group={group} /><span>{group.label}</span><small>{group.tasks.length}</small></button>{groupCanCreate && <button className="icon-button quiet" onClick={() => onCreate(taskGroupCreateDefaults(group) as TaskCreateDefaults)} title={`Add to ${group.label}`}><Plus size={13} /></button>}</div>{!isCollapsed && group.tasks.map((task) => { flatIndex += 1; const index = flatIndex; const status = statuses.get(task.statusId); return status ? <TaskRow key={task.id} task={task} status={status} project={task.projectId ? projects.get(task.projectId) : undefined} release={task.releaseId ? releases.get(task.releaseId) : undefined} assignee={task.assigneeUserId ? users.get(task.assigneeUserId) : undefined} selected={selected.has(task.id)} highlighted={highlighted === index} canDrag={group.kind === "status"} onSelect={() => onSelect(task.id)} onHighlight={() => onHighlight(index)} onOpen={() => onOpen(task.id)} onDragState={onDragState} /> : null; })}</section>;
    });
  }

  return <div
    ref={pullListRef}
    className={`task-list ${groupBy === "none" ? "ungrouped" : ""}`}
    onTouchStart={handlePullStart}
    onTouchMove={handlePullMove}
    onTouchEnd={finishPull}
    onTouchCancel={finishPull}
  >
    <PullRefreshIndicator
      distance={pullDistance}
      refreshing={pullRefreshing}
      error={pullRefreshError}
      onRetry={() => void onRefresh().catch(() => undefined)}
    />
    {content}
  </div>;
}

function hasNestedScrollContainer(target: EventTarget, boundary: HTMLElement | null) {
  let element = target instanceof HTMLElement ? target : null;
  while (element && element !== boundary) {
    const overflowY = window.getComputedStyle(element).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll")
      && element.scrollHeight > element.clientHeight) {
      return true;
    }
    element = element.parentElement;
  }
  return false;
}

function PullRefreshIndicator({ distance, refreshing, error, onRetry }: {
  distance: number;
  refreshing: boolean;
  error: string;
  onRetry: () => void;
}) {
  const height = refreshing || error ? 52 : distance;
  const ready = shouldTriggerPullRefresh(distance);
  return <div
    className="pull-refresh-indicator"
    role={error ? "alert" : "status"}
    style={{ height }}
  >
    {error ? <><span>{error}</span><button type="button" onClick={onRetry}>Retry</button></> : <><span className={`pull-refresh-spinner ${refreshing ? "refreshing" : ""}`} aria-hidden="true" /><span>{refreshing ? "Refreshing…" : ready ? "Release to refresh" : "Pull to refresh"}</span></>}
  </div>;
}

function TaskRow({ task, status, project, release, assignee, selected, highlighted, canDrag, onSelect, onHighlight, onOpen, onDragState }: { task: TaskRecord; status: WorkflowStatusRecord; project?: ProjectRecord; release?: ReleaseRecord; assignee?: UserRecord; selected: boolean; highlighted: boolean; canDrag: boolean; onSelect: () => void; onHighlight: () => void; onOpen: () => void; onDragState: (taskId: string | null) => void }) {
  const editable = canEditContent(task.accessRole);
  const draggable = editable && canDrag;
  return <div className={`task-row ${selected ? "selected" : ""} ${highlighted ? "highlighted" : ""}`} draggable={draggable} onDragStart={(event) => { if (!draggable) return; event.dataTransfer.setData("text/task-id", task.id); event.dataTransfer.effectAllowed = "move"; onDragState(task.id); }} onDragEnd={() => onDragState(null)} onMouseEnter={onHighlight}>{editable ? <button className={`row-check ${selected ? "checked" : ""}`} onClick={(event) => { event.stopPropagation(); onSelect(); }} aria-label={selected ? "Deselect task" : "Select task"}>{selected ? <Check size={12} /> : <span />}</button> : <span className="row-check-spacer" />}<PriorityIcon priority={task.priority} /><a className="task-identity" href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, onOpen)}>{task.identifier}</a><a className="task-title" href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, onOpen)} title={task.title}>{task.title}</a><div className="row-metadata">{project && <span className="metadata-chip" title={project.name}><span className="project-dot" style={{ background: project.color }} />{project.name}</span>}{release && <span className="metadata-chip" title={release.name}><Rocket size={12} />{release.name}</span>}{task.dueDate && <span className={`metadata-chip ${isOverdue(task.dueDate, status.category) ? "overdue" : ""}`}><CalendarDays size={12} />{shortDate(task.dueDate)}</span>}{assignee && <span className="avatar" title={assignee.displayName}>{initials(assignee.displayName)}</span>}{editable && <button className="row-more" type="button" aria-label="Open task details" title="Open task details" onClick={(event) => { event.stopPropagation(); onOpen(); }}><MoreHorizontal size={14} /></button>}</div></div>;
}

function TaskBoard({ tasks, groups, groupBy, statuses, projects, releases, users, selected, canCreate, createOwnerUserId, createAssigneeUserIds, onSelect, onOpen, onCreate, onMove, onDragState }: { tasks: TaskRecord[]; groups: TaskGroup[]; groupBy: ViewDisplay["groupBy"]; statuses: Map<string, WorkflowStatusRecord>; projects: Map<string, ProjectRecord>; releases: Map<string, ReleaseRecord>; users: Map<string, UserRecord>; selected: Set<string>; canCreate: boolean; createOwnerUserId: string; createAssigneeUserIds: ReadonlySet<string>; onSelect: (id: string) => void; onOpen: (id: string) => void; onCreate: (defaults?: TaskCreateDefaults) => void; onMove: (task: TaskRecord, group: TaskGroup, rank: number) => Promise<unknown>; onDragState: (taskId: string | null) => void }) {
  const [over, setOver] = useState<string | null>(null);
  if (!tasks.length) return <EmptyState onCreate={canCreate ? () => onCreate() : undefined} />;
  if (groupBy === "none") {
    return <div className="board"><section className="board-column"><div className="column-header"><div><LayoutList size={14} /><span>Tasks</span><small>{tasks.length}</small></div>{canCreate && <button className="icon-button quiet" onClick={() => onCreate()}><Plus size={13} /></button>}</div><div className="column-cards">{tasks.map((task) => <TaskBoardCard key={task.id} task={task} status={statuses.get(task.statusId)} project={task.projectId ? projects.get(task.projectId) : undefined} release={task.releaseId ? releases.get(task.releaseId) : undefined} assignee={task.assigneeUserId ? users.get(task.assigneeUserId) : undefined} showStatus showAssignee selected={selected.has(task.id)} onSelect={() => onSelect(task.id)} onOpen={() => onOpen(task.id)} onDragState={onDragState} />)}</div>{canCreate && <button className="add-card" onClick={() => onCreate()}><Plus size={13} />Add task</button>}</section></div>;
  }
  return (
    <div className="board">
      {groups.map((group) => {
        const groupCanCreate = canCreateInTaskGroup(group, canCreate, createOwnerUserId, createAssigneeUserIds);
        return (
          <section
            key={group.id}
            className={`board-column ${over === group.id ? "drag-over" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(group.id);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData("text/task-id");
              const task = tasks.find((item) => item.id === id);
              setOver(null);
              onDragState(null);
              if (task && canMoveTaskToGroup(task, group) && !taskMatchesGroup(task, group)) {
                const lastRank = group.tasks.at(-1)?.rank ?? 0;
                void onMove(task, group, lastRank + 1000);
              }
            }}
          >
            <div className="column-header">
              <div>
                <TaskGroupIcon group={group} />
                <span>{group.label}</span>
                <small>{group.tasks.length}</small>
              </div>
              {groupCanCreate && <button className="icon-button quiet" onClick={() => onCreate(taskGroupCreateDefaults(group) as TaskCreateDefaults)}>
                <Plus size={13} />
              </button>}
            </div>
            <div className="column-cards">
              {group.tasks.map((task) => <TaskBoardCard key={task.id} task={task} status={statuses.get(task.statusId)} project={task.projectId ? projects.get(task.projectId) : undefined} release={task.releaseId ? releases.get(task.releaseId) : undefined} assignee={task.assigneeUserId ? users.get(task.assigneeUserId) : undefined} showStatus={group.kind !== "status"} showAssignee={group.kind !== "assignee"} selected={selected.has(task.id)} onSelect={() => onSelect(task.id)} onOpen={() => onOpen(task.id)} onDragState={onDragState} />)}
            </div>
            {groupCanCreate && <button className="add-card" onClick={() => onCreate(taskGroupCreateDefaults(group) as TaskCreateDefaults)}>
              <Plus size={13} />Add task
            </button>}
          </section>
        );
      })}
    </div>
  );
}

function TaskBoardCard({ task, status, project, release, assignee, showStatus, showAssignee, selected, onSelect, onOpen, onDragState }: { task: TaskRecord; status?: WorkflowStatusRecord; project?: ProjectRecord; release?: ReleaseRecord; assignee?: UserRecord; showStatus: boolean; showAssignee: boolean; selected: boolean; onSelect: () => void; onOpen: () => void; onDragState: (taskId: string | null) => void }) {
  const editable = canEditContent(task.accessRole);
  return <div role="button" tabIndex={0} className={`task-card ${editable ? "editable" : ""} ${selected ? "selected" : ""}`} draggable={editable} onDragStart={(event) => { event.dataTransfer.setData("text/task-id", task.id); event.dataTransfer.effectAllowed = "move"; onDragState(task.id); }} onDragEnd={() => onDragState(null)} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }}>{editable && <button className={`card-check ${selected ? "checked" : ""}`} onClick={(event) => { event.stopPropagation(); onSelect(); }} aria-label={selected ? "Deselect task" : "Select task"}>{selected ? <Check size={11} /> : <span />}</button>}<a href={taskPath(task.publicId)} onClick={(event) => { event.stopPropagation(); handleLocalLink(event, onOpen); }}><h3>{task.title}</h3><div className="card-meta"><span className="card-identifier">{task.identifier}</span><PriorityIcon priority={task.priority} />{showStatus && status && <span className="metadata-chip"><StatusIcon status={status} />{status.name}</span>}{project && <span className="metadata-chip"><span className="project-dot" style={{ background: project.color }} />{project.name}</span>}{release && <span className="metadata-chip"><Rocket size={12} />{release.name}</span>}{showAssignee && assignee && <span className="avatar" title={assignee.displayName}>{initials(assignee.displayName)}</span>}</div></a></div>;
}

function TaskGroupIcon({ group }: { group: TaskGroup }) {
  if (group.status) return <StatusIcon status={group.status} />;
  if (group.priority) return <PriorityIcon priority={group.priority} />;
  if (group.assignee) return <span className="avatar group-avatar" title={group.assignee.displayName}>{initials(group.assignee.displayName)}</span>;
  if (group.project) return <span className="project-dot" style={{ background: group.project.color }} />;
  if (group.release) return <Rocket size={13} />;
  return <Circle size={11} />;
}

function canCreateInTaskGroup(
  group: TaskGroup,
  canCreate: boolean,
  ownerUserId: string,
  createAssigneeUserIds: ReadonlySet<string>,
) {
  if (!canCreate) return false;
  if (group.status) return group.status.ownerUserId === ownerUserId;
  if (group.kind === "assignee") {
    return group.value === null || createAssigneeUserIds.has(group.value);
  }
  if (group.project) return canEditContent(group.project.accessRole);
  if (group.release) return canEditContent(group.release.accessRole);
  return true;
}

function taskAssigneeOptions(
  data: AppSnapshot,
  projectId: string | null,
  taskId?: string,
): UserRecord[] {
  const userById = new Map([...data.users, data.user].map((user) => [user.id, user]));
  const ids = new Set<string>();
  if (projectId) {
    const project = data.projects.find((item) => item.id === projectId);
    if (project) ids.add(project.ownerUserId);
    ids.add(data.user.id);
    for (const collaborator of data.collaborators) {
      if (
        collaborator.resourceType === "project" &&
        collaborator.resourceId === projectId
      ) {
        ids.add(collaborator.userId);
      }
    }
  } else if (taskId) {
    const task = data.tasks.find((item) => item.id === taskId);
    if (task) ids.add(task.ownerUserId);
    ids.add(data.user.id);
    for (const collaborator of data.collaborators) {
      if (
        collaborator.resourceType === "task" &&
        collaborator.resourceId === taskId
      ) {
        ids.add(collaborator.userId);
      }
    }
  } else {
    ids.add(data.user.id);
  }
  return [...ids]
    .map((id) => userById.get(id))
    .filter((user): user is UserRecord => user !== undefined)
    .sort((left, right) =>
      left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id),
    );
}

function StatusIcon({ status }: { status: WorkflowStatusRecord }) {
  return <span className={`status-icon status-${status.category}`} style={{ "--status-color": status.color } as React.CSSProperties}>{status.category === "completed" && <Check size={9} />}</span>;
}

type ComposerAttachment = {
  id: string;
  key: string;
  file: File;
  progress: number;
  status: "queued" | "uploading" | "failed" | "canceled" | "complete";
  error: string | null;
};

function TaskComposer({ data, contextProject, contextRelease, defaults, onClose, onSubmit, busy }: { data: AppSnapshot; contextProject: string | null; contextRelease: string | null; defaults: TaskCreateDefaults; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<TaskRecord | null>; busy: boolean }) {
  const editableProjects = data.projects.filter((project) => canEditContent(project.accessRole));
  const initialReleaseId = defaults.releaseId !== undefined
    ? defaults.releaseId ?? ""
    : contextRelease ?? "";
  const releaseProjectId = initialReleaseId
    ? data.releases.find((release) => release.id === initialReleaseId)?.projectId
    : undefined;
  const initialProjectId = defaults.projectId !== undefined
    ? defaults.projectId ?? ""
    : contextProject ?? releaseProjectId ?? "";
  const [projectId, setProjectId] = useState(initialProjectId);
  const ownerId = data.projects.find((project) => project.id === projectId)?.ownerUserId ?? data.user.id;
  const statuses = data.statuses.filter(
    (status) => status.ownerUserId === ownerId && !status.archivedAt,
  );
  const [statusId, setStatusId] = useState(defaults.statusId && statuses.some((status) => status.id === defaults.statusId) ? defaults.statusId : statuses.find((status) => status.isDefault)?.id ?? statuses[0]?.id ?? "");
  const [releaseId, setReleaseId] = useState(initialReleaseId);
  const [priority, setPriority] = useState<Priority>(defaults.priority ?? "none");
  const [assigneeUserId, setAssigneeUserId] = useState(
    defaults.assigneeUserId !== undefined
      ? defaults.assigneeUserId ?? ""
      : data.user.id,
  );
  const assignees = taskAssigneeOptions(data, projectId || null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [createdTask, setCreatedTask] = useState<TaskRecord | null>(null);
  const [composerError, setComposerError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeUploads = useRef(new Map<string, () => void>());

  useEffect(() => () => {
    for (const cancel of activeUploads.current.values()) cancel();
    activeUploads.current.clear();
  }, []);

  function patchAttachment(id: string, patch: Partial<ComposerAttachment>) {
    setAttachments((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function addFiles(files: FileList | File[]) {
    const additions = Array.from(files).map((file) => ({
      id: crypto.randomUUID(),
      key: `task-composer-attachment:${crypto.randomUUID()}`,
      file,
      progress: 0,
      status: "queued" as const,
      error: null,
    }));
    setAttachments((current) => [...current, ...additions]);
  }

  async function uploadOne(task: TaskRecord, attachment: ComposerAttachment) {
    patchAttachment(attachment.id, { status: "uploading", progress: 0, error: null });
    const running = startTaskAttachmentUpload(
      task.id,
      attachment.file,
      attachment.key,
      (progress) => patchAttachment(attachment.id, { progress }),
    );
    activeUploads.current.set(attachment.id, running.cancel);
    try {
      await running.promise;
      patchAttachment(attachment.id, { status: "complete", progress: 100, error: null });
      return true;
    } catch (requestError) {
      const canceled = requestError instanceof DOMException && requestError.name === "AbortError";
      patchAttachment(attachment.id, {
        status: canceled ? "canceled" : "failed",
        error: canceled
          ? "Upload canceled"
          : requestError instanceof Error
            ? requestError.message
            : "Upload failed",
      });
      return false;
    } finally {
      activeUploads.current.delete(attachment.id);
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!title.trim() || !projectId || busy) return;
    setComposerError("");
    const task = createdTask ?? await onSubmit({
      title,
      description,
      projectId,
      releaseId: releaseId || null,
      statusId,
      priority,
      assigneeUserId: assigneeUserId || null,
    });
    if (!task) {
      setComposerError("Task was not created. No files were uploaded.");
      return;
    }
    setCreatedTask(task);
    const pending = attachments.filter((item) => item.status !== "complete");
    let failed = 0;
    for (const attachment of pending) {
      if (!(await uploadOne(task, attachment))) failed += 1;
    }
    if (failed === 0) onClose();
    else setComposerError(`${task.identifier} was created, but ${failed} file${failed === 1 ? "" : "s"} still need retry.`);
  }

  function closeComposer() {
    for (const cancel of activeUploads.current.values()) cancel();
    onClose();
  }

  const pendingCount = attachments.filter((item) => item.status !== "complete").length;
  return <Modal onClose={closeComposer} className="composer-modal"><form onSubmit={submit}><div className="modal-title-row"><span className="muted">{createdTask ? `${createdTask.identifier} created` : "New task"}</span><button type="button" className="icon-button" onClick={closeComposer}><X size={15} /></button></div><fieldset className="composer-fields" disabled={Boolean(createdTask)}><input className="composer-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Task title" autoFocus /><textarea className="composer-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Add description…" rows={4} onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit(); }} /><div className="property-bar"><PropertySelect icon={<CircleDot size={13} />} value={statusId} onChange={setStatusId}>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</PropertySelect><PropertySelect icon={<ArrowDownWideNarrow size={13} />} value={priority} onChange={(value) => setPriority(value as Priority)}>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</PropertySelect><PropertySelect icon={<UsersRound size={13} />} value={assigneeUserId} onChange={setAssigneeUserId}><option value="">No assignee</option>{assignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.displayName}</option>)}</PropertySelect><PropertySelect icon={<FolderKanban size={13} />} value={projectId} onChange={(value) => { setProjectId(value); setReleaseId(""); const nextOwner = data.projects.find((project) => project.id === value)?.ownerUserId ?? data.user.id; const nextAssignees = taskAssigneeOptions(data, value || null); setAssigneeUserId((current) => current === "" || nextAssignees.some((assignee) => assignee.id === current) ? current : data.user.id); setStatusId(data.statuses.find((status) => status.ownerUserId === nextOwner && status.isDefault)?.id ?? data.statuses.find((status) => status.ownerUserId === nextOwner)?.id ?? ""); }}><option value="" disabled>Select project</option>{editableProjects.map((project) => <option key={project.id} value={project.id}>{project.taskCode} · {project.name}</option>)}</PropertySelect><PropertySelect icon={<Rocket size={13} />} value={releaseId} onChange={setReleaseId} disabled={!projectId}><option value="">No release</option>{data.releases.filter((release) => release.projectId === projectId && canEditContent(release.accessRole)).map((release) => <option key={release.id} value={release.id}>{release.name}</option>)}</PropertySelect></div></fieldset>{!editableProjects.length && <p className="inline-note">Create an editable Project before adding a Task.</p>}<section className={`composer-attachments ${dragActive ? "drag-active" : ""}`} aria-label="Task attachments" onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }} onDrop={(event) => { event.preventDefault(); setDragActive(false); addFiles(event.dataTransfer.files); }} onPaste={(event) => { if (!event.clipboardData.files.length) return; event.preventDefault(); addFiles(event.clipboardData.files); }}><div><button className="button ghost" type="button" disabled={Boolean(createdTask)} onClick={() => fileInputRef.current?.click()}><Paperclip size={14} />Add files</button><span>{attachments.length ? `${attachments.length} selected` : "Files upload after Task creation"}</span></div><input ref={fileInputRef} className="visually-hidden" type="file" multiple aria-label="Choose files for the new task" disabled={Boolean(createdTask)} onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />{attachments.length > 0 && <div className="composer-attachment-list" aria-live="polite">{attachments.map((attachment) => <article key={attachment.id}><FileAttachmentIcon filename={attachment.file.name} /><div><b title={attachment.file.name}>{attachment.file.name}</b><small>{attachment.status === "uploading" ? `${attachment.progress}% uploaded` : attachment.status === "complete" ? "Attached" : attachment.error ?? attachment.status}</small>{attachment.status === "uploading" && <progress value={attachment.progress} max="100" aria-label={`Upload progress for ${attachment.file.name}`} />}</div>{attachment.status === "uploading" ? <button className="icon-button" type="button" aria-label={`Cancel ${attachment.file.name}`} onClick={() => activeUploads.current.get(attachment.id)?.()}><X size={14} /></button> : attachment.status === "failed" || attachment.status === "canceled" ? <button className="icon-button" type="button" aria-label={`Retry ${attachment.file.name}`} onClick={() => createdTask && void uploadOne(createdTask, attachment)}><RotateComposerIcon /></button> : !createdTask ? <button className="icon-button" type="button" aria-label={`Remove ${attachment.file.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><X size={14} /></button> : null}</article>)}</div>}</section>{composerError && <p className="composer-upload-error" role="alert">{composerError}</p>}<div className="modal-footer"><span className="shortcut-hint">{createdTask ? "The Task is saved; closing never leaves orphan files." : <><kbd>⌘</kbd><kbd>Enter</kbd> to create</>}</span><button className="button primary" disabled={busy || !title.trim() || !projectId || attachments.some((item) => item.status === "uploading")}>{busy ? "Creating…" : createdTask ? pendingCount ? `Retry ${pendingCount} file${pendingCount === 1 ? "" : "s"}` : "Done" : attachments.length ? "Create and upload" : "Create task"}</button></div></form></Modal>;
}

function FileAttachmentIcon({ filename }: { filename: string }) {
  return <span className="composer-attachment-icon" aria-hidden="true">{filename.split(".").at(-1)?.slice(0, 4).toUpperCase() || "FILE"}</span>;
}

function RotateComposerIcon() {
  return <span aria-hidden="true">↻</span>;
}

function TaskDetails({ task, data, onClose, onOpenTask, onSave, onRebase, onShare, busy }: { task: TaskRecord; data: AppSnapshot; onClose: () => void; onOpenTask: (id: string) => void; onSave: (input: Record<string, unknown>) => Promise<unknown>; onRebase: (taskId: string) => Promise<TaskRecord | null>; onShare: () => void; busy: boolean }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionUploadActive, setDescriptionUploadActive] = useState(false);
  const [estimate, setEstimate] = useState(task.estimate?.toString() ?? "");
  const [rebasing, setRebasing] = useState(false);
  const [dirty, setDirty] = useState<TaskDraftDirty>({
    title: false,
    description: false,
    estimate: false,
  });
  const autoRebaseKey = useRef<string | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const cancelTitleSave = useRef(false);
  const [autoRebaseFailed, setAutoRebaseFailed] = useState(false);
  const source = useTaskExternalSource(task);
  const hasVersionConflict = taskNeedsDetailRefresh(task);
  const syncMode = taskDraftSyncMode(hasVersionConflict, dirty);

  useEffect(() => {
    resizeTaskTitle(titleRef.current);
  }, [title]);

  useEffect(() => {
    const resize = () => resizeTaskTitle(titleRef.current);
    window.addEventListener("resize", resize);
    const observer = typeof ResizeObserver === "undefined" || !titleRef.current?.parentElement
      ? null
      : new ResizeObserver(resize);
    if (observer && titleRef.current?.parentElement) {
      observer.observe(titleRef.current.parentElement);
    }
    return () => {
      window.removeEventListener("resize", resize);
      observer?.disconnect();
    };
  }, [task.id]);

  const rebaseDraft = useCallback(async () => {
    setRebasing(true);
    setAutoRebaseFailed(false);
    const latest = await onRebase(task.id);
    if (latest && latest.version >= task.version) {
      const next = rebaseTaskDraft(
        { title, description, estimate },
        dirty,
        latest,
      );
      setTitle(next.title);
      setDescription(next.description);
      setEstimate(next.estimate);
    } else {
      setAutoRebaseFailed(true);
    }
    setRebasing(false);
  }, [description, dirty, estimate, onRebase, task.id, task.version, title]);

  useEffect(() => {
    if (syncMode !== "auto") {
      autoRebaseKey.current = null;
      return;
    }
    const rebaseKey = `${task.version}:${task.detailStale ? "stale" : "version"}`;
    if (autoRebaseKey.current === rebaseKey) return;
    autoRebaseKey.current = rebaseKey;
    void rebaseDraft();
  }, [rebaseDraft, syncMode, task.detailStale, task.version]);

  if (!canEditContent(task.accessRole)) {
    return <ReadOnlyTaskDetails task={task} data={data} source={source} onClose={onClose} onOpenTask={onOpenTask} />;
  }
  const statuses = data.statuses.filter(
    (status) => status.ownerUserId === task.ownerUserId &&
      (!status.archivedAt || status.id === task.statusId),
  );
  const currentProject = data.projects.find((project) => project.id === task.projectId);
  const assignees = taskAssigneeOptions(data, task.projectId, task.id);
  const taskMap = new Map(data.tasks.map((item) => [item.id, item]));
  const labels = data.taskLabels
    .filter((assignment) => assignment.taskId === task.id)
    .map((assignment) => data.labels.find((label) => label.id === assignment.labelId))
    .filter((label) => label !== undefined);
  const parent = task.parentTaskId ? taskMap.get(task.parentTaskId) : undefined;
  const subtasks = data.tasks.filter((item) => item.parentTaskId === task.id);
  const sourceContent = <ImportedSourceDetails source={source} hasExternalSource={task.hasExternalSource || task.externalSourceInvalidationCursor !== undefined} full />;
  async function saveDraftField(
    field: keyof TaskDraftDirty,
    input: Record<string, unknown>,
  ) {
    const saved = await onSave(input);
    if (saved === true) {
      setDirty((current) => ({ ...current, [field]: false }));
    }
    return saved === true;
  }

  const showVersionConflict = syncMode === "manual" ||
    (syncMode === "auto" && autoRebaseFailed);

  return (
    <div className="details-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="details-panel">
        <header>
          <div className="details-crumb"><span>{task.identifier}</span><button title="Copy link" onClick={() => void navigator.clipboard.writeText(window.location.href)}><Link2 size={13} /></button></div>
          <div><button className="button ghost" onClick={onShare}><Share2 size={13} />Share</button><button className="icon-button" onClick={onClose}><X size={16} /></button></div>
        </header>
        <div className="details-body">
          {showVersionConflict && (
            <div className="task-version-conflict" role="alert">
              <p>This task changed elsewhere. Your draft is preserved in this panel; load the latest version before saving.</p>
              <button className="button secondary" type="button" disabled={rebasing} onClick={() => void rebaseDraft()}>{rebasing ? "Loading latest…" : "Load latest and keep draft"}</button>
            </div>
          )}
          <textarea
            ref={titleRef}
            className="details-title"
            rows={1}
            aria-label="Task title"
            value={title}
            onChange={(event) => {
              const nextTitle = event.target.value.replace(/[\r\n]+/g, " ");
              cancelTitleSave.current = false;
              setDirty((current) => ({ ...current, title: taskDraftValueChanged(nextTitle, task.title) }));
              setTitle(nextTitle);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancelTitleSave.current = true;
                setTitle(task.title);
                setDirty((current) => ({ ...current, title: false }));
                event.currentTarget.blur();
              } else if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            onBlur={() => {
              if (cancelTitleSave.current) {
                cancelTitleSave.current = false;
                return;
              }
              if (!title.trim()) {
                setTitle(task.title);
                setDirty((current) => ({ ...current, title: false }));
                return;
              }
              if (!hasVersionConflict && title.trim() && title !== task.title) {
                void saveDraftField("title", { title });
              }
            }}
          />
          <section className="task-description-section" aria-label="Description">
            <header>
              <span>Description</span>
              {!editingDescription && (
                <button
                  className="button ghost"
                  type="button"
                  disabled={hasVersionConflict}
                  onClick={() => setEditingDescription(true)}
                >
                  Edit description
                </button>
              )}
            </header>
            {editingDescription ? (
              <div className="task-description-editor">
                <TaskDescriptionEditor
                  taskId={task.id}
                  value={description}
                  onChange={(nextDescription) => {
                    setDirty((current) => ({ ...current, description: taskDraftValueChanged(nextDescription, task.description ?? "") }));
                    setDescription(nextDescription);
                  }}
                  onUploadActiveChange={setDescriptionUploadActive}
                  disabled={busy || hasVersionConflict}
                />
                <div className="task-description-editor-actions">
                  <button
                    className="button ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setDescription(task.description ?? "");
                      setDirty((current) => ({ ...current, description: false }));
                      setEditingDescription(false);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="button secondary save-description"
                    type="button"
                    disabled={busy || descriptionUploadActive || hasVersionConflict || description === (task.description ?? "")}
                    onClick={() => void saveDraftField("description", { description })
                      .then((saved) => saved && setEditingDescription(false))}
                  >
                    {busy ? "Saving…" : "Save description"}
                  </button>
                </div>
              </div>
            ) : description ? (
              <TaskDescriptionMarkdown task={task} body={description} className="task-description-markdown" />
            ) : (
              <p className="task-description-empty">No description</p>
            )}
          </section>
          <div className="properties-grid">
            <PropertyRow label="Status" icon={<CircleDot size={14} />}><select value={task.statusId} disabled={hasVersionConflict} onChange={(event) => void onSave({ statusId: event.target.value })}>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select></PropertyRow>
            <PropertyRow label="Priority" icon={<ArrowDownWideNarrow size={14} />}><select value={task.priority} disabled={hasVersionConflict} onChange={(event) => void onSave({ priority: event.target.value })}>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select></PropertyRow>
            <PropertyRow label="Assignee" icon={<UsersRound size={14} />}><select value={task.assigneeUserId ?? ""} disabled={hasVersionConflict} onChange={(event) => void onSave({ assigneeUserId: event.target.value || null })}><option value="">No assignee</option>{assignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.displayName}</option>)}</select></PropertyRow>
            <PropertyRow label="Project" icon={<FolderKanban size={14} />}><select value={task.projectId} disabled title="Use Move Task to change Project"><option value={task.projectId}>{currentProject?.taskCode} · {currentProject?.name}</option></select></PropertyRow>
            <PropertyRow label="Release" icon={<Rocket size={14} />}><select value={task.releaseId ?? ""} onChange={(event) => void onSave({ releaseId: event.target.value || null })} disabled={hasVersionConflict || !task.projectId}><option value="">No release</option>{data.releases.filter((release) => release.projectId === task.projectId).map((release) => <option key={release.id} value={release.id}>{release.name}</option>)}</select></PropertyRow>
            <PropertyRow label="Due date" icon={<CalendarDays size={14} />}><input type="date" value={task.dueDate ?? ""} disabled={hasVersionConflict} onChange={(event) => void onSave({ dueDate: event.target.value || null })} /></PropertyRow>
            <PropertyRow label="Estimate" icon={<Zap size={14} />}><input type="number" min="0" max="100" value={estimate} placeholder="No estimate" onChange={(event) => { const nextEstimate = event.target.value; setDirty((current) => ({ ...current, estimate: taskDraftValueChanged(nextEstimate, task.estimate?.toString() ?? "") })); setEstimate(nextEstimate); }} onBlur={() => { const value = estimate === "" ? null : Number(estimate); if (!hasVersionConflict && value !== task.estimate) void saveDraftField("estimate", { estimate: value }); }} /></PropertyRow>
          </div>
          {labels.length > 0 && <DetailsSection title="Labels" icon={<Tag size={14} />}><div className="details-labels">{labels.map((label) => <span key={label.id} style={{ "--label-color": label.color } as React.CSSProperties}>{label.name}</span>)}</div></DetailsSection>}
          {(parent || subtasks.length > 0) && <DetailsSection title="Hierarchy" icon={<Boxes size={14} />}><div className="details-links">{parent && <TaskReference label="Parent" task={parent} onOpen={onOpenTask} />}{subtasks.map((subtask) => <TaskReference key={subtask.id} label="Subtask" task={subtask} onOpen={onOpenTask} />)}</div></DetailsSection>}
          <TaskRelations
            task={task}
            data={data}
            onOpenTask={onOpenTask}
            onRefresh={onRebase}
            canWrite
            busy={busy}
          />
          <TaskAttachments task={task} currentUser={data.user} users={data.users} canWrite description={task.description} />
          <TaskActivity task={task} currentUser={data.user} canWrite />
          {sourceContent}
          <div className="timestamps"><span>Created {longDate(task.createdAt)}</span><span>Updated {longDate(task.updatedAt)}</span>{task.completedAt && <span>Completed {longDate(task.completedAt)}</span>}</div>
          <button className="button danger ghost archive-action" disabled={hasVersionConflict} onClick={() => { void onSave({ archived: !task.archivedAt }); onClose(); }}><Archive size={14} />{task.archivedAt ? "Restore task" : "Archive task"}</button>
        </div>
      </aside>
    </div>
  );
}

function TaskDetailsLoading({ task, onClose }: { task: TaskRecord; onClose: () => void }) {
  return <div className="details-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="details-panel" aria-busy="true"><header><div className="details-crumb"><span>{task.identifier}</span></div><button className="icon-button" onClick={onClose}><X size={16} /></button></header><div className="details-body task-details-loading"><h1 className="read-only-title">{task.title}</h1><p>Loading task details…</p></div></aside></div>;
}

function ReadOnlyTaskDetails({ task, data, source, onClose, onOpenTask }: { task: TaskRecord; data: AppSnapshot; source: ExternalSourceRecord | null | undefined; onClose: () => void; onOpenTask: (id: string) => void }) {
  const status = data.statuses.find((item) => item.id === task.statusId);
  const project = task.projectId ? data.projects.find((item) => item.id === task.projectId) : undefined;
  const release = task.releaseId ? data.releases.find((item) => item.id === task.releaseId) : undefined;
  const assignee = task.assigneeUserId
    ? [...data.users, data.user].find((item) => item.id === task.assigneeUserId)
    : undefined;
  const parent = task.parentTaskId ? data.tasks.find((item) => item.id === task.parentTaskId) : undefined;
  const subtasks = data.tasks.filter((item) => item.parentTaskId === task.id);
  const sourceContent = <ImportedSourceDetails source={source} hasExternalSource={task.hasExternalSource || task.externalSourceInvalidationCursor !== undefined} />;
  return <div className="details-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="details-panel read-only"><header><div className="details-crumb"><span>{task.identifier}</span><small className="role-badge">Viewer</small></div><button className="icon-button" onClick={onClose}><X size={16} /></button></header><div className="details-body"><h1 className="read-only-title">{task.title}</h1>{task.description ? <TaskDescriptionMarkdown task={task} body={task.description} className="task-description-markdown" /> : <p className="task-description-empty">No description</p>}<div className="properties-grid"><PropertyValue label="Status" value={status?.name ?? "Unknown"} /><PropertyValue label="Priority" value={priorityMeta[task.priority].label} /><PropertyValue label="Assignee" value={assignee?.displayName ?? "No assignee"} /><PropertyValue label="Project" value={project ? `${project.taskCode} · ${project.name}` : "Unavailable"} /><PropertyValue label="Release" value={release?.name ?? "No release"} /><PropertyValue label="Due date" value={task.dueDate ? shortDate(task.dueDate) : "No due date"} /><PropertyValue label="Estimate" value={task.estimate == null ? "No estimate" : String(task.estimate)} /></div>{(parent || subtasks.length > 0) && <DetailsSection title="Hierarchy" icon={<Boxes size={14} />}><div className="details-links">{parent && <TaskReference label="Parent" task={parent} onOpen={onOpenTask} />}{subtasks.map((subtask) => <TaskReference key={subtask.id} label="Subtask" task={subtask} onOpen={onOpenTask} />)}</div></DetailsSection>}<TaskRelations task={task} data={data} onOpenTask={onOpenTask} onRefresh={async () => task} canWrite={false} busy={false} /><TaskAttachments task={task} currentUser={data.user} users={data.users} canWrite={false} description={task.description} /><TaskActivity task={task} currentUser={data.user} canWrite={false} />{sourceContent}<div className="timestamps"><span>Created {longDate(task.createdAt)}</span><span>Updated {longDate(task.updatedAt)}</span></div></div></aside></div>;
}

type RelativeRelationKind = "blocks" | "blocked_by" | "related" | "duplicate_of" | "duplicates";

function TaskRelations({
  task,
  data,
  onOpenTask,
  onRefresh,
  canWrite,
  busy,
}: {
  task: TaskRecord;
  data: AppSnapshot;
  onOpenTask: (id: string) => void;
  onRefresh: (taskId: string) => Promise<TaskRecord | null>;
  canWrite: boolean;
  busy: boolean;
}) {
  const presentations = taskRelationPresentations(task, data);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<RelativeRelationKind>("related");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<TaskRecord[]>(data.tasks);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [searching, setSearching] = useState(false);
  const [pendingRelationId, setPendingRelationId] = useState<string | null>(null);
  const [relationError, setRelationError] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  const existingTargetIds = new Set(presentations.map((item) => item.target.id));
  const availableCandidates = candidates
    .filter((candidate) =>
      candidate.id !== task.id &&
      candidate.projectId !== null &&
      canEditContent(candidate.accessRole) &&
      !existingTargetIds.has(candidate.id) &&
      (!query.trim() || `${candidate.identifier} ${candidate.title}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))
    .slice(0, 8);

  function searchCandidates(nextQuery: string) {
    setQuery(nextQuery);
    setSelectedTaskId("");
    setCandidates(data.tasks);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!nextQuery.trim()) {
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      void fetch(`/api/tasks?search=${encodeURIComponent(nextQuery.trim())}`, { cache: "no-store" })
        .then(async (response) => {
          const value = await response.json() as { tasks?: TaskRecord[]; error?: string };
          if (!response.ok || value.error) throw new Error(value.error ?? "Task search failed");
          setCandidates(value.tasks ?? []);
          setRelationError("");
        })
        .catch((requestError: unknown) => {
          setRelationError(requestError instanceof Error ? requestError.message : "Task search failed");
        })
        .finally(() => setSearching(false));
    }, 180);
  }

  async function sendRelationMutation(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    input: Record<string, unknown>,
    pendingId: string,
  ) {
    setPendingRelationId(pendingId);
    setRelationError("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const value = await response.json() as { error?: string };
      if (!response.ok || value.error) throw new Error(value.error ?? "Relation could not be saved");
      await onRefresh(task.id);
      return true;
    } catch (requestError) {
      setRelationError(requestError instanceof Error ? requestError.message : "Relation could not be saved");
      return false;
    } finally {
      setPendingRelationId(null);
    }
  }

  async function createRelation() {
    if (!selectedTaskId || kind === "duplicates") return;
    const semantic = relativeRelationSemantic(kind);
    const saved = await sendRelationMutation(
      `/api/tasks/${encodeURIComponent(task.id)}/relations`,
      "POST",
      {
        targetTaskId: selectedTaskId,
        ...semantic,
        taskVersion: task.version,
        idempotencyKey: crypto.randomUUID(),
      },
      "new",
    );
    if (saved) {
      setAdding(false);
      setQuery("");
      setSelectedTaskId("");
    }
  }

  async function updateRelation(item: TaskRelationPresentation, nextKind: RelativeRelationKind) {
    if (nextKind === "duplicates") return;
    await sendRelationMutation(
      `/api/tasks/${encodeURIComponent(task.id)}/relations/${encodeURIComponent(item.relation.id)}`,
      "PATCH",
      {
        version: item.relation.version,
        ...relativeRelationSemantic(nextKind),
        taskVersion: task.version,
      },
      item.relation.id,
    );
  }

  async function removeRelation(item: TaskRelationPresentation) {
    await sendRelationMutation(
      `/api/tasks/${encodeURIComponent(task.id)}/relations/${encodeURIComponent(item.relation.id)}`,
      "DELETE",
      { version: item.relation.version },
      item.relation.id,
    );
  }

  if (!canWrite && presentations.length === 0) return null;
  const grouped = taskRelationGroupOrder
    .map((group) => ({ group, items: presentations.filter((item) => item.group === group) }))
    .filter(({ items }) => items.length > 0);
  const relationBusy = busy || pendingRelationId !== null;

  return <section className="details-section task-relations" aria-label="Task relations">
    <div className="task-relations-header">
      <h2><Link2 size={14} />Relations</h2>
      {canWrite && task.projectId && <button className="button ghost" type="button" disabled={relationBusy} onClick={() => { setAdding((current) => !current); setRelationError(""); }}><Plus size={13} />Add relation</button>}
    </div>
    {!task.projectId && canWrite && <p className="inline-note">Add this Task to a Project before creating relations.</p>}
    {grouped.map(({ group, items }) => <div className="task-relation-group" key={group}>
      <h3>{group}</h3>
      <div className="details-links">
        {items.map((item) => <div className="task-relation-row" key={item.relation.id} aria-busy={pendingRelationId === item.relation.id}>
          <TaskReference label={item.label} task={item.target} onOpen={onOpenTask} />
          {canWrite && <div className="task-relation-actions">
            <select aria-label={`Change relation to ${item.target.identifier}`} value={relativeRelationKind(item)} disabled={relationBusy} onChange={(event) => void updateRelation(item, event.target.value as RelativeRelationKind)}>
              <option value="related">Related</option>
              <option value="blocks">Blocks</option>
              <option value="blocked_by">Blocked by</option>
              <option value="duplicate_of">Duplicate of</option>
              {relativeRelationKind(item) === "duplicates" && <option value="duplicates" disabled>Duplicate</option>}
            </select>
            <button className="icon-button" type="button" aria-label={`Remove relation to ${item.target.identifier}`} disabled={relationBusy} onClick={() => void removeRelation(item)}><X size={13} /></button>
          </div>}
        </div>)}
      </div>
    </div>)}
    {adding && <div className="task-relation-composer">
      <div>
        <select aria-label="Relation type" value={kind} disabled={relationBusy} onChange={(event) => setKind(event.target.value as RelativeRelationKind)}>
          <option value="related">Related</option>
          <option value="blocks">Blocks</option>
          <option value="blocked_by">Blocked by</option>
          <option value="duplicate_of">Duplicate of</option>
        </select>
        <input aria-label="Search Tasks for relation" value={query} disabled={relationBusy} placeholder="Search by identifier or title…" onChange={(event) => searchCandidates(event.target.value)} />
      </div>
      <div className="task-relation-candidates" aria-busy={searching}>
        {searching && <span>Searching…</span>}
        {!searching && availableCandidates.length === 0 && <span>No editable project Tasks found.</span>}
        {!searching && availableCandidates.map((candidate) => <button type="button" key={candidate.id} className={selectedTaskId === candidate.id ? "selected" : ""} onClick={() => setSelectedTaskId(candidate.id)}><span>{candidate.identifier}</span><b>{candidate.title}</b></button>)}
      </div>
      <div className="task-relation-composer-actions">
        <button className="button ghost" type="button" disabled={relationBusy} onClick={() => setAdding(false)}>Cancel</button>
        <button className="button secondary" type="button" disabled={relationBusy || !selectedTaskId} onClick={() => void createRelation()}>{pendingRelationId === "new" ? "Adding…" : kind === "duplicate_of" ? "Mark duplicate" : "Add relation"}</button>
      </div>
    </div>}
    {relationError && <p className="task-relation-error" role="alert">{relationError}</p>}
  </section>;
}

function relativeRelationSemantic(kind: Exclude<RelativeRelationKind, "duplicates">) {
  if (kind === "blocked_by") return { type: "blocks" as const, direction: "incoming" as const };
  return {
    type: kind,
    direction: "outgoing" as const,
  };
}

function relativeRelationKind(item: TaskRelationPresentation): RelativeRelationKind {
  if (item.relation.type === "related") return "related";
  if (item.relation.type === "duplicate_of") {
    return item.direction === "outgoing" ? "duplicate_of" : "duplicates";
  }
  return item.direction === "outgoing" ? "blocks" : "blocked_by";
}

function useTaskExternalSource(task: TaskRecord) {
  const [loaded, setLoaded] = useState<{
    taskId: string;
    source: ExternalSourceRecord | null;
  } | null>(null);

  useEffect(() => {
    if (!task.hasExternalSource && !task.externalSourceInvalidationCursor) return;
    // A sync invalidation makes only the mounted lazy consumer reload.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoaded(null);
    const controller = new AbortController();
    void fetch(`/api/tasks/${encodeURIComponent(task.id)}/external-source`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const value = (await response.json()) as
          | ExternalSourceRecord
          | null
          | { error: string };
        if (!response.ok || (value && "error" in value)) {
          throw new Error(value && "error" in value ? value.error : "Request failed");
        }
        setLoaded({ taskId: task.id, source: value });
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") {
          return;
        }
        setLoaded({ taskId: task.id, source: null });
      });
    return () => controller.abort();
  }, [
    task.externalSourceInvalidationCursor,
    task.hasExternalSource,
    task.id,
  ]);

  if (!task.hasExternalSource && !task.externalSourceInvalidationCursor) return null;
  return loaded?.taskId === task.id ? loaded.source : undefined;
}

function TaskActivity({ task, currentUser, canWrite }: {
  task: TaskRecord;
  currentUser: UserRecord;
  canWrite: boolean;
}) {
  const [page, setPage] = useState<CommentPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const pendingIdempotencyKeys = useRef(new Map<string, string>());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const draftKey = commentDraftStorageKey(currentUser.id, task.id, replyTo ?? undefined);

  useEffect(() => {
    const saved = window.localStorage.getItem(draftKey);
    // Local storage is the external source for an unsent per-user task/thread draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(saved ?? "");
  }, [draftKey]);

  useEffect(() => {
    if (draft) window.localStorage.setItem(draftKey, draft);
    else window.localStorage.removeItem(draftKey);
  }, [draft, draftKey]);

  async function loadComments(cursor: string | null = null, append = false) {
    setLoading(true);
    setError("");
    try {
      const next = await fetchCommentJson<CommentPage>(
        `/api/tasks/${encodeURIComponent(task.id)}/comments?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      setPage((current) => append && current ? {
        ...next,
        threads: [...current.threads, ...next.threads],
      } : next);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Comments could not be loaded");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Keep the draft, but discard the loaded page after a remote comment event.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(null);
    const timer = window.setTimeout(() => void loadComments(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.commentInvalidationCursor, task.id]);

  useEffect(() => {
    if (!page || !window.location.hash.startsWith("#comment-")) return;
    const target = document.getElementById(window.location.hash.slice(1));
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("permalink-target");
    const timer = window.setTimeout(() => target.classList.remove("permalink-target"), 1800);
    return () => window.clearTimeout(timer);
  }, [page]);

  async function submitComment() {
    if (!canWrite || busy || !draft.trim()) return;
    const submittedDraftKey = draftKey;
    const submittedReplyTo = replyTo;
    const idempotencyKey = pendingIdempotencyKeys.current.get(submittedDraftKey) ?? crypto.randomUUID();
    pendingIdempotencyKeys.current.set(submittedDraftKey, idempotencyKey);
    setBusy(true);
    setError("");
    try {
      await fetchCommentJson<CommentRecord>(
        `/api/tasks/${encodeURIComponent(task.id)}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            body: draft,
            parentCommentId: replyTo,
            idempotencyKey,
          }),
        },
      );
      pendingIdempotencyKeys.current.delete(submittedDraftKey);
      window.localStorage.removeItem(submittedDraftKey);
      setReplyTo(null);
      setDraft(submittedReplyTo
        ? window.localStorage.getItem(commentDraftStorageKey(currentUser.id, task.id)) ?? ""
        : "");
      await loadComments();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Comment could not be saved");
    } finally {
      setBusy(false);
    }
  }

  async function mutateComment(path: string, method: string, input: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fetchCommentJson(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      await loadComments();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Comment action failed");
    } finally {
      setBusy(false);
    }
  }

  function commentPath(commentId: string, suffix = "") {
    return `/api/tasks/${encodeURIComponent(task.id)}/comments/${encodeURIComponent(commentId)}${suffix}`;
  }

  function switchComposer(threadId: string | null) {
    setReplyTo(threadId);
    setDraft(window.localStorage.getItem(
      commentDraftStorageKey(currentUser.id, task.id, threadId ?? undefined),
    ) ?? "");
  }

  const count = page?.totalCount ?? task.commentCount;
  return <section className="task-activity details-section" aria-labelledby={`activity-${task.id}`}>
    <header className="activity-header">
      <h2 id={`activity-${task.id}`}><MessageSquare size={14} />Activity</h2>
      <span>{count} {count === 1 ? "comment" : "comments"}</span>
    </header>
    {loading && !page && <p className="inline-note" role="status">Loading comments…</p>}
    {error && <div className="comment-error" role="alert"><span>{error}</span><button type="button" onClick={() => void loadComments()}>Retry</button></div>}
    {page && page.threads.length === 0 && <p className="activity-empty">No comments yet.</p>}
    <div className="comment-threads">
      {page?.threads.map((thread) => <CommentThread
        key={`${thread.root.id}:${thread.root.resolvedAt ?? "open"}`}
        thread={thread}
        busy={busy}
        onReply={(rootId) => {
          switchComposer(rootId);
          window.setTimeout(() => composerRef.current?.focus(), 0);
        }}
        onEdit={(comment, body) => mutateComment(commentPath(comment.id), "PATCH", { version: comment.version, body })}
        onDelete={(comment) => mutateComment(commentPath(comment.id), "DELETE", { version: comment.version })}
        onReact={(comment, emoji, active) => mutateComment(commentPath(comment.id, "/reactions"), "PUT", { emoji, active })}
        onResolve={(comment, resolved) => mutateComment(commentPath(comment.id, "/resolution"), "PUT", { version: comment.version, resolved })}
      />)}
    </div>
    {page?.hasMore && <button className="button ghost load-comments" type="button" disabled={loading} onClick={() => void loadComments(page.nextCursor, true)}>{loading ? "Loading…" : "Load older threads"}</button>}
    {canWrite && <div className="comment-composer">
      <span className="comment-avatar" style={{ "--avatar-hue": avatarHue(currentUser.id) } as React.CSSProperties}>{initials(currentUser.displayName)}</span>
      <div className="comment-composer-box">
        {replyTo && <div className="reply-context"><span>Replying in thread</span><button type="button" onClick={() => switchComposer(null)}>Cancel</button></div>}
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void submitComment();
            }
          }}
          placeholder="Leave a comment…"
          aria-label="Comment body"
          rows={draft.includes("\n") ? 5 : 3}
        />
        <div className="comment-composer-actions">
          <div className="comment-toolbar" role="toolbar" aria-label="Comment formatting">
            <button type="button" title="Bold" aria-label="Bold" onClick={() => formatCommentSelection(composerRef.current, setDraft, "**")}><b>B</b></button>
            <button type="button" title="Italic" aria-label="Italic" onClick={() => formatCommentSelection(composerRef.current, setDraft, "*")}><i>I</i></button>
            <button type="button" title="Inline code" aria-label="Inline code" onClick={() => formatCommentSelection(composerRef.current, setDraft, "`")}><code>&lt;/&gt;</code></button>
            <button type="button" title="Quote" aria-label="Quote" onClick={() => prefixCommentLines(composerRef.current, setDraft, "> ")}>&gt;</button>
            <button type="button" title="List" aria-label="List" onClick={() => prefixCommentLines(composerRef.current, setDraft, "- ")}>•</button>
            <button type="button" title="Link" aria-label="Link" onClick={() => formatCommentSelection(composerRef.current, setDraft, "[", "](https://)")}>↗</button>
          </div>
          <span><kbd>⌘</kbd><kbd>Enter</kbd></span>
          <button className="button primary" type="button" disabled={busy || !draft.trim()} onClick={() => void submitComment()}>{busy ? "Saving…" : replyTo ? "Reply" : "Comment"}</button>
        </div>
      </div>
    </div>}
  </section>;
}

function CommentThread({ thread, busy, onReply, onEdit, onDelete, onReact, onResolve }: {
  thread: CommentThreadRecord;
  busy: boolean;
  onReply: (rootId: string) => void;
  onEdit: (comment: CommentRecord, body: string) => Promise<void>;
  onDelete: (comment: CommentRecord) => Promise<void>;
  onReact: (comment: CommentRecord, emoji: string, active: boolean) => Promise<void>;
  onResolve: (comment: CommentRecord, resolved: boolean) => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState(Boolean(thread.root.resolvedAt));
  return <article className={`comment-thread ${thread.root.resolvedAt ? "resolved" : ""}`}>
    {thread.root.resolvedAt && <button className="resolved-thread-toggle" type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}><Check size={13} />Resolved thread · {thread.replies.length + 1} messages</button>}
    {!collapsed && <>
      <CommentEntry comment={thread.root} rootId={thread.root.id} busy={busy} onReply={onReply} onEdit={onEdit} onDelete={onDelete} onReact={onReact} onResolve={onResolve} />
      {thread.replies.length > 0 && <div className="comment-replies">{thread.replies.map((reply) => <CommentEntry key={reply.id} comment={reply} rootId={thread.root.id} busy={busy} onReply={onReply} onEdit={onEdit} onDelete={onDelete} onReact={onReact} onResolve={onResolve} />)}</div>}
    </>}
  </article>;
}

function CommentEntry({ comment, rootId, busy, onReply, onEdit, onDelete, onReact, onResolve }: {
  comment: CommentRecord;
  rootId: string;
  busy: boolean;
  onReply: (rootId: string) => void;
  onEdit: (comment: CommentRecord, body: string) => Promise<void>;
  onDelete: (comment: CommentRecord) => Promise<void>;
  onReact: (comment: CommentRecord, emoji: string, active: boolean) => Promise<void>;
  onResolve: (comment: CommentRecord, resolved: boolean) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const [expanded, setExpanded] = useState(false);
  const long = comment.body.length > 1_200;
  const body = long && !expanded ? `${comment.body.slice(0, 1_200)}…` : comment.body;
  const isRoot = comment.parentCommentId === null;
  const permalink = `comment-${comment.id}`;
  return <div className="comment-entry" id={permalink} tabIndex={-1}>
    <span className="comment-avatar" style={{ "--avatar-hue": avatarHue(comment.author.id) } as React.CSSProperties}>{initials(comment.author.displayName)}</span>
    <div className="comment-content">
      <header><b>{comment.author.displayName}</b><time dateTime={comment.createdAt} title={longDateTime(comment.createdAt)}>{relativeTime(comment.createdAt)}</time>{comment.updatedAt !== comment.createdAt && <small>edited</small>}
        <details className="comment-menu"><summary aria-label="Comment actions"><MoreHorizontal size={14} /></summary><div>
          <button type="button" onClick={() => copyCommentPermalink(comment.id)}>Copy link</button>
          {comment.permissions.canEdit && <button type="button" onClick={() => setEditing(true)}>Edit</button>}
          {comment.permissions.canDelete && <button type="button" onClick={() => { if (window.confirm("Delete this comment?")) void onDelete(comment); }}>Delete</button>}
        </div></details>
      </header>
      {comment.deletedAt ? <p className="comment-tombstone">Comment deleted</p> : editing ? <div className="comment-edit"><textarea value={editBody} onChange={(event) => setEditBody(event.target.value)} rows={4} autoFocus /><div><button className="button ghost" type="button" onClick={() => { setEditBody(comment.body); setEditing(false); }}>Cancel</button><button className="button primary" type="button" disabled={busy || !editBody.trim()} onClick={() => void onEdit(comment, editBody).then(() => setEditing(false))}>Save</button></div></div> : <><CommentMarkdown body={body} />{long && <button className="comment-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less" : "Show more"}</button>}</>}
      {!comment.deletedAt && <div className="comment-actions">
        {comment.reactions.map((reaction) => <button key={reaction.emoji} className={reaction.reactedByCurrentUser ? "active" : ""} type="button" disabled={!comment.permissions.canReact || busy} onClick={() => void onReact(comment, reaction.emoji, !reaction.reactedByCurrentUser)}>{reaction.emoji} <span>{reaction.count}</span></button>)}
        {comment.permissions.canReact && ["👍", "❤️", "🎉"].filter((emoji) => !comment.reactions.some((reaction) => reaction.emoji === emoji)).map((emoji) => <button className="reaction-add" key={emoji} type="button" disabled={busy} aria-label={`React ${emoji}`} onClick={() => void onReact(comment, emoji, true)}>{emoji}</button>)}
        {isRoot && comment.permissions.canReact && <button type="button" disabled={busy} onClick={() => onReply(rootId)}>Reply</button>}
        {isRoot && comment.permissions.canResolve && <button type="button" disabled={busy} onClick={() => void onResolve(comment, !comment.resolvedAt)}>{comment.resolvedAt ? "Reopen" : "Resolve"}</button>}
      </div>}
    </div>
  </div>;
}

function CommentMarkdown({ body }: { body: string }) {
  const lines = body.split("\n");
  const blocks: React.ReactNode[] = [];
  let code: string[] | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("```")) {
      if (code) {
        blocks.push(<pre key={`code-${index}`}><code>{code.join("\n")}</code></pre>);
        code = null;
      } else code = [];
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (line.startsWith("> ")) blocks.push(<blockquote key={index}>{renderMarkdownInline(line.slice(2))}</blockquote>);
    else if (/^[-*] /.test(line)) blocks.push(<div className="comment-list-item" key={index}>• <span>{renderMarkdownInline(line.slice(2))}</span></div>);
    else blocks.push(<p key={index}>{renderMarkdownInline(line) || <br />}</p>);
  }
  if (code) blocks.push(<pre key="code-final"><code>{code.join("\n")}</code></pre>);
  return <div className="comment-body">{blocks}</div>;
}

function TaskDescriptionMarkdown({
  task,
  body,
  className,
}: {
  task: TaskRecord;
  body: string;
  className: string;
}) {
  const [attachmentState, setAttachmentState] = useState<{
    key: string;
    records: Map<string, PublicAttachmentRecord>;
  }>({ key: "", records: new Map() });
  const imageRefKey = [...new Set(
    body
      .split("\n")
      .map((line) => parseTaskImageLine(line)?.ref)
      .filter((ref): ref is string => Boolean(ref)),
  )].sort().join(",");

  useEffect(() => {
    if (!imageRefKey) return;
    const controller = new AbortController();
    const requestedRefs = new Set(imageRefKey.split(","));
    void fetch(`/api/tasks/${encodeURIComponent(task.id)}/attachments`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const value = await response.json() as
          | { attachments: PublicAttachmentRecord[] }
          | { error?: string };
        if (!response.ok || !("attachments" in value)) {
          throw new Error("Native images could not be loaded");
        }
        setAttachmentState({
          key: imageRefKey,
          records: new Map(value.attachments
            .filter((attachment) => requestedRefs.has(attachment.ref))
            .map((attachment) => [attachment.ref, attachment])),
        });
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setAttachmentState({ key: imageRefKey, records: new Map() });
      });
    return () => controller.abort();
  }, [imageRefKey, task.id, task.attachmentInvalidationCursor]);

  const attachments = attachmentState.key === imageRefKey
    ? attachmentState.records
    : null;
  return <MarkdownBody body={body} className={className} taskId={task.id} attachments={attachments} />;
}

function MarkdownBody({
  body,
  className,
  taskId,
  attachments,
}: {
  body: string;
  className: string;
  taskId?: string;
  attachments?: Map<string, PublicAttachmentRecord> | null;
}) {
  const lines = body.split("\n");
  const blocks: React.ReactNode[] = [];
  let code: string[] | null = null;
  let list: { ordered: boolean; items: React.ReactNode[]; key: number } | null = null;

  function flushList() {
    if (!list) return;
    const current = list;
    blocks.push(current.ordered
      ? <ol key={`list-${current.key}`}>{current.items}</ol>
      : <ul key={`list-${current.key}`}>{current.items}</ul>);
    list = null;
  }

  function appendListItem(ordered: boolean, item: React.ReactNode, key: number) {
    if (!list || list.ordered !== ordered) {
      flushList();
      list = { ordered, items: [], key };
    }
    list.items.push(<li key={key}>{item}</li>);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("```")) {
      if (code) {
        blocks.push(<pre key={`code-${index}`}><code>{code.join("\n")}</code></pre>);
        code = null;
      } else {
        flushList();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const nativeImage = taskId ? parseTaskImageLine(line) : null;
    if (nativeImage) {
      flushList();
      blocks.push(
        <TaskDescriptionImage
          key={`image-${index}-${nativeImage.ref}`}
          taskId={taskId!}
          attachment={attachments === null || attachments === undefined
            ? undefined
            : attachments.get(nativeImage.ref) ?? null}
          alt={nativeImage.alt}
          caption={nativeImage.caption}
        />,
      );
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const checklist = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (checklist) {
      appendListItem(false, <label className="markdown-checklist-item"><input type="checkbox" checked={checklist[1].toLowerCase() === "x"} readOnly disabled /><span>{renderMarkdownInline(checklist[2])}</span></label>, index);
    } else if (bullet) {
      appendListItem(false, renderMarkdownInline(bullet[1]), index);
    } else if (ordered) {
      appendListItem(true, renderMarkdownInline(ordered[1]), index);
    } else {
      flushList();
      if (heading) {
        if (heading[1].length === 1) blocks.push(<h2 key={index}>{renderMarkdownInline(heading[2])}</h2>);
        else if (heading[1].length === 2) blocks.push(<h3 key={index}>{renderMarkdownInline(heading[2])}</h3>);
        else blocks.push(<h4 key={index}>{renderMarkdownInline(heading[2])}</h4>);
      } else if (line.startsWith("> ")) {
        blocks.push(<blockquote key={index}>{renderMarkdownInline(line.slice(2))}</blockquote>);
      } else if (line.trim()) {
        blocks.push(<p key={index}>{renderMarkdownInline(line)}</p>);
      }
    }
  }
  if (code) blocks.push(<pre key="code-final"><code>{code.join("\n")}</code></pre>);
  flushList();
  return <div className={className}>{blocks}</div>;
}

function renderMarkdownInline(value: string) {
  const pattern = /(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  const nodes: React.ReactNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > offset) nodes.push(value.slice(offset, match.index));
    const token = match[0];
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = safeMarkdownHref(link[2]);
      nodes.push(href ? <a key={match.index} href={href} target="_blank" rel="noreferrer">{link[1]}</a> : token);
    } else if (token.startsWith("`")) nodes.push(<code key={match.index}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**")) nodes.push(<strong key={match.index}>{token.slice(2, -2)}</strong>);
    else nodes.push(<em key={match.index}>{token.slice(1, -1)}</em>);
    offset = match.index + token.length;
  }
  if (offset < value.length) nodes.push(value.slice(offset));
  return nodes;
}

function safeMarkdownHref(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.href : null;
  } catch {
    return null;
  }
}

function formatCommentSelection(textarea: HTMLTextAreaElement | null, setValue: (value: string) => void, before: string, after = before) {
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const next = `${textarea.value.slice(0, start)}${before}${textarea.value.slice(start, end)}${after}${textarea.value.slice(end)}`;
  setValue(next);
  window.setTimeout(() => {
    textarea.focus();
    textarea.setSelectionRange(start + before.length, end + before.length);
  }, 0);
}

function prefixCommentLines(textarea: HTMLTextAreaElement | null, setValue: (value: string) => void, prefix: string) {
  if (!textarea) return;
  const start = textarea.selectionStart;
  const lineStart = textarea.value.lastIndexOf("\n", start - 1) + 1;
  setValue(`${textarea.value.slice(0, lineStart)}${prefix}${textarea.value.slice(lineStart)}`);
  window.setTimeout(() => textarea.focus(), 0);
}

async function fetchCommentJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const value = await response.json() as T | { error: string };
  if (!response.ok || (value && typeof value === "object" && "error" in value)) {
    throw new Error(value && typeof value === "object" && "error" in value ? value.error : "Comment request failed");
  }
  return value as T;
}

function copyCommentPermalink(commentId: string) {
  const url = new URL(window.location.href);
  url.hash = `comment-${commentId}`;
  void navigator.clipboard.writeText(url.toString());
}

function relativeTime(value: string) {
  const seconds = Math.round((Date.parse(value) - Date.now()) / 1000);
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [["year", 31_536_000], ["month", 2_592_000], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of ranges) if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  return formatter.format(seconds, "second");
}

function avatarHue(value: string) {
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

function ImportedSourceDetails({ source, hasExternalSource, full = false }: {
  source: ExternalSourceRecord | null | undefined;
  hasExternalSource: boolean;
  full?: boolean;
}) {
  if (!hasExternalSource) return null;
  if (source === undefined) {
    return <DetailsSection title="Imported from Linear" icon={<Link2 size={14} />}><p className="inline-note">Loading imported context…</p></DetailsSection>;
  }
  if (source === null) {
    return <DetailsSection title="Imported from Linear" icon={<Link2 size={14} />}><p className="inline-note">Imported context is unavailable.</p></DetailsSection>;
  }
  if (!full) {
    return source.sourceUrl ? <DetailsSection title="Imported source" icon={<Link2 size={14} />}><a href={source.sourceUrl} target="_blank" rel="noreferrer">Open source record</a></DetailsSection> : null;
  }
  return <><DetailsSection title="Imported from Linear" icon={<Link2 size={14} />}><div className="source-metadata">{source.sourceUrl && <a href={source.sourceUrl} target="_blank" rel="noreferrer">Open {source.sourceId} in Linear</a>}{source.gitBranchName && <span><GitBranch size={13} /><code>{source.gitBranchName}</code></span>}<span><MessageSquare size={13} />{source.commentEntries} archived comments</span><span><Boxes size={13} />{source.stateHistoryEntries} status-history entries</span>{source.attachments.map((attachment) => <a key={attachment.url} href={attachment.url} target="_blank" rel="noreferrer"><Paperclip size={13} />{attachment.title}</a>)}</div></DetailsSection>{source.comments.length > 0 && <details className="details-section imported-comment-group"><summary><MessageSquare size={14} />Imported comments <span>{source.comments.length}</span></summary><div className="comment-archive">{source.comments.map((comment) => <article key={comment.id}><header><b>{comment.authorName}</b><time dateTime={comment.createdAt}>{longDateTime(comment.createdAt)}</time>{comment.parentId && <small>Reply</small>}</header>{comment.quotedText && <blockquote>{comment.quotedText}</blockquote>}<p>{comment.body}</p></article>)}</div></details>}</>;
}

function PropertyValue({ label, value }: { label: string; value: string }) {
  return <div className="property-row read-only"><span>{label}</span><b>{value}</b></div>;
}

function DetailsSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) { return <section className="details-section"><h2>{icon}{title}</h2>{children}</section>; }
function TaskReference({ label, task, onOpen }: { label: string; task: TaskRecord; onOpen: (id: string) => void }) { return <a href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, () => onOpen(task.id))}><small>{label}</small><span>{task.identifier}</span><b>{task.title}</b></a>; }

function PropertyRow({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) { return <label className="property-row"><span>{icon}{label}</span>{children}</label>; }
function PropertySelect({ icon, value, onChange, children, disabled }: { icon: React.ReactNode; value: string; onChange: (value: string) => void; children: React.ReactNode; disabled?: boolean }) { return <label className="property-select">{icon}<select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>{children}</select><ChevronDown size={11} /></label>; }

function FilterPopover({ statuses, priority, status, onPriority, onStatus, onClose }: { statuses: WorkflowStatusRecord[]; priority: Priority | "all"; status: string; onPriority: (value: Priority | "all") => void; onStatus: (value: string) => void; onClose: () => void }) { return <Popover title="Filter" onClose={onClose}><label className="popover-field"><span>Status</span><select value={status} onChange={(event) => onStatus(event.target.value)}><option value="all">Any status</option>{statuses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="popover-field"><span>Priority</span><select value={priority} onChange={(event) => onPriority(event.target.value as Priority | "all")}><option value="all">Any priority</option>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select></label><button className="button ghost popover-clear" onClick={() => { onPriority("all"); onStatus("all"); }}>Clear filters</button></Popover>; }
function DisplayPopover({ layout, groupBy, orderBy, onLayout, onGroupBy, onClose }: { layout: Layout; groupBy: ViewDisplay["groupBy"]; orderBy: ViewDisplay["orderBy"]; onLayout: (value: Layout) => void; onGroupBy: (value: ViewDisplay["groupBy"]) => void; onClose: () => void }) { return <Popover title="Display" onClose={onClose}><div className="display-option"><span>Layout</span><div className="segmented wide"><button className={layout === "list" ? "active" : ""} onClick={() => onLayout("list")}><LayoutList size={13} />List</button><button className={layout === "board" ? "active" : ""} onClick={() => onLayout("board")}><Columns3 size={13} />Board</button></div></div><label className="popover-field"><span>Group by</span><select value={groupBy} onChange={(event) => onGroupBy(event.target.value as ViewDisplay["groupBy"])}>{groupByOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><div className="display-static"><span>Order</span><b>{displayLabel(orderBy)}</b></div></Popover>; }
function Popover({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <div className="popover"><header><b>{title}</b><button onClick={onClose}><X size={13} /></button></header>{children}</div>; }

type WorkflowSettingsStatus = WorkflowStatusRecord & {
  taskCount: number;
  savedViewCount: number;
};

const workflowCategoryLabels: Record<StatusCategory, string> = {
  backlog: "Backlog",
  unstarted: "Unstarted",
  started: "Started",
  completed: "Completed",
  canceled: "Canceled",
};

function WorkflowSettingsDialog({
  initialStatuses,
  onClose,
  onStatuses,
}: {
  initialStatuses: WorkflowStatusRecord[];
  onClose: () => void;
  onStatuses: (statuses: WorkflowStatusRecord[]) => void;
}) {
  const [statuses, setStatuses] = useState<WorkflowSettingsStatus[]>(
    initialStatuses.map((status) => ({ ...status, taskCount: 0, savedViewCount: 0 })),
  );
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [replacements, setReplacements] = useState<Record<string, string>>({});
  const onStatusesRef = useRef(onStatuses);

  useEffect(() => {
    onStatusesRef.current = onStatuses;
  }, [onStatuses]);

  const apply = useCallback((next: WorkflowSettingsStatus[]) => {
    setStatuses(next);
    onStatusesRef.current(next);
  }, []);

  const request = useCallback(async (
    path: string,
    method: "POST" | "PATCH",
    body: Record<string, unknown>,
    actionId: string,
  ) => {
    setBusyId(actionId);
    setError("");
    try {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json() as { statuses?: WorkflowSettingsStatus[]; error?: string };
      if (!response.ok || !value.statuses) {
        if (response.status === 409) {
          const refreshedResponse = await fetch("/api/settings/workflow-statuses", { cache: "no-store" });
          const refreshed = await refreshedResponse.json() as { statuses?: WorkflowSettingsStatus[] };
          if (refreshedResponse.ok && refreshed.statuses) apply(refreshed.statuses);
        }
        throw new Error(value.error ?? "Workflow status could not be saved");
      }
      apply(value.statuses);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Workflow status could not be saved");
      return false;
    } finally {
      setBusyId(null);
    }
  }, [apply]);

  useEffect(() => {
    let current = true;
    void fetch("/api/settings/workflow-statuses", { cache: "no-store" })
      .then(async (response) => {
        const value = await response.json() as { statuses?: WorkflowSettingsStatus[]; error?: string };
        if (!response.ok || !value.statuses) throw new Error(value.error ?? "Workflow statuses could not be loaded");
        if (current) apply(value.statuses);
      })
      .catch((requestError: unknown) => {
        if (current) setError(requestError instanceof Error ? requestError.message : "Workflow statuses could not be loaded");
      })
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [apply]);

  const active = statuses.filter((status) => !status.archivedAt);
  const archived = statuses.filter((status) => status.archivedAt);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (await request("/api/settings/workflow-statuses", "POST", values, "create")) form.reset();
  }

  function renderStatus(status: WorkflowSettingsStatus) {
    const categoryPeers = active.filter((candidate) =>
      candidate.category === status.category && candidate.id !== status.id,
    );
    const peerIndex = active.filter((candidate) => candidate.category === status.category)
      .sort((left, right) => left.position - right.position)
      .findIndex((candidate) => candidate.id === status.id);
    const orderedPeers = active.filter((candidate) => candidate.category === status.category)
      .sort((left, right) => left.position - right.position);
    const replacementRequired = status.isDefault || status.taskCount > 0 || status.savedViewCount > 0;
    const replacementId = replacements[status.id] ?? categoryPeers[0]?.id ?? "";
    return (
      <article className={`workflow-status-row ${status.archivedAt ? "archived" : ""}`} key={`${status.id}:${status.version}`}>
        <form onSubmit={(event) => {
          event.preventDefault();
          const values = Object.fromEntries(new FormData(event.currentTarget));
          void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", {
            action: "update",
            version: status.version,
            name: values.name,
            color: values.color,
          }, status.id);
        }}>
          <input className="workflow-color" type="color" name="color" defaultValue={status.color} aria-label={`Color for ${status.name}`} disabled={Boolean(status.archivedAt) || busyId !== null} />
          <span className="workflow-status-main">
            <input name="name" defaultValue={status.name} aria-label={`Name for ${status.name}`} disabled={Boolean(status.archivedAt) || status.systemRole === "duplicate" || busyId !== null} />
            <small>{workflowCategoryLabels[status.category]} · {status.taskCount} task{status.taskCount === 1 ? "" : "s"}{status.savedViewCount ? ` · ${status.savedViewCount} view${status.savedViewCount === 1 ? "" : "s"}` : ""}</small>
          </span>
          {!status.archivedAt && <button className="button ghost compact" disabled={busyId !== null} type="submit">Save</button>}
        </form>
        <div className="workflow-status-actions">
          {!status.archivedAt && <>
            <button className="icon-button" type="button" title="Move up" aria-label={`Move ${status.name} up`} disabled={busyId !== null || peerIndex <= 0} onClick={() => {
              const peer = orderedPeers[peerIndex - 1];
              if (peer) void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", { action: "move", direction: "up", version: status.version, peerVersion: peer.version }, status.id);
            }}><ArrowUp size={14} /></button>
            <button className="icon-button" type="button" title="Move down" aria-label={`Move ${status.name} down`} disabled={busyId !== null || peerIndex < 0 || peerIndex >= orderedPeers.length - 1} onClick={() => {
              const peer = orderedPeers[peerIndex + 1];
              if (peer) void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", { action: "move", direction: "down", version: status.version, peerVersion: peer.version }, status.id);
            }}><ArrowDown size={14} /></button>
            {status.isDefault ? <span className="workflow-default">Default</span> : (["backlog", "unstarted"] as StatusCategory[]).includes(status.category) && <button className="button ghost compact" type="button" disabled={busyId !== null} onClick={() => void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", { action: "update", version: status.version, isDefault: true }, status.id)}>Make default</button>}
            {status.systemRole === "duplicate" ? <span className="workflow-reserved">Reserved</span> : <>
              {replacementRequired && <select aria-label={`Replacement for ${status.name}`} value={replacementId} disabled={busyId !== null} onChange={(event) => setReplacements((current) => ({ ...current, [status.id]: event.target.value }))}><option value="" disabled>Replacement…</option>{categoryPeers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select>}
              <button className="button ghost compact danger" type="button" disabled={busyId !== null || categoryPeers.length === 0 || (replacementRequired && !replacementId)} onClick={() => void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", { action: "archive", version: status.version, replacementStatusId: replacementId || undefined }, status.id)}><Archive size={13} />Archive</button>
            </>}
          </>}
          {status.archivedAt && <button className="button ghost compact" type="button" disabled={busyId !== null} onClick={() => void request(`/api/settings/workflow-statuses/${encodeURIComponent(status.id)}`, "PATCH", { action: "restore", version: status.version }, status.id)}><ArchiveRestore size={13} />Restore</button>}
        </div>
      </article>
    );
  }

  return (
    <Modal onClose={() => busyId === null && onClose()} className="workflow-settings-modal" ariaLabel="Workflow status settings">
      <DialogHeader title="Workflow statuses" icon={<SlidersHorizontal size={17} />} onClose={() => busyId === null && onClose()} />
      <p className="dialog-copy">Statuses belong to your workflow. Their category is permanent because it controls task lifecycle timestamps.</p>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {loading ? <p className="dialog-copy">Loading workflow…</p> : <div className="workflow-status-list">{active.map(renderStatus)}</div>}
      <form className="workflow-status-create" onSubmit={create}>
        <input name="name" required maxLength={80} placeholder="New status" aria-label="New workflow status name" disabled={busyId !== null} />
        <select name="category" defaultValue="unstarted" aria-label="New workflow status category" disabled={busyId !== null}>{Object.entries(workflowCategoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <input className="workflow-color" type="color" name="color" defaultValue="#6b7280" aria-label="New workflow status color" disabled={busyId !== null} />
        <button className="button primary" disabled={busyId !== null}><Plus size={14} />Add</button>
      </form>
      {archived.length > 0 && <details className="workflow-archived"><summary>Archived statuses ({archived.length})</summary><div className="workflow-status-list">{archived.map(renderStatus)}</div></details>}
    </Modal>
  );
}

function ProjectDialog({ onClose, onSubmit, busy }: { onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void>; busy: boolean }) {
  const [name, setName] = useState("");
  const [taskCode, setTaskCode] = useState("PR");
  const [codeEdited, setCodeEdited] = useState(false);
  return <Modal onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); void onSubmit(Object.fromEntries(new FormData(event.currentTarget))); }}><DialogHeader title="Create project" icon={<FolderKanban size={17} />} onClose={onClose} /><div className="form-stack"><label><span>Project name</span><input name="name" required autoFocus value={name} onChange={(event) => { const next = event.target.value; setName(next); if (!codeEdited) setTaskCode(suggestProjectTaskCode(next)); }} /></label><label><span>Task code</span><input name="taskCode" required minLength={2} maxLength={3} pattern="[A-Z]{2,3}" value={taskCode} onChange={(event) => { setCodeEdited(true); setTaskCode(event.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3)); }} aria-describedby="project-code-help" /></label><small id="project-code-help" className="dialog-copy">2–3 Latin letters. The code locks after this Project receives its first Task.</small><label><span>Short summary</span><input name="summary" /></label><label><span>Target date</span><input name="targetDate" type="date" /></label></div><DialogFooter busy={busy} label="Create" disabled={!name.trim() || !/^[A-Z]{2,3}$/.test(taskCode)} /></form></Modal>;
}
function ReleaseDialog({ projects, initialProjectId, onClose, onSubmit, busy }: { projects: ProjectRecord[]; initialProjectId: string | null; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void>; busy: boolean }) { return <Modal onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); void onSubmit(Object.fromEntries(new FormData(event.currentTarget))); }}><DialogHeader title="Create release" icon={<Rocket size={17} />} onClose={onClose} /><div className="form-stack"><label><span>Release name</span><input name="name" required autoFocus placeholder="v1.0" /></label><label><span>Project</span><select name="projectId" required defaultValue={initialProjectId ?? ""}><option value="" disabled>Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label><span>Target date</span><input name="targetDate" type="date" /></label></div>{!projects.length && <p className="inline-note">Create a project before adding a release.</p>}<DialogFooter busy={busy} label="Create release" disabled={!projects.length} /></form></Modal>; }
function ViewDialog({ search, status, priority, layout, groupBy, scopeProjectId, onClose, onSubmit, busy }: { search: string; status: string; priority: Priority | "all"; layout: Layout; groupBy: ViewDisplay["groupBy"]; scopeProjectId: string | null; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void>; busy: boolean }) {
  const query: ViewQuery = {
    ...(search && { search }),
    ...(status !== "all" && { statusIds: [status] }),
    ...(priority !== "all" && { priorities: [priority] }),
  };
  const display: ViewDisplay = {
    layout,
    groupBy,
    orderBy: "manual",
    direction: "asc",
    showEmptyGroups: groupBy !== "status",
    visibleFields: ["priority", "project", "release", "dueDate", "assignee"],
  };
  return <Modal onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); void onSubmit({ name: values.name, query, display, scopeProjectId }); }}><DialogHeader title="Save as view" icon={<Zap size={17} />} onClose={onClose} /><div className="form-stack"><label><span>View name</span><input name="name" required autoFocus placeholder="e.g. Upcoming launch" /></label><label><span>Group by</span><select value={groupBy} disabled>{groupByOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div>{scopeProjectId && <p className="dialog-copy">This view is limited to the current project and inherits its access.</p>}<div className="view-summary"><span>{layout === "list" ? "List" : "Board"}</span><span>{Object.keys(query).length || "No"} active filters</span></div><DialogFooter busy={busy} label="Save view" /></form></Modal>;
}

function ShareDialog({ target, currentUser, users, collaborators, onClose, onShare, onRoleChange, onRevoke, onTransfer, busy }: { target: ShareTarget | null; currentUser: AppSnapshot["user"]; users: AppSnapshot["users"]; collaborators: AppSnapshot["collaborators"]; onClose: () => void; onShare: (input: Record<string, unknown>) => Promise<boolean>; onRoleChange: (grantId: string, permission: "manager" | "editor" | "viewer") => Promise<boolean>; onRevoke: (grantId: string) => Promise<boolean>; onTransfer: (projectId: string, targetUserId: string) => Promise<boolean>; busy: boolean }) {
  if (!target) return null;
  const grants = collaborators.filter((grant) => grant.resourceType === target.resourceType && grant.resourceId === target.resourceId);
  const assignableRoles = (["manager", "editor", "viewer"] as const).filter((role) => canAssignRole(target.accessRole, target.resourceType, role));
  const owner = target.ownerUserId === currentUser.id
    ? currentUser
    : users.find((user) => user.id === target.ownerUserId);
  const ownerName = owner?.displayName ?? "Project owner";
  const inheritanceCopy = target.inherited
    ? "Access applies to every task, release, and project-scoped saved view."
    : target.resourceType === "task"
      ? "Access applies only to this standalone task."
      : "A shared view still shows only tasks the person can already access.";

  return <Modal onClose={onClose}><form onSubmit={async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const ok = await onShare({
      resourceType: target.resourceType,
      resourceId: target.resourceId,
      email: String(values.get("email") ?? ""),
      permission: String(values.get("permission") ?? "viewer"),
    });
    if (ok) event.currentTarget.reset();
  }}><DialogHeader title={`Members & access · ${target.label}`} icon={<UsersRound size={17} />} onClose={onClose} /><p className="dialog-copy">Add a registered user by verified email. They must have signed in once; no email is sent. {inheritanceCopy}</p><div className="role-guide">{target.resourceType === "project" && <><span><b>Owner</b> has full control and can transfer ownership.</span><span><b>Manager</b> edits work and manages Editors/Viewers.</span></>}<span><b>Editor</b> creates, changes, moves, archives, and restores work.</span><span><b>Viewer</b> can only read.</span></div><div className="share-input"><input name="email" type="email" required placeholder="name@example.com" autoFocus /><select name="permission" defaultValue={assignableRoles.includes("editor") ? "editor" : assignableRoles[0]} aria-label="Role">{assignableRoles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select><button className="button primary" disabled={busy || assignableRoles.length === 0}>{busy ? "Adding…" : "Add"}</button></div><div className="access-list"><div className="access-row"><span className="avatar">{initials(ownerName)}</span><span><b>{ownerName}</b><small>{owner?.email ?? "Current project owner"}</small></span><em>Owner</em></div>{grants.map((grant) => {
    const manageable = canManageGrant(target.accessRole, target.resourceType, grant.permission);
    const roles = (["manager", "editor", "viewer"] as const).filter((role) => canAssignRole(target.accessRole, target.resourceType, role));
    return <div className="access-row" key={grant.grantId}><span className="avatar">{initials(grant.displayName)}</span><span><b>{grant.displayName}</b><small>{grant.email}</small></span><select aria-label={`Role for ${grant.displayName}`} value={grant.permission} disabled={busy || !manageable} onChange={(event) => void onRoleChange(grant.grantId, event.target.value as "manager" | "editor" | "viewer")}><option value={grant.permission}>{roleLabel(grant.permission)}</option>{roles.filter((role) => role !== grant.permission).map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select><div className="access-actions">{target.resourceType === "project" && target.accessRole === "owner" && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Transfer ownership of ${target.label} to ${grant.displayName}? You will become Manager.`)) void onTransfer(target.resourceId, grant.userId); }}>Make owner</button>}{manageable && <button type="button" disabled={busy} onClick={() => void onRevoke(grant.grantId)}>Remove</button>}</div></div>;
  })}</div></form></Modal>;
}

function roleLabel(role: "owner" | "manager" | "editor" | "viewer") {
  return role === "owner" ? "Owner" : role === "manager" ? "Manager" : role === "editor" ? "Editor" : "Viewer";
}

function SystemImportDialog({
  onClose,
  onDownloadCurrent,
  onBusyChange,
  onApplied,
}: {
  onClose: () => void;
  onDownloadCurrent: () => Promise<boolean>;
  onBusyChange: (busy: boolean) => void;
  onApplied: (result: AppliedSystemBackup) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [staged, setStaged] = useState<StagedSystemBackup | null>(null);
  const [rollbackDownloaded, setRollbackDownloaded] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [downloadingCurrent, setDownloadingCurrent] = useState(false);
  const [error, setError] = useState("");

  function setImportBusy(value: boolean) {
    setBusy(value);
    onBusyChange(value);
  }

  async function validateFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setImportBusy(true);
    setError("");
    try {
      if (file.size > 10_000_000) throw new Error("Backup file is larger than 10 MB");
      const response = await fetch("/api/admin/import/validate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-task-manager-action": "system-backup",
        },
        body: await file.text(),
      });
      const value = await response.json().catch(() => null) as StagedSystemBackup | { error?: string } | null;
      if (!response.ok || !value || "error" in value || !("importId" in value)) {
        throw new Error(value && "error" in value ? value.error ?? "Backup validation failed" : "Backup validation failed");
      }
      setStaged(value);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Backup validation failed");
    } finally {
      setImportBusy(false);
    }
  }

  async function applyImport() {
    if (!staged || confirmation !== "RESTORE" || !rollbackDownloaded) return;
    setImportBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/import", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-task-manager-action": "system-backup",
        },
        body: JSON.stringify({
          importId: staged.importId,
          sha256: staged.sha256,
          confirmation,
        }),
      });
      const value = await response.json().catch(() => null) as AppliedSystemBackup | { error?: string } | null;
      if (!response.ok || !value || "error" in value || !("applied" in value)) {
        throw new Error(value && "error" in value ? value.error ?? "System restore failed" : "System restore failed");
      }
      onApplied(value);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "System restore failed");
      setImportBusy(false);
    }
  }

  return (
    <Modal onClose={() => !busy && !downloadingCurrent && onClose()} className="system-import-modal">
      <DialogHeader title="Import system backup" icon={<Upload size={17} />} onClose={() => !busy && !downloadingCurrent && onClose()} />
      {!staged ? (
        <form onSubmit={validateFile}>
          <div className="system-import-body">
            <p>This replaces every user, identity, task, project, release, saved view, label, relation and access grant in this Site.</p>
            <label className="system-import-file">
              <span>Backup file</span>
              <input
                type="file"
                accept="application/json,.json"
                required
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setError("");
                }}
              />
              <small>Task Manager system backup, up to 10 MB.</small>
            </label>
            {error && <p className="system-import-error" role="alert">{error}</p>}
          </div>
          <div className="dialog-footer">
            <span>The live database is unchanged during validation</span>
            <button className="button primary" disabled={!file || busy}>{busy ? "Validating…" : "Validate backup"}</button>
          </div>
        </form>
      ) : (
        <div>
          <div className="system-import-body">
            <div className="system-import-valid"><Check size={15} /><span><b>Backup validated</b><small>Exported {longDateTime(staged.exportedAt)} · schema {staged.schemaVersion}</small></span></div>
            <dl className="system-import-counts">
              <div><dt>Users</dt><dd>{staged.counts.users}</dd></div>
              <div><dt>Tasks</dt><dd>{staged.counts.tasks}</dd></div>
              <div><dt>Projects</dt><dd>{staged.counts.projects}</dd></div>
              <div><dt>Releases</dt><dd>{staged.counts.releases}</dd></div>
              <div><dt>Saved views</dt><dd>{staged.counts.saved_views}</dd></div>
              <div><dt>Access grants</dt><dd>{staged.counts.access_grants}</dd></div>
            </dl>
            <div className="system-import-warning">
              <b>This operation cannot be undone in the app.</b>
              <span>Download the current state first. The replacement is atomic: either every table changes, or none do.</span>
            </div>
            <button
              className="button secondary system-import-download"
              type="button"
              disabled={busy || downloadingCurrent || rollbackDownloaded}
              onClick={() => {
                setDownloadingCurrent(true);
                setError("");
                void onDownloadCurrent().then((ok) => {
                  if (ok) setRollbackDownloaded(true);
                  else setError("Current backup download failed");
                  setDownloadingCurrent(false);
                });
              }}
            >
              {rollbackDownloaded ? <Check size={14} /> : <Download size={14} />}
              {rollbackDownloaded ? "Current backup downloaded" : downloadingCurrent ? "Downloading…" : "Download current backup"}
            </button>
            <label className="system-import-confirmation">
              <span>Type <b>RESTORE</b> to replace the live state</span>
              <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            {error && <p className="system-import-error" role="alert">{error}</p>}
          </div>
          <div className="dialog-footer">
            <button className="button ghost" type="button" disabled={busy} onClick={() => setStaged(null)}>Choose another file</button>
            <button className="button primary system-import-apply" type="button" disabled={busy || !rollbackDownloaded || confirmation !== "RESTORE"} onClick={() => void applyImport()}>{busy ? "Replacing…" : "Replace system state"}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function CodexSetupDialog({ onClose, initialMode = "desktop" }: { onClose: () => void; initialMode?: CodexSetupMode }) {
  const [mode, setMode] = useState<CodexSetupMode>(initialMode);
  const [copied, setCopied] = useState<"marketplace" | "commands" | null>(null);

  async function copySetup(value: string, target: "marketplace" | "commands") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
    } catch {
      setCopied(null);
    }
  }

  return (
    <Modal onClose={onClose} className="codex-setup-modal" ariaLabel="Connect Task Manager to Codex">
      <DialogHeader title="Connect Task Manager to Codex" icon={<CircleHelp size={17} />} onClose={onClose} />
      <div className="codex-setup-body">
        <div className="codex-setup-tabs" role="tablist" aria-label="Codex client">
          <button
            id="codex-setup-tab-desktop"
            type="button"
            role="tab"
            aria-selected={mode === "desktop"}
            aria-controls="codex-setup-desktop"
            className={mode === "desktop" ? "active" : ""}
            onClick={() => { setMode("desktop"); setCopied(null); }}
          >
            Codex Desktop
          </button>
          <button
            id="codex-setup-tab-cli"
            type="button"
            role="tab"
            aria-selected={mode === "cli"}
            aria-controls="codex-setup-cli"
            className={mode === "cli" ? "active" : ""}
            onClick={() => { setMode("cli"); setCopied(null); }}
          >
            Codex CLI
          </button>
        </div>

        {mode === "desktop" ? (
          <section id="codex-setup-desktop" role="tabpanel" aria-labelledby="codex-setup-tab-desktop">
            <ol className="codex-setup-steps">
              <SetupStep number={1} title="Open Plugins">
                In Codex Desktop, open <b>Plugins</b> and choose <b>Add → Add a marketplace</b>.
              </SetupStep>
              <SetupStep number={2} title="Add the marketplace">
                Paste this address into <b>Source</b>:
                <SetupCopyBlock
                  value={TASK_MANAGER_MARKETPLACE_URL}
                  label="Copy marketplace address"
                  copied={copied === "marketplace"}
                  onCopy={() => void copySetup(TASK_MANAGER_MARKETPLACE_URL, "marketplace")}
                />
                Leave <b>Git ref</b> and <b>Sparse paths</b> empty, then choose <b>Add marketplace</b>.
              </SetupStep>
              <SetupStep number={3} title="Install Task Manager">
                Open <b>Srez Marketplace</b>, choose <b>Task Manager</b>, then choose <b>Install</b>.
              </SetupStep>
              <SetupStep number={4} title="Connect your account">
                Complete setup or choose <b>Authenticate</b>. On the Task Manager consent page, check the account and choose <b>Connect</b>.
              </SetupStep>
              <SetupStep number={5} title="Start a new task">
                Ask Codex: <q>Show my tasks in Task Manager.</q>
              </SetupStep>
            </ol>
          </section>
        ) : (
          <section id="codex-setup-cli" role="tabpanel" aria-labelledby="codex-setup-tab-cli">
            <ol className="codex-setup-steps">
              <SetupStep number={1} title="Install the plugin">
                Run these commands in your terminal:
                <SetupCopyBlock
                  value={TASK_MANAGER_CLI_SETUP}
                  label="Copy CLI commands"
                  copied={copied === "commands"}
                  multiline
                  onCopy={() => void copySetup(TASK_MANAGER_CLI_SETUP, "commands")}
                />
              </SetupStep>
              <SetupStep number={2} title="Authenticate">
                The browser should open automatically. If it does not, enter <code>/plugins</code> in Codex, open <b>Task Manager</b>, and choose <b>Authenticate</b>. Check the account and choose <b>Connect</b>.
              </SetupStep>
              <SetupStep number={3} title="Start a new task">
                Back in Codex, enter <code>/new</code>, then ask: <q>Show my tasks in Task Manager.</q>
              </SetupStep>
            </ol>
          </section>
        )}

        <p className="codex-setup-note">
          Use the Task Manager account whose tasks you want Codex to access. No MCP URL, client ID, secret, or API token is required.
        </p>
      </div>
    </Modal>
  );
}

function SetupStep({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return <li><span className="codex-step-number">{number}</span><div><strong>{title}</strong><div className="codex-step-content">{children}</div></div></li>;
}

function SetupCopyBlock({ value, label, copied, multiline = false, onCopy }: { value: string; label: string; copied: boolean; multiline?: boolean; onCopy: () => void }) {
  return (
    <div className={`codex-copy-block ${multiline ? "multiline" : ""}`}>
      {multiline ? <pre><code>{value}</code></pre> : <code>{value}</code>}
      <button type="button" aria-label={label} title={label} onClick={onCopy}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}

function DialogHeader({ title, icon, onClose }: { title: string; icon: React.ReactNode; onClose: () => void }) { return <div className="dialog-header"><div>{icon}<h2>{title}</h2></div><button type="button" className="icon-button" aria-label={`Close ${title}`} onClick={onClose}><X size={15} /></button></div>; }
function DialogFooter({ busy, label, disabled }: { busy: boolean; label: string; disabled?: boolean }) { return <div className="dialog-footer"><span>Press Esc to close</span><button className="button primary" disabled={busy || disabled}>{busy ? "Saving…" : label}</button></div>; }
function Modal({ onClose, children, className = "", ariaLabel }: { onClose: () => void; children: React.ReactNode; className?: string; ariaLabel?: string }) { return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={ariaLabel}>{children}</div></div>; }

function WorkspaceOverviewSurface({
  data,
  statusMap,
  projectMap,
  onOpen,
  onOpenTask,
  onCreateTask,
  onCreateProject,
  onCreateRelease,
}: {
  data: AppSnapshot;
  statusMap: Map<string, WorkflowStatusRecord>;
  projectMap: Map<string, ProjectRecord>;
  onOpen: (surface: string, layout?: Layout) => void;
  onOpenTask: (taskId: string) => void;
  onCreateTask: () => void;
  onCreateProject: () => void;
  onCreateRelease: () => void;
}) {
  const openTasks = data.tasks.filter((task) => !task.archivedAt);
  const activeCount = openTasks.filter((task) => {
    const category = statusMap.get(task.statusId)?.category;
    return category === "unstarted" || category === "started";
  }).length;
  const backlogCount = openTasks.filter(
    (task) => statusMap.get(task.statusId)?.category === "backlog",
  ).length;
  const recentTasks = [...openTasks]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 5);
  const recentProjects = [...data.projects]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 4);
  const recentReleases = [...data.releases]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 4);
  const recentViews = data.views.slice(0, 4);
  const sharedProjects = data.projects.filter((project) => project.accessRole !== "owner");
  const sharedTasks = openTasks.filter(
    (task) => task.projectId === null && task.accessRole !== "owner",
  );
  const sharedViews = data.views.filter(
    (view) => view.scopeProjectId === null && view.accessRole !== "owner",
  );
  const sharedCount = sharedProjects.length + sharedTasks.length + sharedViews.length;
  const isEmpty =
    openTasks.length === 0 &&
    data.projects.length === 0 &&
    data.releases.length === 0 &&
    data.views.length === 0;
  const canCreateRelease = data.projects.some((project) => canEditContent(project.accessRole));

  return (
    <div className="workspace-overview">
      {isEmpty && (
        <section className="workspace-empty-banner" aria-labelledby="workspace-empty-title">
          <span className="workspace-empty-icon"><Boxes size={20} /></span>
          <div>
            <h2 id="workspace-empty-title">Your workspace is ready</h2>
            <p>Create a task or project to start organizing work. Every section will stay scoped to resources you can access.</p>
          </div>
          <div className="workspace-empty-actions">
            <button className="button primary" type="button" onClick={onCreateTask}><Plus size={14} />New task</button>
            <button className="button ghost" type="button" onClick={onCreateProject}><FolderKanban size={14} />New project</button>
          </div>
        </section>
      )}

      <section className="workspace-section" aria-labelledby="workspace-my-work">
        <WorkspaceSectionHeader
          id="workspace-my-work"
          title="My work"
          description="A compact view of the tasks available to you."
          href="/issues"
          label="All tasks"
          onOpen={() => onOpen("all")}
        />
        <div className="workspace-metrics">
          <WorkspaceMetric href="/issues/active" label="Active" value={activeCount} icon={<Zap size={16} />} onOpen={() => onOpen("active")} />
          <WorkspaceMetric href="/issues/backlog" label="Backlog" value={backlogCount} icon={<Inbox size={16} />} onOpen={() => onOpen("backlog")} />
          <WorkspaceMetric href="/projects" label="Projects" value={data.projects.length} icon={<FolderKanban size={16} />} onOpen={() => onOpen("projects")} />
          <WorkspaceMetric href="/shared" label="Shared with me" value={sharedCount} icon={<UsersRound size={16} />} onOpen={() => onOpen("shared")} />
        </div>
        <div className="workspace-panel workspace-recent-panel">
          <div className="workspace-panel-title"><h3>Recent tasks</h3><button className="button ghost compact" type="button" onClick={onCreateTask}><Plus size={13} />New task</button></div>
          {recentTasks.length ? (
            <ul className="workspace-record-list">
              {recentTasks.map((task) => {
                const status = statusMap.get(task.statusId);
                return (
                  <li key={task.id}>
                    <a href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, () => onOpenTask(task.id))}>
                      <span className="workspace-record-icon">{status ? <StatusIcon status={status} /> : <Circle size={13} />}</span>
                      <span className="workspace-record-copy"><b>{task.title}</b><small>{task.identifier} · {status?.name ?? "Unknown status"}</small></span>
                      <time dateTime={task.updatedAt}>{shortDate(task.updatedAt.slice(0, 10))}</time>
                      <ChevronRight size={14} aria-hidden="true" />
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : (
            <WorkspaceSectionEmpty title="No recent tasks" description="Tasks you create or can access will appear here." />
          )}
        </div>
      </section>

      <div className="workspace-overview-grid">
        <section className="workspace-section workspace-panel" aria-labelledby="workspace-projects">
          <WorkspaceSectionHeader id="workspace-projects" title="Projects" description="Owned and shared outcomes." href="/projects" label="All projects" onOpen={() => onOpen("projects")} />
          {recentProjects.length ? (
            <ul className="workspace-record-list">
              {recentProjects.map((project) => {
                const tasks = openTasks.filter((task) => task.projectId === project.id);
                return (
                  <li key={project.id}>
                    <a href={`/projects/${encodeURIComponent(project.publicId)}`} onClick={(event) => handleLocalLink(event, () => onOpen(`project:${project.id}`))}>
                      <span className="workspace-record-icon" style={{ color: project.color }}><FolderKanban size={15} /></span>
                      <span className="workspace-record-copy"><b>{project.name}</b><small>{tasks.length} tasks · {completion(tasks, data.statuses)}% complete</small></span>
                      {project.accessRole !== "owner" && <span className="status-badge">Shared</span>}
                      <ChevronRight size={14} aria-hidden="true" />
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : <WorkspaceSectionEmpty title="No projects yet" description="Create a project to group work around an outcome." />}
          <button className="workspace-create-link" type="button" onClick={onCreateProject}><Plus size={13} />Create project</button>
        </section>

        <section className="workspace-section workspace-panel" aria-labelledby="workspace-releases">
          <WorkspaceSectionHeader id="workspace-releases" title="Releases" description="Current delivery scopes with project context." href="/releases" label="All releases" onOpen={() => onOpen("releases")} />
          {recentReleases.length ? (
            <ul className="workspace-record-list">
              {recentReleases.map((release) => {
                const project = projectMap.get(release.projectId);
                const tasks = openTasks.filter((task) => task.releaseId === release.id);
                const href = project ? `/projects/${encodeURIComponent(project.publicId)}/releases/${encodeURIComponent(release.publicId)}` : "/releases";
                return (
                  <li key={release.id}>
                    <a href={href} onClick={(event) => handleLocalLink(event, () => onOpen(`release:${release.id}`))}>
                      <span className="workspace-record-icon"><Rocket size={15} /></span>
                      <span className="workspace-record-copy"><b>{formatReleaseName(project?.name, release.name)}</b><small>{tasks.length} tasks · {completion(tasks, data.statuses)}% complete</small></span>
                      <span className={`status-badge release-${release.status}`}>{release.status}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : <WorkspaceSectionEmpty title="No releases yet" description="Releases you can access will appear with their project context." />}
          {canCreateRelease && <button className="workspace-create-link" type="button" onClick={onCreateRelease}><Plus size={13} />Create release</button>}
        </section>

        <section className="workspace-section workspace-panel" aria-labelledby="workspace-views">
          <WorkspaceSectionHeader id="workspace-views" title="Saved views" description="Reusable perspectives over accessible tasks." href="/views" label="All views" onOpen={() => onOpen("views")} />
          {recentViews.length ? (
            <ul className="workspace-record-list">
              {recentViews.map((view) => (
                <li key={view.id}>
                  <a href={navigationPath({ surface: `view:${view.id}`, layout: view.display.layout, taskId: null }, data)} onClick={(event) => handleLocalLink(event, () => onOpen(`view:${view.id}`, view.display.layout))}>
                    <span className="workspace-record-icon"><Zap size={15} /></span>
                    <span className="workspace-record-copy"><b>{view.name}</b><small>{view.scopeProjectId ? "Project-scoped" : "Workspace view"} · {view.display.layout}</small></span>
                    {view.accessRole !== "owner" && <span className="status-badge">Shared</span>}
                    <ChevronRight size={14} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          ) : <WorkspaceSectionEmpty title="No saved views yet" description="Saved filters will appear here without copying tasks." />}
        </section>

        <section className="workspace-section workspace-panel" aria-labelledby="workspace-shared">
          <WorkspaceSectionHeader id="workspace-shared" title="Shared with me" description="Top-level resources other people granted you." href="/shared" label="Open shared" onOpen={() => onOpen("shared")} />
          {sharedCount ? (
            <div className="workspace-shared-summary">
              <WorkspaceSharedCount label="Projects" value={sharedProjects.length} />
              <WorkspaceSharedCount label="Tasks" value={sharedTasks.length} />
              <WorkspaceSharedCount label="Views" value={sharedViews.length} />
            </div>
          ) : <WorkspaceSectionEmpty title="Nothing shared yet" description="Resources shared with your account will appear here." />}
        </section>
      </div>
    </div>
  );
}

function WorkspaceSectionHeader({ id, title, description, href, label, onOpen }: { id: string; title: string; description: string; href: string; label: string; onOpen: () => void }) {
  return <header className="workspace-section-header"><div><h2 id={id}>{title}</h2><p>{description}</p></div><a href={href} onClick={(event) => handleLocalLink(event, onOpen)}>{label}<ChevronRight size={13} aria-hidden="true" /></a></header>;
}

function WorkspaceMetric({ href, label, value, icon, onOpen }: { href: string; label: string; value: number; icon: React.ReactNode; onOpen: () => void }) {
  return <a className="workspace-metric" href={href} onClick={(event) => handleLocalLink(event, onOpen)}><span className="workspace-metric-icon">{icon}</span><span><b>{value}</b><small>{label}</small></span><ChevronRight size={14} aria-hidden="true" /></a>;
}

function WorkspaceSectionEmpty({ title, description }: { title: string; description: string }) {
  return <div className="workspace-section-empty"><b>{title}</b><p>{description}</p></div>;
}

function WorkspaceSharedCount({ label, value }: { label: string; value: number }) {
  return <span><b>{value}</b><small>{label}</small></span>;
}

function ViewsSurface({ data, statusMap, onOpen }: { data: AppSnapshot; statusMap: Map<string, WorkflowStatusRecord>; onOpen: (surface: string, layout: Layout) => void }) { return <div className="entity-grid">{builtInViews.map((view) => <a className="entity-card" key={view.id} href={navigationPath({ surface: view.id, layout: "list", taskId: null }, data)} onClick={(event) => handleLocalLink(event, () => onOpen(view.id, "list"))}><div className="entity-icon"><Inbox size={18} /></div><div className="entity-card-copy"><div><h2>{view.label}</h2><span className="status-badge">Built-in</span></div><p>Workspace issue view</p><div className="progress-meta"><span>{taskCountForView(view.id, data, statusMap)} issues</span><span>List or board</span></div></div></a>)}{data.views.map((view) => <a className="entity-card" key={view.id} href={navigationPath({ surface: `view:${view.id}`, layout: view.display.layout, taskId: null }, data)} onClick={(event) => handleLocalLink(event, () => onOpen(`view:${view.id}`, view.display.layout))}><div className="entity-icon"><Zap size={18} /></div><div className="entity-card-copy"><div><h2>{view.name}</h2><span className="status-badge">Saved</span></div><p>{view.scopeProjectId ? "Project-scoped query" : "Workspace query"}</p><div className="progress-meta"><span>{view.display.layout}</span><span>Grouped by {view.display.groupBy}</span></div></div></a>)}</div>; }
function ProjectsSurface({ projects, tasks, statuses, onOpen, onCreate }: { projects: ProjectRecord[]; tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; onOpen: (id: string) => void; onCreate: () => void }) { if (!projects.length) return <EmptyState entity="project" onCreate={onCreate} />; return <div className="entity-grid">{projects.map((project) => { const scoped = tasks.filter((task) => task.projectId === project.id && !task.archivedAt); const progress = completion(scoped, statuses); return <a className="entity-card" key={project.id} href={`/projects/${encodeURIComponent(project.publicId)}`} onClick={(event) => handleLocalLink(event, () => onOpen(project.id))}><div className="entity-icon" style={{ background: `${project.color}20`, color: project.color }}><FolderKanban size={18} /></div><div className="entity-card-copy"><div><h2>{project.name}</h2><span className="status-badge">{project.status}</span></div><p>{project.summary || "No summary yet"}</p><div className="progress-meta"><span>{scoped.length} tasks</span>{project.targetDate && <span>Target {shortDate(project.targetDate)}</span>}</div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><small>{progress}% complete</small></div></a>; })}</div>; }
function ReleasesSurface({ releases, projects, tasks, statuses, onOpen, onCreate }: { releases: ReleaseRecord[]; projects: Map<string, ProjectRecord>; tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; onOpen: (id: string) => void; onCreate: () => void }) { if (!releases.length) return <EmptyState entity="release" onCreate={onCreate} />; return <div className="release-list">{releases.map((release) => { const scoped = tasks.filter((task) => task.releaseId === release.id && !task.archivedAt); const progress = completion(scoped, statuses); const project = projects.get(release.projectId); const releaseName = formatReleaseName(project?.name, release.name); return <a className="release-row" key={release.id} aria-label={releaseName} title={releaseName} href={project ? `/projects/${encodeURIComponent(project.publicId)}/releases/${encodeURIComponent(release.publicId)}` : "/releases"} onClick={(event) => handleLocalLink(event, () => onOpen(release.id))}><span className="release-icon"><Rocket size={16} /></span><span className="release-main"><b>{releaseName}</b></span><span className={`status-badge release-${release.status}`}>{release.status}</span><span className="release-progress"><i><em style={{ width: `${progress}%` }} /></i><small>{progress}%</small></span><span className="release-date">{release.targetDate ? shortDate(release.targetDate) : "No date"}</span></a>; })}</div>; }
function AdminSurface({ overview, timeZone }: { overview: AdminOverview; timeZone: string }) {
  return (
    <div className="admin-surface">
      <section className="admin-metrics" aria-label="System overview">
        <AdminMetric label="Registered users" value={overview.registeredUserCount} note="All accounts" icon={<UsersRound size={16} />} />
        <AdminMetric label="Active users" value={overview.activeUserCount} note="Last 7 days" icon={<Zap size={16} />} />
        <AdminMetric label="Tasks" value={overview.taskCount} note={`${overview.projectCount} projects`} icon={<Inbox size={16} />} />
        <AdminMetric label="Saved views" value={overview.viewCount} note={`${overview.releaseCount} releases`} icon={<Boxes size={16} />} />
        <AdminMetric label="Attachment objects" value={overview.attachmentObjectCount} note={`${formatAttachmentBytes(overview.attachmentObjectBytes)} · ${overview.orphanAttachmentObjectCount === null ? "orphan scan bounded" : `${overview.orphanAttachmentObjectCount} orphan`} · ${overview.stagingAttachmentObjectCount} staged · ${overview.pendingAttachmentCount} pending · ${overview.failedAttachmentCount} failed`} icon={<Paperclip size={16} />} />
      </section>
      <section className="admin-panel">
        <header>
          <div>
            <h2>Users</h2>
            <p>Last active reflects the latest authenticated request. Content activity is the latest owned record change. Times are shown in {timeZone}.</p>
          </div>
          <span className="status-badge">Live totals</span>
        </header>
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Registered</th>
                <th>Last active</th>
                <th>Content activity</th>
                <th>Tasks</th>
                <th>Projects</th>
                <th>Releases</th>
                <th>Views</th>
              </tr>
            </thead>
            <tbody>
              {overview.users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <span className="admin-user">
                      <span className="avatar">{initials(user.displayName)}</span>
                      <span><b>{user.displayName}</b><small>{user.email}</small></span>
                      {user.isAdmin && <span className="status-badge admin-badge">Admin</span>}
                    </span>
                  </td>
                  <td><time dateTime={user.registeredAt}>{zonedDateTime(user.registeredAt, timeZone)}</time></td>
                  <td><time dateTime={user.lastSeenAt}>{zonedDateTime(user.lastSeenAt, timeZone)}</time></td>
                  <td>{user.lastContentActivityAt ? <time dateTime={user.lastContentActivityAt}>{zonedDateTime(user.lastContentActivityAt, timeZone)}</time> : <span className="muted-value">—</span>}</td>
                  <td><span className="admin-task-count"><b>{user.taskCount}</b><small>{user.recentTaskCount} changed in 7d</small></span></td>
                  <td>{user.projectCount}</td>
                  <td>{user.releaseCount}</td>
                  <td>{user.viewCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
function AdminMetric({ label, value, note, icon }: { label: string; value: number; note: string; icon: React.ReactNode }) { return <article className="admin-metric"><span className="admin-metric-icon">{icon}</span><div><span>{label}</span><b>{value}</b><small>{note}</small></div></article>; }
function formatAttachmentBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`; if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`; return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`; }
function EmptyState({ entity = "task", onCreate }: { entity?: "task" | "project" | "release"; onCreate?: () => void }) { const labels = { task: ["No tasks here", "There is no work in this view yet."], project: ["No projects yet", "Create a project to group work around an outcome."], release: ["No releases yet", "There are no releases in this scope yet."] }; return <div className="empty-state"><div className="empty-illustration"><span /><span /><span /></div><h2>{labels[entity][0]}</h2><p>{labels[entity][1]}</p>{onCreate && <button className="button primary" onClick={onCreate}><Plus size={14} />Create {entity}</button>}</div>; }
function TaskSearchNotice({ status }: { status: "loading" | "error" }) { return <div className="empty-state" role="status"><Search size={22} /><h2>{status === "loading" ? "Searching tasks…" : "Search unavailable"}</h2><p>{status === "loading" ? "Looking across every task you can access." : "The search request failed. Change the query or try again."}</p></div>; }
function Peek({ task, status, project, onClose, onOpen }: { task: TaskRecord; status?: WorkflowStatusRecord; project?: ProjectRecord; onClose: () => void; onOpen: () => void }) { return <div className="peek"><header><span>{task.identifier}</span><div><a href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, onOpen)}>Open</a><button onClick={onClose}><X size={13} /></button></div></header><h2>{task.title}</h2><p>{task.description === null ? "Loading preview…" : task.description || "No description"}</p><footer>{status && <span><StatusIcon status={status} />{status.name}</span>}{project && <span><span className="project-dot" style={{ background: project.color }} />{project.name}</span>}<span><MessageSquare size={12} />{task.commentCount}</span></footer></div>; }
function BulkBar({ count, statuses, archiveAction, onStatus, onPriority, onArchive, onClose }: { count: number; statuses: WorkflowStatusRecord[]; archiveAction: ReturnType<typeof resolveArchiveBulkAction>; onStatus: (value: string) => void; onPriority: (value: Priority) => void; onArchive: () => void; onClose: () => void }) { return <div className="bulk-bar"><b>{count} selected</b><select defaultValue="" onChange={(event) => event.target.value && onStatus(event.target.value)}><option value="" disabled>Status…</option>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select><select defaultValue="" onChange={(event) => event.target.value && onPriority(event.target.value as Priority)}><option value="" disabled>Priority…</option>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select><button onClick={onArchive}>{archiveAction.archived ? <Archive size={14} /> : <ArchiveRestore size={14} />}{archiveAction.label}</button><button onClick={onClose}><X size={14} /></button></div>; }

function handleLocalLink(event: ReactMouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  navigate();
}

function defaultLayoutForSurface(surface: string, data: AppSnapshot): Layout {
  if (!surface.startsWith("view:")) return "list";
  return data.views.find((view) => view.id === surface.slice(5))?.display.layout ?? "list";
}

function surfaceBreadcrumbs(
  surface: string,
  data: AppSnapshot,
  view?: SavedViewRecord,
): BreadcrumbItem[] {
  const workspace: BreadcrumbItem = {
    label: "Workspace",
    surface: "workspace",
    layout: "list",
  };
  const current = (label: string): BreadcrumbItem => ({ label });
  const ancestor = (label: string, ancestorSurface: string, layout: Layout = "list"): BreadcrumbItem => ({
    label,
    surface: ancestorSurface,
    layout,
  });

  if (surface === "workspace") return [current("Workspace")];
  if (surface === "admin") return [workspace, current("Administration")];
  if (surface === "views") return [workspace, current("Views")];
  if (surface === "projects") return [workspace, current("Projects")];
  if (surface === "releases") return [workspace, current("Releases")];
  if (surface === "shared") return [workspace, current("Shared with me")];

  if (surface.startsWith("view:")) {
    return [
      workspace,
      ancestor("Views", "views"),
      current(view?.name ?? "Saved view"),
    ];
  }

  if (surface.startsWith("project-releases:")) {
    const project = data.projects.find(
      (item) => item.id === surface.slice("project-releases:".length),
    );
    if (!project) return [workspace, ancestor("Projects", "projects"), current("Releases")];
    return [
      workspace,
      ancestor("Projects", "projects"),
      ancestor(project.name, `project:${project.id}`),
      current("Releases"),
    ];
  }

  if (surface.startsWith("project:")) {
    const project = data.projects.find((item) => item.id === surface.slice(8));
    return [
      workspace,
      ancestor("Projects", "projects"),
      current(project?.name ?? "Project"),
    ];
  }

  if (surface.startsWith("release:")) {
    const release = data.releases.find((item) => item.id === surface.slice(8));
    const project = release
      ? data.projects.find((item) => item.id === release.projectId)
      : undefined;
    if (!release || !project) {
      return [workspace, ancestor("Releases", "releases"), current(release?.name ?? "Release")];
    }
    return [
      workspace,
      ancestor("Projects", "projects"),
      ancestor(project.name, `project:${project.id}`),
      ancestor("Releases", `project-releases:${project.id}`),
      current(formatReleaseName(project.name, release.name)),
    ];
  }

  const builtIn = builtInViews.find((item) => item.id === surface);
  return [workspace, current(builtIn?.label ?? "My tasks")];
}
function isCollectionSurface(surface: string) { return surface === "workspace" || surface === "admin" || surface === "views" || surface === "projects" || surface === "releases" || surface.startsWith("project-releases:"); }
function shareTarget(surface: string, activeTask: TaskRecord | null, data: AppSnapshot): ShareTarget | null {
  const projectTarget = (project: ProjectRecord | undefined): ShareTarget | null => {
    if (!project || (project.accessRole !== "owner" && project.accessRole !== "manager")) return null;
    return {
      resourceType: "project",
      resourceId: project.id,
      label: project.name,
      accessRole: project.accessRole,
      ownerUserId: project.ownerUserId,
      inherited: true,
    };
  };

  if (activeTask) {
    if (activeTask.projectId) {
      return projectTarget(data.projects.find((item) => item.id === activeTask.projectId));
    }
    return activeTask.accessRole === "owner"
      ? {
          resourceType: "task",
          resourceId: activeTask.id,
          label: activeTask.identifier,
          accessRole: activeTask.accessRole,
          ownerUserId: activeTask.ownerUserId,
          inherited: false,
        }
      : null;
  }
  if (surface.startsWith("project:")) {
    return projectTarget(data.projects.find((item) => item.id === surface.slice(8)));
  }
  if (surface.startsWith("project-releases:")) {
    return projectTarget(data.projects.find((item) => item.id === surface.slice("project-releases:".length)));
  }
  if (surface.startsWith("release:")) {
    const release = data.releases.find((item) => item.id === surface.slice(8));
    return projectTarget(release ? data.projects.find((item) => item.id === release.projectId) : undefined);
  }
  if (surface.startsWith("view:")) {
    const view = data.views.find((item) => item.id === surface.slice(5));
    if (!view) return null;
    if (view.scopeProjectId) {
      return projectTarget(data.projects.find((item) => item.id === view.scopeProjectId));
    }
    return view.accessRole === "owner"
      ? {
          resourceType: "saved_view",
          resourceId: view.id,
          label: view.name,
          accessRole: view.accessRole,
          ownerUserId: view.ownerUserId,
          inherited: false,
        }
      : null;
  }
  return null;
}
function statusGroupsForTasks(tasks: TaskRecord[], statuses: WorkflowStatusRecord[]) { const owners = new Set(tasks.map((task) => task.ownerUserId)); return statuses.filter((status) => !status.archivedAt && (owners.has(status.ownerUserId) || tasks.length === 0)).sort((a, b) => a.position - b.position); }
function sortTasks(tasks: TaskRecord[], display?: ViewDisplay) {
  const orderBy = display?.orderBy ?? "manual";
  const direction = display?.direction === "desc" ? -1 : 1;
  const priorityOrder: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  return [...tasks].sort((a, b) => {
    let comparison = 0;
    if (orderBy === "priority") comparison = priorityOrder[a.priority] - priorityOrder[b.priority];
    else if (orderBy === "created") comparison = a.createdAt.localeCompare(b.createdAt);
    else if (orderBy === "updated") comparison = a.updatedAt.localeCompare(b.updatedAt);
    else if (orderBy === "due") comparison = (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31");
    else if (orderBy === "title") comparison = a.title.localeCompare(b.title);
    else comparison = a.rank - b.rank;
    return comparison * direction || a.rank - b.rank;
  });
}
function displayLabel(value: string) { return value === "none" ? "No grouping" : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`; }
function taskCountForView(id: string, data: AppSnapshot, statusMap: Map<string, WorkflowStatusRecord>) { if (id === "archived") return data.tasks.filter((task) => task.archivedAt).length; if (id === "backlog") return data.tasks.filter((task) => !task.archivedAt && statusMap.get(task.statusId)?.category === "backlog").length; if (id === "active") return data.tasks.filter((task) => !task.archivedAt && ["unstarted", "started"].includes(statusMap.get(task.statusId)?.category ?? "")).length; return data.tasks.filter((task) => !task.archivedAt).length; }
function completion(tasks: TaskRecord[], statuses: WorkflowStatusRecord[]) { const statusMap = new Map(statuses.map((status) => [status.id, status])); const eligible = tasks.filter((task) => statusMap.get(task.statusId)?.category !== "canceled"); if (!eligible.length) return 0; return Math.round((eligible.filter((task) => statusMap.get(task.statusId)?.category === "completed").length / eligible.length) * 100); }
function toggleSet(current: Set<string>, value: string) { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; }
function suggestProjectTaskCode(value: string) { const words = value.toUpperCase().match(/[A-Z]+/g) ?? []; const initials = words.map((word) => word[0]).join("").slice(0, 3); if (initials.length >= 2) return initials; const compact = words.join("").slice(0, 3); return compact.length >= 2 ? compact : "PR"; }
function initials(value: string) { return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
function shortDate(value: string) { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00`)); }
function longDate(value: string) { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)); }
function longDateTime(value: string) { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function zonedDateTime(value: string, timeZone: string) { try { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(value)); } catch { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(value)); } }
function isOverdue(value: string, category: string) { return new Date(`${value}T23:59:59`) < new Date() && category !== "completed" && category !== "canceled"; }
