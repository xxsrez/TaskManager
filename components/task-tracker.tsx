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
  Database,
  Download,
  FolderKanban,
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
  PanelsTopLeft,
  Palette,
  Plus,
  Rocket,
  RotateCw,
  Save,
  Search,
  Share2,
  ShieldCheck,
  Settings2,
  SlidersHorizontal,
  Sun,
  Tag,
  Trash2,
  Upload,
  UserRound,
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
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { canAssignRole, canEditContent, canManageGrant } from "@/lib/access";
import {
  isProjectTaskCode,
  normalizeProjectTaskCodeDraft,
  PROJECT_TASK_CODE_INPUT_PATTERN,
  suggestProjectTaskCode,
} from "@/lib/project-task-code";
import {
  buildTaskGroups,
  canMoveTaskToGroup,
  keyboardReorderNeighbors,
  projectTaskGroupMove,
  rankBetweenNeighbors,
  reorderInsertionNeighbors,
  rollbackTaskGroupMove,
  shouldShowEmptyTaskGroups,
  taskGroupCreateDefaults,
  taskGroupValue,
  tasksInGroupOrder,
  type TaskGroup,
} from "@/lib/task-groups";
import {
  navigationHistoryState,
  navigationPath,
  navigationPathWithTemporaryFilter,
  parseNavigationPath,
  projectReleasesPath,
  resolveNavigationHistoryState,
  resolveNavigationTarget,
  taskPath,
  type Layout,
  type ResolvedNavigation,
  type SettingsSection,
} from "@/lib/navigation";
import {
  emptyGlobalSearchResponse,
  flattenGlobalSearchResults,
  mergeGlobalSearchResponses,
  nextGlobalSearchHighlight,
  resolveSearchShortcut,
  type GlobalSearchEntityType,
  type GlobalSearchResponse,
  type GlobalSearchResult,
} from "@/lib/global-search";
import { formatReleaseName } from "@/lib/release-presentation";
import {
  filterCatalogOptions,
  filterConditionValues,
  unavailableFilterLabel,
  unavailableFilterReferences,
} from "@/lib/filter-catalog";
import { selectRecentNavigation } from "@/lib/recent-navigation";
import { defaultViewDisplay, emptyViewQuery } from "@/lib/view-contract";
import {
  canonicalViewQuery,
  decodeTemporaryViewQuery,
  encodeTemporaryViewQuery,
  mergeViewQueries,
  taskMatchesViewQuery,
} from "@/lib/task-filter";
import {
  activeTaskQueryDependencies,
  authoritativeTaskQueryRefreshLimit,
  createTaskQueryRefreshCoordinator,
  mutationAffectsTaskQuery,
  reconcileTaskQueryMembership,
  taskMutationDependencies,
  taskQueryRequestToken,
  taskQueryResponseIsCurrent,
  type TaskQueryDependency,
  type TaskQueryRefreshCoordinator,
} from "@/lib/task-query-reconciliation";
import {
  applyWorkspaceSync,
  mergeTaskSummary,
} from "@/lib/workspace-sync-contract";
import {
  ALL_ACCESSIBLE_WORKSPACE_SCOPE,
  opaqueWorkspaceOwnerToken,
  parseWorkspaceScopeToken,
  resolveWorkspaceScopeMembership,
  sharedWithMeRoots,
} from "@/lib/workspace-scope";
import {
  mergeLoadedTask,
  mergeSearchTaskSummaries,
  mergeTaskDetailContext,
  nextTaskActivityInvalidationCursor,
  rebaseTaskDraft,
  reconcileTaskDetailAfterReset,
  reconcileTaskDetailFromSync,
  resizeTaskTitle,
  taskDraftSyncMode,
  taskDraftValueChanged,
  taskMutationVersion,
  taskNeedsDetailRefresh,
  type TaskDraftDirty,
} from "@/lib/task-detail-reconciliation";
import {
  useWorkspaceSyncCoordinator,
  type WorkspaceSyncCheckpoint,
} from "@/components/workspace-sync-coordinator";
import {
  type PublicAttachmentRecord,
  TaskAttachments,
  TaskDescriptionFileLink,
  TaskDescriptionImage,
} from "@/components/task-attachments";
import {
  bindStoredFileToTask,
  deleteStoredFile,
  getStoredFile,
  startStoredFileUpload,
  type PublicStoredFileRecord,
} from "@/lib/staged-file-upload";
import {
  applySystemBackupImport,
  backupJobIsTerminal,
  backupImportIsFullyValidated,
  canApplySystemBackupImport,
  createSystemBackupExport,
  getBackupJobStatus,
  getCurrentSystemBackupExport,
  readBackupCheckpoint,
  retainBackupCheckpoint,
  runSystemBackupJob,
  safeBackupMessage,
  safeSystemBackupDownloadUrl,
  systemBackupImportCheckpointKey,
  systemBackupMediaType,
  systemBackupSafetyExportCheckpointKey,
  SystemBackupClientError,
  uploadSystemBackupPackage,
  writeBackupCheckpoint,
  type SystemBackupCheckpoint,
} from "@/lib/system-backup-client";
import { TaskDescriptionEditor } from "@/components/task-description-editor";
import { CommentAttachmentAuthoring } from "@/components/comment-attachment-authoring";
import {
  CommentAttachmentMetadataProvider,
  useCommentAttachmentMetadata,
} from "@/components/comment-attachment-metadata";
import { ContextualActionMenu } from "@/components/contextual-action-menu";
import {
  DeletionUndoToast,
  RecoverableDeleteDialog,
  type RecoverableDeleteTarget,
} from "@/components/deletion-dialogs";
import { ProjectBackupManager } from "@/components/project-backup-manager";
import {
  DeletionConvergenceAlert,
  RecentlyDeletedManager,
} from "@/components/recently-deleted-manager";
import {
  convergeDeletionWorkspace,
  deletionErrorRequiresRefetch,
  fetchProjectDeletionPreview,
  fetchReleaseDeletionPreview,
  notifyRecentlyDeletedChanged,
  performDeletionAction,
  projectDeletionImpactLines,
  pruneDeletedEntityFromSnapshot,
  workspaceSyncAffectsRecentlyDeleted,
  type DeletionLifecycleResult,
  type ProjectActiveNavigationCounts,
} from "@/lib/deletion-client";
import {
  isTaskMarkdownEscaped,
  parseTaskAttachmentReferences,
  parseTaskFileToken,
  parseTaskImageLine,
  parseTaskMarkdownInlineTokens,
  parseTaskMarkdownLines,
} from "@/lib/task-description-format";
import { commentBodyPreview } from "@/lib/comment-rendering";
import {
  dispatchTaskKeyboardIntegrationCommand,
  keyboardCommandFor,
  moveTaskHighlight,
  reconcileTaskInteraction,
  selectTaskRange,
  toggleTaskSelection,
} from "@/lib/task-keyboard";
import {
  buildTaskArchiveCommand,
  resolveKeyboardContextualEntities,
  resolveContextualActions,
  resolveTaskTriggerContext,
  type ContextualActionContext,
  type ContextualActionEntity,
  type ResolvedContextualAction,
} from "@/lib/contextual-actions";
import {
  createUserPreferenceSaveQueue,
  type UserPreferenceChanges,
} from "@/lib/user-preference-save";
import type {
  AdminOverview,
  AccessRole,
  ActivityEventRecord,
  ActivityPage,
  AppSnapshot,
  CommentPage,
  CommentRecord,
  CommentThreadRecord,
  LabelGroupRecord,
  LabelRecord,
  Priority,
  ProjectRecord,
  ProjectStatus,
  ReleaseRecord,
  ReleaseStatus,
  SavedViewRecord,
  StatusCategory,
  SystemBackupJobStatus,
  TeamCatalog,
  TeamGrantRecord,
  TeamRecord,
  TaskRecord,
  TaskLabelAssignment,
  TaskDetailRecord,
  TaskRelationRecord,
  UserRecord,
  UserProfile,
  ViewFilterCondition,
  ViewFilterField,
  ViewFilterLabelGroupValue,
  ViewFilterOperator,
  ViewDisplay,
  ViewQuery,
  WorkflowStatusRecord,
  WorkspaceSyncResponse,
  WorkspaceCatalogKind,
  WorkspaceCatalogPage,
} from "@/lib/types";

export {
  mergeSearchTaskSummaries,
  mergeTaskDetailContext,
  nextTaskActivityInvalidationCursor,
  rebaseTaskDraft,
  reconcileTaskDetail,
  reconcileTaskDetailAfterReset,
  reconcileTaskDetailFromSync,
  resizeTaskTitle,
  taskDraftSyncMode,
  taskDraftValueChanged,
  taskMutationVersion,
  taskNeedsDetailRefresh,
} from "@/lib/task-detail-reconciliation";

type ShareTarget = {
  resourceType: "project" | "task" | "saved_view";
  resourceId: string;
  label: string;
  accessRole: AccessRole;
  ownerUserId: string;
  inherited: boolean;
  directTeamTask?: {
    resourceId: string;
    label: string;
    accessRole: AccessRole;
  };
};

type Dialog = "task" | "project" | "projectEdit" | "release" | "releaseEdit" | "view" | "viewEdit" | "share" | "systemExport" | "systemImport" | "codexSetup" | "workflowSettings" | "labelSettings" | "labelGroupSettings" | "bulkProject" | "bulkRelease" | null;
export type CodexSetupMode = "desktop" | "cli";
export type CodexSetupModeAction =
  | { type: "select"; mode: CodexSetupMode }
  | { type: "open_cli_fallback" };
type TaskCreateDefaults = Partial<{
  statusId: string;
  priority: Priority;
  assigneeUserId: string | null;
  projectId: string | null;
  releaseId: string | null;
  labelId: string | null;
}>;
export type TaskSearchState = {
  query: string;
  taskIds: string[];
  tasks: TaskRecord[];
  status: "ready" | "error";
  page?: {
    hasMore: boolean;
    next: { sortValue: string | number; rank: number; publicId: string } | null;
  } | null;
};

export type PendingProjectGroupMove = {
  taskId: string;
  targetProjectId: string;
};

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

const workspaceScopeHistoryKey = "taskManagerWorkspaceScope";

export function workspaceScopeStorageKey(userId: string) {
  return `tm-workspace-scope:${userId}`;
}

export function navigationStateWithWorkspaceScope(
  navigation: ResolvedNavigation,
  workspaceScope: string,
) {
  return {
    ...navigationHistoryState(navigation),
    [workspaceScopeHistoryKey]: workspaceScope,
  };
}

export function workspaceScopeFromHistory(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[workspaceScopeHistoryKey];
  return parseWorkspaceScopeToken(value)?.token ?? null;
}

export function scopedUiApiPath(path: string, workspaceScope: string) {
  if (!workspaceScope) return path;
  const url = new URL(path, "https://task-manager.invalid");
  url.searchParams.set("workspace_scope", workspaceScope);
  return `${url.pathname}${url.search}`;
}

export function taskDetailUiApiPath(taskId: string, workspaceScope: string) {
  return scopedUiApiPath(
    `/api/tasks/${encodeURIComponent(taskId)}`,
    workspaceScope,
  );
}

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
  { value: "label_group", label: "Label group" },
  { value: "none", label: "No grouping" },
];
const viewOrderOptions: Array<{ value: ViewDisplay["orderBy"]; label: string }> = [
  { value: "manual", label: "Manual" },
  { value: "priority", label: "Priority" },
  { value: "created", label: "Created" },
  { value: "updated", label: "Updated" },
  { value: "due", label: "Due date" },
  { value: "title", label: "Title" },
];
const viewFieldOptions: Array<{
  value: ViewDisplay["visibleFields"][number];
  label: string;
}> = [
  { value: "priority", label: "Priority" },
  { value: "project", label: "Project" },
  { value: "release", label: "Release" },
  { value: "dueDate", label: "Due date" },
  { value: "assignee", label: "Assignee" },
];

function toggleViewField(
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

type LabelMutationResult = {
  labelGroups?: LabelGroupRecord[];
  labels: LabelRecord[];
  taskLabels: TaskLabelAssignment[];
  taskIds: string[];
  canWrite?: boolean;
};
type MutationResult = AppSnapshot | { task: TaskRecord } | { taskUpdates: TaskRecord[] } | LabelMutationResult;

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
  if ("taskIds" in result && "taskLabels" in result) {
    const replaced = new Set(result.taskIds);
    return {
      ...current,
      tasks: current.tasks.map((task) =>
        replaced.has(task.id) ? invalidateTaskActivity(task) : task,
      ),
      labelGroups: mergeUnique(result.labelGroups ?? [], current.labelGroups ?? [], (group) => group.id),
      labels: mergeUnique(result.labels, current.labels, (label) => label.id),
      taskLabels: [
        ...current.taskLabels.filter((item) => !replaced.has(item.taskId)),
        ...result.taskLabels,
      ],
    };
  }
  if ("taskUpdates" in result) {
    const updates = new Map(result.taskUpdates.map((task) => [task.id, task]));
    return {
      ...current,
      tasks: current.tasks.map((task) => {
        const updated = updates.get(task.id);
        return updated ? mergeTaskMutation(task, updated) : task;
      }),
      workspaceMetrics: workspaceMetricsAfterTaskReplacements(
        current,
        result.taskUpdates,
      ),
    };
  }
  if (!("task" in result)) return result;
  return {
    ...current,
    tasks: current.tasks.map((task) =>
      task.id === result.task.id ? mergeTaskMutation(task, result.task) : task,
    ),
    workspaceMetrics: workspaceMetricsAfterTaskReplacements(current, [result.task]),
  };
}

function workspaceMetricsAfterTaskReplacements(
  current: AppSnapshot,
  replacements: readonly TaskRecord[],
) {
  if (!current.workspaceMetrics) return undefined;
  const statuses = new Map(current.statuses.map((status) => [status.id, status.category]));
  const currentTasks = new Map(current.tasks.map((task) => [task.id, task]));
  const counts = { ...current.workspaceMetrics.taskCounts };
  for (const replacement of replacements) {
    const retained = currentTasks.get(replacement.id);
    if (!retained) continue;
    for (const [key, value] of Object.entries(taskMetricContribution(
      retained,
      current.user.id,
      statuses,
    ))) {
      counts[key as keyof typeof counts] -= value;
    }
    for (const [key, value] of Object.entries(taskMetricContribution(
      replacement,
      current.user.id,
      statuses,
    ))) {
      counts[key as keyof typeof counts] += value;
    }
  }
  return { taskCounts: counts };
}

function taskMetricContribution(
  task: TaskRecord,
  currentUserId: string,
  statuses: ReadonlyMap<string, WorkflowStatusRecord["category"]>,
) {
  const category = statuses.get(task.statusId);
  const active = !task.archivedAt;
  return {
    all: active ? 1 : 0,
    active: active && (category === "unstarted" || category === "started") ? 1 : 0,
    backlog: active && category === "backlog" ? 1 : 0,
    mine: active && task.assigneeUserId === currentUserId ? 1 : 0,
    archived: task.archivedAt ? 1 : 0,
  };
}

function invalidateTaskActivity(
  task: TaskRecord,
  nonce = crypto.randomUUID(),
): TaskRecord {
  return {
    ...task,
    activityInvalidationCursor: `local:${task.version}:${task.updatedAt}:${nonce}`,
  };
}

function mergeTaskMutation(
  retained: TaskRecord | undefined,
  incoming: TaskRecord,
): TaskRecord {
  if (!retained) return incoming;
  if (
    retained.version > incoming.version ||
    (retained.version === incoming.version && retained.updatedAt > incoming.updatedAt)
  ) return retained;
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
  const activityInvalidationCursor = nextTaskActivityInvalidationCursor(
    retained,
    incoming,
  );
  if (activityInvalidationCursor !== undefined) {
    clientState.activityInvalidationCursor = activityInvalidationCursor;
  }
  if (retained.attachmentInvalidationCursor !== undefined) {
    clientState.attachmentInvalidationCursor = retained.attachmentInvalidationCursor;
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
  const projectCoverage = incoming.catalogCoverage?.projects ?? "complete";
  const releaseCoverage = incoming.catalogCoverage?.releases ?? "complete";
  const viewCoverage = incoming.catalogCoverage?.views ?? "complete";
  const mergedUserState = mergeDeferredUserState(current, incoming);

  return {
    ...incoming,
    ...mergedUserState,
    admin: incoming.isAdmin ? incoming.admin ?? current.admin : null,
    tasks: mergedTasks,
    projects: mergeResetCollection(
      current.projects,
      incoming.projects,
      projectCoverage === "complete" ? options.projectIdsAtRequest : undefined,
    ),
    releases: mergeResetCollection(
      current.releases,
      incoming.releases,
      releaseCoverage === "complete" ? options.releaseIdsAtRequest : undefined,
    ),
    views: mergeResetCollection(
      current.views,
      incoming.views,
      viewCoverage === "complete" ? options.viewIdsAtRequest : undefined,
    ),
    labelGroups: mergeUnique(incoming.labelGroups ?? [], current.labelGroups ?? [], (group) => group.id),
    labels: mergeUnique(incoming.labels, current.labels, (label) => label.id)
      .filter((label) => !options.taskIdsAtRequest ||
        incomingLabelIds.has(label.id) || retainedLabelIds.has(label.id)),
    taskLabels: mergedTaskLabels,
    relations: mergedRelations,
    navigationCollections: incoming.navigationCollections ?? current.navigationCollections,
    catalogCoverage: {
      projects: mergeCatalogCoverage(current.catalogCoverage?.projects, projectCoverage),
      releases: mergeCatalogCoverage(current.catalogCoverage?.releases, releaseCoverage),
      views: mergeCatalogCoverage(current.catalogCoverage?.views, viewCoverage),
    },
  };
}

function mergeCatalogCoverage(
  current: "bounded" | "complete" | undefined,
  incoming: "bounded" | "complete",
) {
  return current === "complete" || incoming === "complete" ? "complete" : "bounded";
}

export function snapshotProvesCollectionAbsence(
  snapshot: AppSnapshot,
  kind: WorkspaceCatalogKind,
) {
  return (snapshot.catalogCoverage?.[kind] ?? "complete") === "complete";
}

function mergeDeferredUserState(
  current: AppSnapshot,
  incoming: AppSnapshot,
): Pick<AppSnapshot, "user" | "userProfile"> {
  if (current.user.id !== incoming.user.id) {
    return { user: incoming.user, userProfile: incoming.userProfile };
  }

  const currentVersion = Number(
    current.userProfile?.user.version ?? current.user.version ?? 0,
  );
  const incomingVersion = Number(
    incoming.userProfile?.user.version ?? incoming.user.version ?? 0,
  );
  const currentVersionedUser = current.userProfile?.user ?? current.user;

  if (currentVersion > incomingVersion) {
    return {
      user: currentVersionedUser,
      userProfile: current.userProfile ?? (incoming.userProfile
        ? { ...incoming.userProfile, user: currentVersionedUser as UserProfile["user"] }
        : undefined),
    };
  }
  if (incomingVersion > currentVersion) {
    return { user: incoming.user, userProfile: incoming.userProfile };
  }

  const verifiedEmail = incoming.userProfile?.user.email ?? incoming.user.email;
  const user = { ...currentVersionedUser, email: verifiedEmail };
  const identities = incoming.userProfile?.identities ?? current.userProfile?.identities;
  return {
    user,
    userProfile: identities
      ? { user: user as UserProfile["user"], identities }
      : undefined,
  };
}

class ProfileRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function patchUserPreferences(
  version: number,
  changes: UserPreferenceChanges,
): Promise<UserProfile> {
  const response = await fetch("/api/settings/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version, ...changes }),
  });
  const value = await response.json() as UserProfile | { error: string };
  if (!response.ok || "error" in value) {
    throw new ProfileRequestError(
      "error" in value ? value.error : "Preference could not be saved",
      response.status,
    );
  }
  return value;
}

async function fetchUserProfile(): Promise<UserProfile> {
  const response = await fetch("/api/settings/profile", { cache: "no-store" });
  const value = await response.json() as UserProfile | { error: string };
  if (!response.ok || "error" in value) {
    throw new ProfileRequestError(
      "error" in value ? value.error : "Profile could not be refreshed",
      response.status,
    );
  }
  return value;
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

export async function fetchTaskSnapshot(
  fetcher: typeof fetch = fetch,
  workspaceScope?: string,
) {
  const path = workspaceScope
    ? `/api/bootstrap?workspace_scope=${encodeURIComponent(workspaceScope)}`
    : "/api/bootstrap";
  const response = await fetcher(path, { cache: "no-store" });
  const value = (await response.json()) as AppSnapshot | { error: string };
  if (!response.ok || "error" in value) {
    throw new Error("error" in value ? value.error : "Refresh failed");
  }
  return value;
}

export async function fetchCompleteWorkspaceCatalog(
  kind: WorkspaceCatalogKind,
  fetcher: typeof fetch = fetch,
  workspaceScope?: string,
): Promise<WorkspaceCatalogPage> {
  let cursor: string | null = null;
  let complete: WorkspaceCatalogPage = {
    kind,
    projects: [],
    releases: [],
    views: [],
    page: { hasMore: false, nextCursor: null },
    total: 0,
  };
  const seenCursors = new Set<string>();
  do {
    const parameters = new URLSearchParams({
      kind,
      limit: "50",
      order: "name",
      direction: "asc",
    });
    if (kind !== "releases") parameters.set("active_only", "1");
    if (workspaceScope) parameters.set("workspace_scope", workspaceScope);
    if (cursor) parameters.set("cursor", cursor);
    const response = await fetcher(`/api/catalog?${parameters}`, { cache: "no-store" });
    const page = await response.json() as WorkspaceCatalogPage | { error: string };
    if (!response.ok || "error" in page) {
      throw new Error("error" in page ? page.error : "Catalog could not be loaded");
    }
    if (page.kind !== kind) throw new Error("Catalog kind did not match the request");
    complete = {
      ...page,
      projects: mergeUnique(complete.projects, page.projects, (item) => item.id),
      releases: mergeUnique(complete.releases, page.releases, (item) => item.id),
      views: mergeUnique(complete.views, page.views, (item) => item.id),
    };
    cursor = page.page.hasMore ? page.page.nextCursor : null;
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error("Catalog pagination did not advance");
      seenCursors.add(cursor);
    }
  } while (cursor);
  return {
    ...complete,
    page: { hasMore: false, nextCursor: null },
  };
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

export function mergeWorkspaceCatalogPage(
  current: AppSnapshot,
  page: WorkspaceCatalogPage,
): AppSnapshot {
  return {
    ...current,
    projects: mergeUnique(page.projects, current.projects, (item) => item.id),
    releases: mergeUnique(page.releases, current.releases, (item) => item.id),
    views: mergeUnique(page.views, current.views, (item) => item.id),
  };
}

const builtInViews = [
  { id: "mine", label: "My tasks" },
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

type ContextualMenuState = {
  context: ContextualActionContext;
  x: number;
  y: number;
  restoreFocus: HTMLElement | null;
};

type RecoverableDeletionState = RecoverableDeleteTarget & {
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

export function nextAccountMenuFocusIndex(
  key: string,
  currentIndex: number,
  itemCount: number,
): number | null {
  if (itemCount <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowDown") return currentIndex < 0 ? 0 : (currentIndex + 1) % itemCount;
  if (key === "ArrowUp") return currentIndex < 0 ? itemCount - 1 : (currentIndex - 1 + itemCount) % itemCount;
  return null;
}

export function AccountMenu({
  user,
  isAdmin,
  onNavigate,
}: {
  user: UserRecord;
  isAdmin: boolean;
  onNavigate: (event: ReactMouseEvent<HTMLAnchorElement>, surface: string) => void;
}) {
  const accountMenuFirstItemRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => accountMenuFirstItemRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex = nextAccountMenuFocusIndex(event.key, currentIndex, items.length);
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  return (
    <div className="account-menu" role="menu" aria-label="Account menu" tabIndex={-1} onKeyDown={handleKeyDown}>
      <a
        className="account-menu-user account-menu-identity"
        href="/settings/profile"
        role="menuitem"
        ref={accountMenuFirstItemRef}
        aria-label={`Open profile settings for ${user.displayName}, ${user.email}`}
        onClick={(event) => onNavigate(event, "settings:profile")}
      >
        <span className="avatar">{initials(user.displayName)}</span>
        <span>
          <b>{user.displayName}</b>
          <small>{user.email}</small>
          <small className="account-provider">Signed in with ChatGPT</small>
        </span>
      </a>
      <div className="account-menu-separator" role="separator" />
      <a
        className="account-menu-item"
        href="/workspace"
        role="menuitem"
        onClick={(event) => onNavigate(event, "workspace")}
      >
        <Boxes size={14} />
        <span>Workspace</span>
      </a>
      <a
        className="account-menu-item"
        href="/settings/profile"
        role="menuitem"
        onClick={(event) => onNavigate(event, "settings:profile")}
      >
        <Settings2 size={14} />
        <span>Settings</span>
      </a>
      {isAdmin && (
        <a
          className="account-menu-item"
          href="/admin"
          role="menuitem"
          onClick={(event) => onNavigate(event, "admin")}
        >
          <ShieldCheck size={14} />
          <span>Administration</span>
        </a>
      )}
    </div>
  );
}

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
  const initialWorkspaceScopeToken = initialData.workspaceScope?.selectedToken ?? "";
  const [workspaceScopeToken, setWorkspaceScopeToken] = useState(initialWorkspaceScopeToken);
  const workspaceScopeTokenRef = useRef(initialWorkspaceScopeToken);
  const [workspaceScopeLoading, setWorkspaceScopeLoading] = useState(false);
  const [resourceOwnerLabel, setResourceOwnerLabel] = useState<string | null>(null);
  const [surface, setSurface] = useState(initialNavigation.surface);
  const [layout, setLayout] = useState<Layout>(initialNavigation.layout);
  const [search, setSearch] = useState("");
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [taskSearch, setTaskSearch] = useState<TaskSearchState | null>(null);
  const taskSearchRef = useRef<TaskSearchState | null>(null);
  const taskQueryKeyRef = useRef("");
  const taskQueryGenerationRef = useRef(0);
  const [pendingProjectMove, setPendingProjectMove] = useState<PendingProjectGroupMove | null>(null);
  const [taskQueryPaging, setTaskQueryPaging] = useState(false);
  const [taskDetail, setTaskDetail] = useState<TaskDetailRecord | null>(null);
  const [forcedTaskDetailId, setForcedTaskDetailId] = useState<string | null>(null);
  const [temporaryQuery, setTemporaryQuery] = useState<ViewQuery>(() => emptyViewQuery());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [createDefaults, setCreateDefaults] = useState<TaskCreateDefaults>({});
  const [displayOverrides, setDisplayOverrides] = useState<Partial<Record<string, ViewDisplay>>>({});
  const [activeTaskId, setActiveTaskId] = useState<string | null>(
    initialNavigation.taskId,
  );
  const [peekTaskId, setPeekTaskId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [highlightedTaskId, setHighlightedTaskId] = useState<string | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const previousKeyboardTaskIdsRef = useRef<string[]>([]);
  const [contextualMenu, setContextualMenu] = useState<ContextualMenuState | null>(null);
  const [recoverableDeletion, setRecoverableDeletion] = useState<RecoverableDeletionState | null>(null);
  const [deletionUndo, setDeletionUndo] = useState<DeletionUndoState | null>(null);
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [deletionConvergenceError, setDeletionConvergenceError] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    initialData.user.sidebarPreference === "collapsed",
  );
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
  const taskQueryRefreshCoordinatorRef = useRef<TaskQueryRefreshCoordinator | null>(null);
  if (!taskQueryRefreshCoordinatorRef.current) {
    taskQueryRefreshCoordinatorRef.current = createTaskQueryRefreshCoordinator(
      (refresh) => {
        taskQueryGenerationRef.current += 1;
        return window.setTimeout(refresh, 120);
      },
      (handle) => window.clearTimeout(handle),
      () => setRefreshEpoch((current) => current + 1),
    );
  }
  const pullRefreshFlight = useRef<Promise<AppSnapshot> | null>(null);
  const [systemBackupBusy, setSystemBackupBusy] = useState(false);
  const [systemExportStatus, setSystemExportStatus] = useState<SystemBackupJobStatus | null>(null);
  const systemExportStatusRef = useRef<SystemBackupJobStatus | null>(null);
  const [systemExportRunning, setSystemExportRunning] = useState(false);
  const [systemExportWaitingForNetwork, setSystemExportWaitingForNetwork] = useState(false);
  const [systemExportError, setSystemExportError] = useState("");
  const systemExportFlightRef = useRef<Promise<void> | null>(null);
  const systemExportStartFlightRef = useRef<Promise<void> | null>(null);
  const systemExportDiscoveryFlightRef = useRef<Promise<SystemBackupJobStatus | null | undefined> | null>(null);
  const systemExportDriveRef = useRef<(status: SystemBackupJobStatus) => Promise<void>>(
    async () => undefined,
  );
  const systemExportAbortRef = useRef<AbortController | null>(null);
  const systemExportRetryTimerRef = useRef<number | null>(null);
  const systemExportDiscoveryStartedRef = useRef(false);
  const systemExportMountedRef = useRef(true);
  const [error, setError] = useState("");
  const [catalogPages, setCatalogPages] = useState<Partial<Record<
    WorkspaceCatalogKind,
    WorkspaceCatalogPage
  >>>({});
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  const [recentlyDeletedEpoch, setRecentlyDeletedEpoch] = useState(0);
  const [catalogOrder, setCatalogOrder] = useState<"updated" | "name">("updated");
  const [catalogDirection, setCatalogDirection] = useState<"asc" | "desc">("desc");
  const completeCatalogFlights = useRef<Partial<Record<
    WorkspaceCatalogKind,
    Promise<WorkspaceCatalogPage>
  >>>({});
  const [theme, setTheme] = useState<"system" | "light" | "dark">(
    initialData.user.theme ?? "system",
  );
  const preferenceSaveQueueRef = useRef<ReturnType<typeof createUserPreferenceSaveQueue> | null>(null);

  const updateSystemExportStatus = useCallback((next: SystemBackupJobStatus | null) => {
    systemExportStatusRef.current = next;
    setSystemExportStatus(next);
  }, []);

  const driveSystemExport = useCallback((initial: SystemBackupJobStatus) => {
    if (backupJobIsTerminal(initial)) {
      updateSystemExportStatus(initial);
      return Promise.resolve();
    }
    if (systemExportFlightRef.current) return systemExportFlightRef.current;
    if (systemExportRetryTimerRef.current !== null) {
      window.clearTimeout(systemExportRetryTimerRef.current);
      systemExportRetryTimerRef.current = null;
    }
    const controller = new AbortController();
    systemExportAbortRef.current = controller;
    setSystemExportRunning(true);
    setSystemExportWaitingForNetwork(false);
    setSystemExportError("");
    setSystemBackupBusy(true);
    const operation = runSystemBackupJob(initial, {
      signal: controller.signal,
      requestTimeoutMs: 25_000,
      stepDelayMs: 250,
      maximumNetworkRetries: 3,
      retryBaseDelayMs: 500,
      retryMaximumDelayMs: 4_000,
      onConnectionState: setSystemExportWaitingForNetwork,
      onProgress: updateSystemExportStatus,
    }).then((result) => {
      updateSystemExportStatus(result);
      if (result.status === "failed" || result.status === "expired") {
        setSystemExportError("Экспорт остановлен до готового файла. Начните новый экспорт.");
      }
    }).catch((requestError: unknown) => {
      if (!systemExportMountedRef.current || controller.signal.aborted) return;
      const resumable = requestError instanceof SystemBackupClientError
        && (requestError.code === "network" || requestError.code === "stopped");
      setSystemExportWaitingForNetwork(resumable);
      setSystemExportError(resumable
        ? "Сейчас нет устойчивой связи. Серверное задание сохранено и будет продолжено в этой вкладке."
        : requestError instanceof Error
          ? requestError.message
          : "Не удалось продолжить экспорт.");
      const current = systemExportStatusRef.current;
      if (resumable && current && !backupJobIsTerminal(current)) {
        systemExportRetryTimerRef.current = window.setTimeout(() => {
          systemExportRetryTimerRef.current = null;
          const saved = systemExportStatusRef.current;
          if (saved && !backupJobIsTerminal(saved)) void systemExportDriveRef.current(saved);
        }, 5_000);
      }
    }).finally(() => {
      if (systemExportFlightRef.current === operation) systemExportFlightRef.current = null;
      if (systemExportAbortRef.current === controller) systemExportAbortRef.current = null;
      if (systemExportMountedRef.current) {
        setSystemExportRunning(false);
        setSystemBackupBusy(false);
      }
    });
    systemExportFlightRef.current = operation;
    return operation;
  }, [updateSystemExportStatus]);
  systemExportDriveRef.current = driveSystemExport;

  const startSystemExport = useCallback((fresh = false) => {
    if (systemExportStartFlightRef.current) return systemExportStartFlightRef.current;
    setSystemBackupBusy(true);
    setSystemExportWaitingForNetwork(false);
    setSystemExportError("");
    const operation = createSystemBackupExport(fetch, { fresh }).then(async (created) => {
      updateSystemExportStatus(created);
      await driveSystemExport(created);
    }).catch((requestError: unknown) => {
      if (!systemExportMountedRef.current) return;
      setSystemExportWaitingForNetwork(
        requestError instanceof SystemBackupClientError && requestError.code === "network",
      );
      setSystemExportError(requestError instanceof Error ? requestError.message : "Не удалось начать экспорт.");
    }).finally(() => {
      if (systemExportStartFlightRef.current === operation) systemExportStartFlightRef.current = null;
      if (systemExportMountedRef.current && !systemExportFlightRef.current) setSystemBackupBusy(false);
    });
    systemExportStartFlightRef.current = operation;
    return operation;
  }, [driveSystemExport, updateSystemExportStatus]);

  const discoverCurrentSystemExport = useCallback(() => {
    if (systemExportDiscoveryFlightRef.current) return systemExportDiscoveryFlightRef.current;
    const operation = getCurrentSystemBackupExport().then((current) => {
      if (!systemExportMountedRef.current) return current;
      updateSystemExportStatus(current);
      setSystemExportWaitingForNetwork(false);
      setSystemExportError("");
      if (current && !backupJobIsTerminal(current)) void driveSystemExport(current);
      return current;
    }).catch((requestError: unknown) => {
      if (systemExportMountedRef.current) {
        setSystemExportWaitingForNetwork(
          requestError instanceof SystemBackupClientError && requestError.code === "network",
        );
        setSystemExportError(requestError instanceof Error
          ? requestError.message
          : "Не удалось проверить незавершённый экспорт.");
      }
      return undefined;
    }).finally(() => {
      if (systemExportDiscoveryFlightRef.current === operation) {
        systemExportDiscoveryFlightRef.current = null;
      }
    });
    systemExportDiscoveryFlightRef.current = operation;
    return operation;
  }, [driveSystemExport, updateSystemExportStatus]);

  const openSystemExport = useCallback(() => {
    setDialog("systemExport");
    const current = systemExportStatusRef.current;
    if (current?.status === "failed" || current?.status === "expired") {
      void startSystemExport();
      return;
    }
    if (current) {
      if (!backupJobIsTerminal(current)) void driveSystemExport(current);
      return;
    }
    void discoverCurrentSystemExport().then((discovered) => {
      if (discovered === null && systemExportMountedRef.current) void startSystemExport();
    });
  }, [discoverCurrentSystemExport, driveSystemExport, startSystemExport]);

  useEffect(() => {
    systemExportMountedRef.current = true;
    return () => {
      systemExportMountedRef.current = false;
      systemExportAbortRef.current?.abort();
      if (systemExportRetryTimerRef.current !== null) {
        window.clearTimeout(systemExportRetryTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (surface !== "admin" || !data.admin || systemExportDiscoveryStartedRef.current) return;
    systemExportDiscoveryStartedRef.current = true;
    void discoverCurrentSystemExport();
  }, [data.admin, discoverCurrentSystemExport, surface]);
  const [viewReferenceTime] = useState(() => Date.now());
  const searchRef = useRef<HTMLInputElement>(null);
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const mobileActionsRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const displayTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileMenuRef = useRef<HTMLButtonElement>(null);
  const mobileSidebarCloseRef = useRef<HTMLButtonElement>(null);
  const globalSearchReturnFocus = useRef<HTMLElement | null>(null);
  const temporaryQueryUrlReady = useRef(false);
  const taskReturnPath = useRef(
    navigationPath({ ...initialNavigation, taskId: null }, initialData),
  );
  if (!preferenceSaveQueueRef.current) {
    preferenceSaveQueueRef.current = createUserPreferenceSaveQueue({
      current: currentUserProfile,
      save: patchUserPreferences,
      refresh: fetchUserProfile,
      isConflict: (requestError) =>
        requestError instanceof ProfileRequestError && requestError.status === 409,
      optimistic: applyOptimisticPreferences,
      apply: applyUserProfile,
      error: (requestError) => setError(
        requestError instanceof Error ? requestError.message : "Preference could not be saved",
      ),
    });
  }

  const captureSyncCheckpoint = useCallback((): WorkspaceSyncCheckpoint => ({
    taskIds: new Set(dataRef.current.tasks.map((task) => task.id)),
    projectIds: new Set(dataRef.current.projects.map((project) => project.id)),
    releaseIds: new Set(dataRef.current.releases.map((release) => release.id)),
    viewIds: new Set(dataRef.current.views.map((view) => view.id)),
  }), []);
  const ensureCompleteCatalogs = useCallback(async (
    kinds: readonly WorkspaceCatalogKind[],
  ) => {
    const requestedWorkspaceScope = workspaceScopeTokenRef.current;
    const pages = await Promise.all(kinds.map(async (kind) => {
      if ((dataRef.current.catalogCoverage?.[kind] ?? "complete") === "complete") {
        return null;
      }
      let flight = completeCatalogFlights.current[kind];
      if (!flight) {
        flight = fetchCompleteWorkspaceCatalog(
          kind,
          fetch,
          workspaceScopeTokenRef.current,
        ).finally(() => {
          delete completeCatalogFlights.current[kind];
        });
        completeCatalogFlights.current[kind] = flight;
      }
      return flight;
    }));
    if (workspaceScopeTokenRef.current !== requestedWorkspaceScope) return;
    const loaded = pages.filter((page): page is WorkspaceCatalogPage => page !== null);
    if (!loaded.length) return;
    setData((current) => {
      const next = loaded.reduce((result, page) => {
        const merged = mergeWorkspaceCatalogPage(result, page);
        return {
          ...merged,
          catalogCoverage: {
            ...(merged.catalogCoverage ?? {
              projects: "bounded",
              releases: "bounded",
              views: "bounded",
            }),
            [page.kind]: "complete",
          },
        };
      }, current);
      dataRef.current = next;
      return next;
    });
  }, []);
  const openDialogWithCatalog = useCallback(async (
    nextDialog: Exclude<Dialog, null>,
    kinds: readonly WorkspaceCatalogKind[],
  ) => {
    setCatalogLoading(true);
    setError("");
    try {
      await ensureCompleteCatalogs(kinds);
      setDialog(nextDialog);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Catalog could not be loaded");
    } finally {
      setCatalogLoading(false);
    }
  }, [ensureCompleteCatalogs]);
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
      navigationStateWithWorkspaceScope(
        { surface: "workspace", layout: "list", taskId: null },
        workspaceScopeTokenRef.current,
      ),
      "",
      taskReturnPath.current,
    );
  }, []);
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
    if (response.changes.tasks.upsert.length || removedTaskIds.size) {
      setTaskSearch((current) => reconcileTaskSearch(current, response.changes));
      taskQueryGenerationRef.current += 1;
      setRefreshEpoch((current) => current + 1);
    }
    if (
      response.changes.projects.upsert.length || removedProjectIds.size ||
      response.changes.releases.upsert.length || removedReleaseIds.size ||
      response.changes.views.upsert.length || removedViewIds.size
    ) {
      setCatalogEpoch((current) => current + 1);
    }
    if (workspaceSyncAffectsRecentlyDeleted(response)) {
      setRecentlyDeletedEpoch((current) => current + 1);
    }
    const activeTaskWasRemoved = activeTaskId !== null && removedTaskIds.has(activeTaskId);
    const surfaceWasRemoved =
      (surface.startsWith("project:") && removedProjectIds.has(surface.slice(8))) ||
      (surface.startsWith("project-releases:") &&
        removedProjectIds.has(surface.slice("project-releases:".length))) ||
      (surface.startsWith("release:") && removedReleaseIds.has(surface.slice(8))) ||
      (surface.startsWith("view:") && unavailableViewIds.has(surface.slice(5)));
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
    taskQueryGenerationRef.current += 1;
    setRefreshEpoch((current) => current + 1);
    setCatalogEpoch((current) => current + 1);
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
        !incoming.projects.some(
          (project) => project.id === surface.slice("project-releases:".length),
        )) ||
      (surface.startsWith("release:") &&
        snapshotProvesCollectionAbsence(incoming, "releases") &&
        checkpoint.releaseIds.has(surface.slice(8)) &&
        !incoming.releases.some((release) => release.id === surface.slice(8))) ||
      (surface.startsWith("view:") &&
        snapshotProvesCollectionAbsence(incoming, "views") &&
        checkpoint.viewIds.has(surface.slice(5)) &&
        !incoming.views.some(
          (view) => view.id === surface.slice(5) && !view.archivedAt,
        ));
    if (surfaceWasRemoved) returnToWorkspaceAfterRemoval();
  }, [activeTaskId, returnToWorkspaceAfterRemoval, surface]);

  useWorkspaceSyncCoordinator({
    cursor: data.syncCursor,
    workspaceScope: workspaceScopeToken,
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
  const sidebarViews = useMemo(() => {
    const activeId = surface.startsWith("view:") ? surface.slice(5) : null;
    const active = activeId ? data.views.find((view) => view.id === activeId) : undefined;
    return selectRecentNavigation(
      mergeUnique(
        active ? [active] : [],
        data.navigationCollections?.views.items ?? data.views,
        (view) => view.id,
      ),
      { activeId },
    );
  }, [data.navigationCollections?.views.items, data.views, surface]);
  const sidebarProjects = useMemo(() => {
    const activeId = surface.startsWith("project:")
      ? surface.slice(8)
      : surface.startsWith("project-releases:")
        ? surface.slice("project-releases:".length)
        : null;
    const active = activeId ? data.projects.find((project) => project.id === activeId) : undefined;
    return selectRecentNavigation(
      mergeUnique(
        active ? [active] : [],
        data.navigationCollections?.projects.items ?? data.projects,
        (project) => project.id,
      ),
      { activeId },
    );
  }, [data.navigationCollections?.projects.items, data.projects, surface]);
  const sidebarReleases = useMemo(() => {
    const activeId = surface.startsWith("release:") ? surface.slice(8) : null;
    const active = activeId ? data.releases.find((release) => release.id === activeId) : undefined;
    return selectRecentNavigation(
      mergeUnique(
        active ? [active] : [],
        data.navigationCollections?.releases.items ?? data.releases,
        (release) => release.id,
      ),
      { activeId },
    );
  }, [data.navigationCollections?.releases.items, data.releases, surface]);
  const userMap = useMemo(
    () => new Map([...data.users, data.user].map((user) => [user.id, user])),
    [data.user, data.users],
  );

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    workspaceScopeTokenRef.current = workspaceScopeToken;
  }, [workspaceScopeToken]);

  useEffect(() => {
    const projected = data.workspaceScope?.selectedToken;
    if (!projected || projected === workspaceScopeTokenRef.current) return;
    workspaceScopeTokenRef.current = projected;
    setWorkspaceScopeToken(projected);
    window.localStorage.setItem(workspaceScopeStorageKey(data.user.id), projected);
    const resolved: ResolvedNavigation = { surface, layout, taskId: activeTaskId };
    window.history.replaceState(
      navigationStateWithWorkspaceScope(resolved, projected),
      "",
      window.location.href,
    );
  }, [activeTaskId, data.user.id, data.workspaceScope?.selectedToken, layout, surface]);

  useEffect(() => {
    if (!initialData.workspaceScope || initialNavigation.taskId ||
      initialNavigation.surface.startsWith("project:") ||
      initialNavigation.surface.startsWith("project-releases:") ||
      initialNavigation.surface.startsWith("release:") ||
      initialNavigation.surface.startsWith("view:")) return;
    const persisted = window.localStorage.getItem(
      workspaceScopeStorageKey(initialData.user.id),
    );
    const membership = resolveWorkspaceScopeMembership(
      persisted,
      initialData.workspaceScope.options,
      initialData.workspaceScope.options.find((option) => option.current)?.token ??
        initialData.workspaceScope.selectedToken,
    );
    if (!persisted || membership.fallback || membership.token === workspaceScopeTokenRef.current) {
      return;
    }
    void loadWorkspaceScopeSnapshot(membership.token, "replace", false);
    // Initial hydration intentionally uses the server-projected option set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    taskSearchRef.current = taskSearch;
  }, [taskSearch]);

  useEffect(() => {
    if (surface !== "shared") return;
    void ensureCompleteCatalogs(["projects", "views"]).catch((requestError: unknown) => {
      setError(requestError instanceof Error
        ? requestError.message
        : "Shared resources could not be loaded");
    });
  }, [ensureCompleteCatalogs, surface, workspaceScopeToken]);

  useEffect(() => () => taskQueryRefreshCoordinatorRef.current?.cancel(), []);

  useEffect(() => {
    const kind = surface === "projects" || surface === "releases" || surface === "views"
      ? surface
      : null;
    if (!kind) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setCatalogLoading(true);
      const parameters = new URLSearchParams({ kind, limit: "30" });
      if (workspaceScopeToken) parameters.set("workspace_scope", workspaceScopeToken);
      parameters.set("order", catalogOrder);
      parameters.set("direction", catalogDirection);
      if (search.trim()) parameters.set("search", search.trim());
      void fetch(`/api/catalog?${parameters}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          const value = await response.json() as WorkspaceCatalogPage | { error: string };
          if (!response.ok || "error" in value) {
            throw new Error("error" in value ? value.error : "Catalog could not be loaded");
          }
          setCatalogPages((current) => ({ ...current, [kind]: value }));
          setData((current) => mergeWorkspaceCatalogPage(current, value));
        })
        .catch((requestError: unknown) => {
          if (requestError instanceof DOMException && requestError.name === "AbortError") return;
          setError(requestError instanceof Error ? requestError.message : "Catalog could not be loaded");
        })
        .finally(() => {
          if (!controller.signal.aborted) setCatalogLoading(false);
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [catalogDirection, catalogEpoch, catalogOrder, search, surface, workspaceScopeToken]);

  useEffect(() => {
    if (catalogEpoch === 0) return;
    const controller = new AbortController();
    void Promise.all(
      (["projects", "releases", "views"] as const).map(async (kind) => {
        const parameters = new URLSearchParams({
          kind,
          limit: "3",
          active_only: "1",
        });
        if (workspaceScopeToken) parameters.set("workspace_scope", workspaceScopeToken);
        const response = await fetch(`/api/catalog?${parameters}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const value = await response.json() as WorkspaceCatalogPage | { error: string };
        if (!response.ok || "error" in value) {
          throw new Error("error" in value ? value.error : "Navigation could not be refreshed");
        }
        return value;
      }),
    )
      .then((pages) => {
        setData((current) => pages.reduce(
          (next, page) => ({
            ...next,
            navigationCollections: {
              ...(next.navigationCollections ?? {
                projects: { items: [], total: 0, hasMore: false },
                releases: { items: [], total: 0, hasMore: false },
                views: { items: [], total: 0, hasMore: false },
              }),
              [page.kind]: {
                items: page[page.kind],
                total: page.total,
                hasMore: page.page.hasMore,
              },
            },
          }),
          current,
        ));
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError(requestError instanceof Error ? requestError.message : "Navigation could not be refreshed");
      });
    return () => controller.abort();
  }, [catalogEpoch, workspaceScopeToken]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(`tm-theme:${data.user.id}`, theme);
  }, [data.user.id, theme]);

  useEffect(() => {
    window.localStorage.setItem(
      `tm-sidebar:${data.user.id}`,
      sidebarCollapsed ? "collapsed" : "expanded",
    );
  }, [data.user.id, sidebarCollapsed]);

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
      navigationStateWithWorkspaceScope(
        initialNavigation,
        workspaceScopeTokenRef.current,
      ),
      "",
      window.location.href,
    );
  }, [initialNavigation]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const decoded = decodeTemporaryViewQuery(
        new URL(window.location.href).searchParams.get("filter"),
      );
      const { search: urlSearch, ...filterOnly } = decoded;
      setTemporaryQuery(filterOnly);
      setSearch(urlSearch ?? "");
      temporaryQueryUrlReady.current = true;
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!temporaryQueryUrlReady.current) return;
    const encoded = encodeTemporaryViewQuery({
      ...canonicalViewQuery(temporaryQuery),
      ...(search.trim() ? { search } : {}),
    });
    const url = new URL(window.location.href);
    if (encoded) url.searchParams.set("filter", encoded);
    else url.searchParams.delete("filter");
    window.history.replaceState(window.history.state, "", url);
  }, [search, temporaryQuery]);

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
      const parameters = new URLSearchParams();
      if (workspaceScopeToken) parameters.set("workspace_scope", workspaceScopeToken);
      const bootstrapPath = parameters.size ? `/api/bootstrap?${parameters}` : "/api/bootstrap";
      void fetch(bootstrapPath, { cache: "no-store", signal: controller.signal })
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
  }, [captureSyncCheckpoint, taskWindowLoading, workspaceScopeToken]);

  const activeSavedView = surface.startsWith("view:")
    ? data.views.find((view) => view.id === surface.slice(5) && !view.archivedAt)
    : undefined;
  const savedDisplay = useMemo(
    () => activeSavedView?.display ?? defaultViewDisplay(),
    [activeSavedView],
  );
  const currentDisplay = useMemo(() => ({
    ...savedDisplay,
    ...displayOverrides[surface],
    layout,
  }), [displayOverrides, layout, savedDisplay, surface]);
  const currentGroupBy = currentDisplay.groupBy;
  const currentDisplayDependencies = viewDisplayDependencies(currentDisplay);
  const canonicalTemporaryQuery = useMemo(
    () => canonicalViewQuery(temporaryQuery),
    [temporaryQuery],
  );
  const temporaryViewQuery = useMemo(() => ({
    ...canonicalTemporaryQuery,
    ...(search.trim() ? { search } : {}),
  }), [canonicalTemporaryQuery, search]);
  const currentViewQuery = useMemo(
    () => mergeViewQueries(activeSavedView?.query, temporaryViewQuery),
    [activeSavedView, temporaryViewQuery],
  );
  const taskQueryDisplay = useMemo(() => ({
    ...defaultViewDisplay(),
    orderBy: currentDisplay.orderBy,
    direction: currentDisplay.direction,
  }), [currentDisplay.direction, currentDisplay.orderBy]);
  const taskQueryKey = JSON.stringify({
    query: currentViewQuery,
    surface,
    scopeProjectId: activeSavedView?.scopeProjectId ?? null,
    display: taskQueryDisplay,
    workspaceScope: workspaceScopeToken || null,
  });
  taskQueryKeyRef.current = taskQueryKey;
  const activeTaskQueryDependencySet = useMemo(
    () => activeTaskQueryDependencies({
      query: currentViewQuery,
      surface,
      scopeProjectId: activeSavedView?.scopeProjectId ?? null,
      display: currentDisplay,
    }),
    [activeSavedView?.scopeProjectId, currentDisplay, currentViewQuery, surface],
  );
  const searchNeedle = (currentViewQuery.search ?? "").trim().toLowerCase();

  useEffect(() => {
    if (isCollectionSurface(surface)) return;
    const generation = taskQueryGenerationRef.current + 1;
    taskQueryGenerationRef.current = generation;
    const token = taskQueryRequestToken(taskQueryKey, generation);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const loaded = taskSearchRef.current?.query === taskQueryKey
        ? taskSearchRef.current.taskIds.length
        : 0;
      const request = JSON.parse(taskQueryKey) as Record<string, unknown>;
      void fetch("/api/tasks/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...request,
          limit: authoritativeTaskQueryRefreshLimit(loaded),
        }),
        signal: controller.signal,
      })
        .then(async (response) => {
          const value = (await response.json()) as
            | { taskIds: string[]; tasks: TaskRecord[]; page: TaskSearchState["page"] }
            | { error: string };
          if (!response.ok || "error" in value) {
            throw new Error("error" in value ? value.error : "Task search failed");
          }
          if (
            controller.signal.aborted ||
            !taskQueryResponseIsCurrent(
              token,
              taskQueryKeyRef.current,
              taskQueryGenerationRef.current,
            )
          ) return;
          setTaskSearch({
            query: taskQueryKey,
            taskIds: value.taskIds,
            tasks: value.tasks,
            status: "ready",
            page: value.page,
          });
        })
        .catch((requestError: unknown) => {
          if (requestError instanceof DOMException && requestError.name === "AbortError") {
            return;
          }
          if (!taskQueryResponseIsCurrent(
            token,
            taskQueryKeyRef.current,
            taskQueryGenerationRef.current,
          )) return;
          setTaskSearch((current) =>
            current?.query === taskQueryKey && current.status === "ready"
              ? current
              : {
                  query: taskQueryKey,
                  taskIds: [],
                  tasks: [],
                  status: "error",
                  page: null,
                },
          );
          setError(requestError instanceof Error ? requestError.message : "Task search failed");
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [refreshEpoch, surface, taskQueryKey]);

  function refreshTaskList() {
    return runSingleFlight(pullRefreshFlight, async () => {
      setPullRefreshing(true);
      setPullRefreshError("");
      const checkpoint = captureSyncCheckpoint();
      try {
        const incoming = await fetchTaskSnapshot(fetch, workspaceScopeTokenRef.current);
        setData((current) => mergeDeferredSnapshot(current, incoming, {
          taskIdsAtRequest: checkpoint.taskIds,
          projectIdsAtRequest: checkpoint.projectIds,
          releaseIdsAtRequest: checkpoint.releaseIds,
          viewIdsAtRequest: checkpoint.viewIds,
        }));
        setTaskWindowLoading(false);
        taskQueryGenerationRef.current += 1;
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

  async function refreshAfterDeletionMutation() {
    // Catalog pages are independent lazy responses and can otherwise keep a
    // restored Project/Release/View hidden. Invalidate before the network read
    // so a failed bootstrap cannot retain privileged stale catalog controls.
    setCatalogPages({});
    setCatalogEpoch((current) => current + 1);
    setRecentlyDeletedEpoch((current) => current + 1);
    const incoming = await refreshTaskList();
    return incoming;
  }

  const deletionFetcher: typeof fetch = (input, init) => {
    if (typeof input !== "string") return fetch(input, init);
    return fetch(scopedUiApiPath(input, workspaceScopeTokenRef.current), init);
  };

  async function convergeDeletionState() {
    const convergence = await convergeDeletionWorkspace(refreshAfterDeletionMutation);
    if (convergence.ok) {
      setDeletionConvergenceError("");
      return true;
    }
    setDeletionConvergenceError(convergence.message);
    return false;
  }

  async function selfHealStaleDeletionState() {
    setRecoverableDeletion(null);
    setDeletionUndo(null);
    await convergeDeletionState();
  }

  async function retryDeletionConvergence() {
    if (deletionBusy) return;
    setDeletionBusy(true);
    await convergeDeletionState();
    setDeletionBusy(false);
  }

  async function openRecoverableDelete(entity: ContextualActionEntity) {
    if (deletionBusy) return;
    setError("");
    if (entity.kind === "release") {
      setDeletionBusy(true);
      try {
        const preview = await fetchReleaseDeletionPreview(
          entity.id,
          entity.version,
          deletionFetcher,
        );
        setRecoverableDeletion({
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
        setDialog(null);
      } catch (requestError) {
        if (deletionErrorRequiresRefetch(requestError)) {
          await selfHealStaleDeletionState();
        }
        setError(requestError instanceof Error ? requestError.message : "Release deletion impact could not be loaded");
      } finally {
        setDeletionBusy(false);
      }
      return;
    }

    if (entity.kind === "task") {
      const task = dataRef.current.tasks.find((item) => item.id === entity.id);
      if (!task) return;
      const project = dataRef.current.projects.find((item) => item.id === task.projectId);
      setDialog(null);
      setRecoverableDeletion({
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
      setDeletionBusy(true);
      try {
        const preview = await fetchProjectDeletionPreview(
          project.id,
          project.version,
          deletionFetcher,
        );
        setRecoverableDeletion({
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
        setDialog(null);
      } catch (requestError) {
        if (deletionErrorRequiresRefetch(requestError)) {
          await selfHealStaleDeletionState();
        }
        setError(requestError instanceof Error ? requestError.message : "Project deletion impact could not be loaded");
      } finally {
        setDeletionBusy(false);
      }
      return;
    }

    const view = dataRef.current.views.find((item) => item.id === entity.id);
    if (!view || view.archivedAt) return;
    setDialog(null);
    setRecoverableDeletion({
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
    setCatalogPages({});
    setSelected((current) => {
      if (type === "task") return new Set([...current].filter((taskId) => taskId !== id));
      if (type !== "project") return current;
      const retained = [...current].filter((taskId) => next.tasks.some((task) => task.id === taskId));
      return new Set(retained);
    });
    setTaskSearch((current) => {
      if (!current) return current;
      const tasks = current.tasks
        .filter((task) => type === "task" ? task.id !== id : type !== "project" || task.projectId !== id)
        .map((task) => type === "release" && task.releaseId === id ? { ...task, releaseId: null } : task)
        .map((task) => type === "task" && task.parentTaskId === id ? { ...task, parentTaskId: null } : task);
      const taskIds = new Set(tasks.map((task) => task.id));
      return { ...current, tasks, taskIds: current.taskIds.filter((taskId) => taskIds.has(taskId)) };
    });
    setTaskDetail((current) => current && next.tasks.some((task) => task.id === current.task.id) ? current : null);
    setForcedTaskDetailId(null);
    setPeekTaskId((current) => current && next.tasks.some((task) => task.id === current) ? current : null);
    setRefreshEpoch((current) => current + 1);
    setCatalogEpoch((current) => current + 1);
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

  async function deleteRecoverably() {
    const target = recoverableDeletion;
    if (!target || deletionBusy) return;
    setDeletionBusy(true);
    setError("");
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
      navigateAfterRecoverableDelete(target);
      applyImmediateDeletionPrune(target);
      setRecoverableDeletion(null);
      setDeletionUndo({
        type: target.type,
        id: target.id,
        version: entity.version,
        label: target.displayName,
      });
      notifyRecentlyDeletedChanged();
      await convergeDeletionState();
    } catch (requestError) {
      if (deletionErrorRequiresRefetch(requestError)) {
        await selfHealStaleDeletionState();
      }
      setError(requestError instanceof Error ? requestError.message : "Deletion failed");
    } finally {
      setDeletionBusy(false);
    }
  }

  async function undoRecoverableDelete() {
    const undo = deletionUndo;
    if (!undo || deletionBusy) return;
    setDeletionBusy(true);
    setError("");
    try {
      const result = await performDeletionAction(
        undo.type,
        undo.id,
        "restore_deleted",
        undo.version,
        { fetcher: deletionFetcher },
      );
      if (!("entity" in result)) throw new Error("Restore response was incomplete");
      setDeletionUndo(null);
      notifyRecentlyDeletedChanged();
      await convergeDeletionState();
    } catch (requestError) {
      if (deletionErrorRequiresRefetch(requestError)) {
        await selfHealStaleDeletionState();
      }
      setError(requestError instanceof Error ? requestError.message : "Restore failed");
    } finally {
      setDeletionBusy(false);
    }
  }

  async function loadMoreFilteredTasks() {
    const next = taskSearch?.query === taskQueryKey ? taskSearch.page?.next : null;
    if (!next || taskQueryPaging) return;
    const token = taskQueryRequestToken(
      taskQueryKey,
      taskQueryGenerationRef.current,
    );
    const expectedCursor = JSON.stringify(next);
    setTaskQueryPaging(true);
    setError("");
    try {
      const request = JSON.parse(taskQueryKey) as Record<string, unknown>;
      const response = await fetch("/api/tasks/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, after: next, limit: 500 }),
      });
      const value = await response.json() as
        | { taskIds: string[]; tasks: TaskRecord[]; page: TaskSearchState["page"] }
        | { error: string };
      if (!response.ok || "error" in value) {
        throw new Error("error" in value ? value.error : "Could not load more tasks");
      }
      if (!taskQueryResponseIsCurrent(
        token,
        taskQueryKeyRef.current,
        taskQueryGenerationRef.current,
      )) return;
      setTaskSearch((current) => {
        if (
          !current ||
          current.query !== taskQueryKey ||
          JSON.stringify(current.page?.next ?? null) !== expectedCursor ||
          !taskQueryResponseIsCurrent(
            token,
            taskQueryKeyRef.current,
            taskQueryGenerationRef.current,
          )
        ) return current;
        return {
          ...current,
          taskIds: [...new Set([...current.taskIds, ...value.taskIds])],
          tasks: mergeSearchTaskSummaries(current.tasks, value.tasks),
          page: value.page,
        };
      });
    } catch (requestError) {
      if (!taskQueryResponseIsCurrent(
        token,
        taskQueryKeyRef.current,
        taskQueryGenerationRef.current,
      )) return;
      setError(requestError instanceof Error ? requestError.message : "Could not load more tasks");
    } finally {
      setTaskQueryPaging(false);
    }
  }

  const taskPool = useMemo(
    () => taskSearch?.query === taskQueryKey
      ? mergeSearchTaskSummaries(data.tasks, taskSearch.tasks)
      : data.tasks,
    [data.tasks, taskQueryKey, taskSearch],
  );

  const visibleTasks = useMemo(() => {
    let tasks = taskPool;
    const authoritativeIds = taskSearch?.query === taskQueryKey && taskSearch.status === "ready"
      ? new Set(taskSearch.taskIds)
      : null;
    if (authoritativeIds) {
      return sortTasks(tasks.filter((task) => authoritativeIds.has(task.id)), currentDisplay);
    }
    if (surface === "mine") {
      tasks = tasks.filter((task) => task.assigneeUserId === data.user.id);
    } else if (surface === "shared") {
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
    const archivedCondition = canonicalViewQuery(currentViewQuery).conditions.some(
      (condition) => condition.field === "archived",
    );
    if (surface === "mine") {
      tasks = tasks.filter((task) => !task.archivedAt);
    } else if (!archivedCondition) {
      tasks = tasks.filter((task) => surface === "archived" ? task.archivedAt : !task.archivedAt);
    }
    if (activeSavedView?.scopeProjectId) {
      tasks = tasks.filter(
        (task) => task.projectId === activeSavedView.scopeProjectId,
      );
    }
    tasks = tasks.filter((task) => taskMatchesViewQuery(task, currentViewQuery, {
      statuses: data.statuses,
      taskLabels: data.taskLabels,
      relations: data.relations,
      tasks: data.tasks,
      referenceTime: new Date(viewReferenceTime),
      timezone: data.user.timezone,
    }));
    if (searchNeedle) tasks = tasks.filter((task) => taskMatchesSearch(task, searchNeedle, null));
    return sortTasks(tasks, currentDisplay);
  }, [
    activeSavedView,
    currentViewQuery,
    data.relations,
    data.statuses,
    data.taskLabels,
    data.tasks,
    data.user.id,
    data.user.timezone,
    taskPool,
    searchNeedle,
    statusMap,
    surface,
    taskSearch,
    taskQueryKey,
    viewReferenceTime,
    currentDisplay,
  ]);
  const taskSearchStatus = visibleTasks.length === 0
    ? taskSearch?.query !== taskQueryKey
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
    if (!activeTaskId) return;
    void ensureCompleteCatalogs(["projects", "releases"]).catch((requestError: unknown) => {
      setError(requestError instanceof Error ? requestError.message : "Catalog could not be loaded");
    });
  }, [activeTaskId, ensureCompleteCatalogs]);

  useEffect(() => {
    if (!taskDetailRequestId) return;
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(
        taskDetailUiApiPath(taskDetailRequestId, workspaceScopeToken),
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
  }, [activeTaskId, returnToWorkspaceAfterRemoval, taskDetailRequestId, workspaceScopeToken]);
  const activeDetailsData = activeTask && taskDetail?.task.id === activeTask.id
    ? mergeTaskDetailContext(data, { ...taskDetail, task: activeTask })
    : data;
  const taskPropertyCatalogReady =
    (data.catalogCoverage?.projects ?? "complete") === "complete" &&
    (data.catalogCoverage?.releases ?? "complete") === "complete";
  const selectedTasks = [...selected]
    .map((id) => data.tasks.find((task) => task.id === id))
    .filter(Boolean) as TaskRecord[];
  const selectedTaskVersions = Object.fromEntries(
    selectedTasks.map((task) => [task.id, taskMutationVersion(task)]),
  );
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
      (data.navigationCollections?.projects.total ?? data.projects.length) +
      (data.navigationCollections?.releases.total ?? data.releases.length) +
      (data.navigationCollections?.views.total ?? data.views.length)
    : surface === "views"
    ? builtInViews.length + (catalogPages.views?.total ?? data.navigationCollections?.views.total ?? data.views.length)
    : surface === "projects"
      ? catalogPages.projects?.total ?? data.navigationCollections?.projects.total ?? data.projects.length
    : surface === "releases"
      ? catalogPages.releases?.total ?? data.navigationCollections?.releases.total ?? data.releases.length
    : surface === "admin" && data.admin
      ? data.admin.registeredUserCount
    : surface === "shared"
      ? sharedWithMeRoots(data).projects.length + sharedWithMeRoots(data).views.length
    : surface === "teams"
      ? ""
    : surface.startsWith("settings:")
      ? ""
    : projectReleaseSurfaceId
      ? scopedReleases.length
      : visibleTasks.length;
  const contextProjectRecord = contextProject
    ? data.projects.find((project) => project.id === contextProject)
    : undefined;
  const resourceOwnerUserId = activeTask
    ? activeTask.projectId
      ? data.projects.find((project) => project.id === activeTask.projectId)?.ownerUserId
      : activeTask.ownerUserId
    : contextProjectRecord?.ownerUserId ?? (
        activeSavedView?.scopeProjectId
          ? data.projects.find((project) => project.id === activeSavedView.scopeProjectId)?.ownerUserId
          : activeSavedView?.ownerUserId
      );
  useEffect(() => {
    let current = true;
    if (!resourceOwnerUserId || !data.workspaceScope) {
      queueMicrotask(() => {
        if (current) setResourceOwnerLabel(null);
      });
      return () => { current = false; };
    }
    void opaqueWorkspaceOwnerToken(resourceOwnerUserId).then((token) => {
      if (!current) return;
      setResourceOwnerLabel(
        data.workspaceScope?.options.find((option) => option.token === token)?.label ?? null,
      );
    });
    return () => { current = false; };
  }, [data.workspaceScope, resourceOwnerUserId]);
  const surfaceContextualEntity = contextReleaseRecord
    ? releaseContextualEntity(contextReleaseRecord)
    : activeSavedView
      ? viewContextualEntity(activeSavedView)
      : surface.startsWith("project:") && contextProjectRecord
        ? projectContextualEntity(contextProjectRecord)
        : null;
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
    labelGroups: data.labelGroups ?? [],
    labels: data.labels,
    taskLabels: data.taskLabels,
    labelGroupId: currentDisplay.labelGroupId ?? null,
    groupBy: currentGroupBy,
    showEmptyGroups: shouldShowEmptyTaskGroups(
      currentGroupBy,
      currentDisplay.showEmptyGroups,
      draggingTaskId !== null,
    ),
  });
  const keyboardTasks = currentGroupBy !== "none"
    ? tasksInGroupOrder(taskGroups, layout === "list" ? collapsedGroups : new Set())
    : visibleTasks;
  const keyboardTaskIds = keyboardTasks.map((task) => task.id);
  const selectableTaskIds = new Set(
    keyboardTasks
      .filter((task) => canEditContent(task.accessRole))
      .map((task) => task.id),
  );
  const keyboardTaskIdsKey = keyboardTaskIds.join("\u0000");
  const selectableTaskIdsKey = [...selectableTaskIds].join("\u0000");
  const currentShareTarget = shareTarget(surface, activeTask, data);
  const canCreateTask = contextProjectRecord
    ? !contextProjectRecord.archivedAt && canEditContent(contextProjectRecord.accessRole)
    : data.projects.some((project) => !project.archivedAt && canEditContent(project.accessRole));
  const canSaveView = contextProjectRecord
    ? canEditContent(contextProjectRecord.accessRole)
    : activeSavedView
      ? canEditContent(activeSavedView.accessRole)
      : true;
  const sidebarCompact = sidebarCollapsed && !mobileSidebarOpen;
  const searchLabel = surface === "projects"
    ? "Search projects"
    : surface === "releases"
      ? "Search releases"
      : surface === "views"
        ? "Search views"
        : "Search tasks";
  const hasTemporaryFilters = Boolean(
    search.trim() || canonicalTemporaryQuery.conditions.length,
  );
  const hasDisplayChanges = JSON.stringify(currentDisplay) !== JSON.stringify(
    activeSavedView?.display ?? defaultViewDisplay(),
  );
  const hasRuntimeViewChanges = hasTemporaryFilters || hasDisplayChanges;

  function taskMatchesCurrentQuery(task: TaskRecord, snapshot: AppSnapshot) {
    if (surface === "mine" && task.assigneeUserId !== snapshot.user.id) return false;
    if (surface === "shared" && task.accessRole === "owner") return false;
    if (surface.startsWith("project:") && task.projectId !== surface.slice(8)) return false;
    if (surface.startsWith("release:") && task.releaseId !== surface.slice(8)) return false;
    const status = snapshot.statuses.find((item) => item.id === task.statusId);
    if (surface === "active" && status?.category !== "unstarted" && status?.category !== "started") {
      return false;
    }
    if (surface === "backlog" && status?.category !== "backlog") return false;

    const archivedCondition = canonicalViewQuery(currentViewQuery).conditions.some(
      (condition) => condition.field === "archived",
    );
    if (surface === "mine" && task.archivedAt) return false;
    if (surface === "archived" && !task.archivedAt) return false;
    if (surface !== "archived" && surface !== "mine" && !archivedCondition && task.archivedAt) {
      return false;
    }
    if (
      activeSavedView?.scopeProjectId &&
      task.projectId !== activeSavedView.scopeProjectId
    ) return false;

    return taskMatchesViewQuery(task, currentViewQuery, {
      statuses: snapshot.statuses,
      taskLabels: snapshot.taskLabels,
      relations: snapshot.relations,
      tasks: snapshot.tasks,
      referenceTime: new Date(viewReferenceTime),
      timezone: snapshot.user.timezone,
    });
  }

  function reconcileSuccessfulTaskMutation(
    affectedTasks: readonly TaskRecord[],
    before: AppSnapshot,
    after: AppSnapshot,
    additionalDependencies: Iterable<TaskQueryDependency> = [],
    allowLocalMembership = true,
  ) {
    if (isCollectionSurface(surface) || !affectedTasks.length) return;
    const beforeTasks = new Map(before.tasks.map((task) => [task.id, task]));
    const dependencies = new Set<TaskQueryDependency>(additionalDependencies);
    for (const task of affectedTasks) {
      for (const dependency of taskMutationDependencies(beforeTasks.get(task.id), task)) {
        dependencies.add(dependency);
      }
    }
    if (!mutationAffectsTaskQuery(activeTaskQueryDependencySet, dependencies)) return;

    const localSemanticsComplete = allowLocalMembership &&
      !canonicalViewQuery(currentViewQuery).conditions.some(
        (condition) => condition.field === "label_group",
      );
    if (localSemanticsComplete) {
      setTaskSearch((current) => {
        if (!current || current.query !== taskQueryKey || current.status !== "ready") {
          return current;
        }
        const merged = affectedTasks.map((task) =>
          mergeTaskSummary(current.tasks.find((candidate) => candidate.id === task.id), task),
        );
        return reconcileTaskQueryMembership(
          current,
          merged,
          (task) => taskMatchesCurrentQuery(task, after),
        );
      });
    }
    taskQueryRefreshCoordinatorRef.current?.request(
      activeTaskQueryDependencySet,
      dependencies,
    );
  }

  async function refreshSavedViewsAfterConflict() {
    const refreshed = await fetchTaskSnapshot(
      fetch,
      workspaceScopeTokenRef.current || undefined,
    );
    dataRef.current = {
      ...dataRef.current,
      views: refreshed.views,
    };
    setData((current) => ({
      ...current,
      views: refreshed.views,
    }));
  }

  async function mutate(
    path: string,
    method: string,
    body: unknown,
    options?: {
      onConflict?: () => Promise<void>;
      conflictMessage?: string;
    },
  ) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(scopedUiApiPath(path, workspaceScopeTokenRef.current), {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = (await response.json()) as MutationResult | { error: string };
      if (!response.ok || "error" in value) {
        if (response.status === 409 && options?.onConflict) {
          await options.onConflict();
          throw new Error(options.conflictMessage ?? "The record changed in another session. Latest data was reloaded.");
        }
        throw new Error("error" in value ? value.error : "Request failed");
      }
      const before = dataRef.current;
      const after = applyMutationResult(before, value);
      if ("workspaceScope" in value && value.workspaceScope) {
        const selectedToken = value.workspaceScope.selectedToken;
        workspaceScopeTokenRef.current = selectedToken;
        setWorkspaceScopeToken(selectedToken);
        window.localStorage.setItem(workspaceScopeStorageKey(value.user.id), selectedToken);
      }
      dataRef.current = after;
      setData((current) => {
        const next = applyMutationResult(current, value);
        dataRef.current = next;
        return next;
      });
      if ("taskIds" in value && "taskLabels" in value) {
        const replaced = new Set(value.taskIds);
        setTaskDetail((current) => current && replaced.has(current.task.id)
          ? {
              ...current,
              task: invalidateTaskActivity(current.task),
              labels: value.labels.filter((label) =>
                value.taskLabels.some((item) =>
                  item.taskId === current.task.id && item.labelId === label.id)),
              taskLabels: value.taskLabels.filter((item) =>
                item.taskId === current.task.id),
            }
          : current);
      }
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
      if ("taskUpdates" in value) {
        const updates = new Map(value.taskUpdates.map((task) => [task.id, task]));
        setTaskDetail((current) => {
          const update = current ? updates.get(current.task.id) : undefined;
          return current && update
            ? { ...current, task: mergeTaskMutation(current.task, update) }
            : current;
        });
        setTaskSearch((current) => current
          ? {
              ...current,
              tasks: current.tasks.map((task) => {
                const update = updates.get(task.id);
                return update ? mergeTaskSummary(task, update) : task;
              }),
            }
          : current,
        );
      }
      if (path.startsWith("/api/tasks")) {
        const additionalDependencies = new Set<TaskQueryDependency>();
        let affectedTasks: TaskRecord[] = [];
        if ("task" in value) {
          affectedTasks = [value.task];
        } else if ("taskUpdates" in value) {
          affectedTasks = value.taskUpdates;
        } else if ("taskIds" in value && "taskLabels" in value) {
          additionalDependencies.add("label");
          additionalDependencies.add("label_group");
          const affected = new Set(value.taskIds);
          affectedTasks = after.tasks.filter((task) => affected.has(task.id));
        } else {
          const anchorMatch = path.match(/^\/api\/tasks\/([^/]+)\/(parent|subtasks)$/);
          if (anchorMatch) {
            const anchorId = decodeURIComponent(anchorMatch[1]!);
            const affected = new Set<string>([anchorId]);
            const beforeAnchor = before.tasks.find((task) => task.id === anchorId);
            const afterAnchor = after.tasks.find((task) => task.id === anchorId);
            if (beforeAnchor?.parentTaskId) affected.add(beforeAnchor.parentTaskId);
            if (afterAnchor?.parentTaskId) affected.add(afterAnchor.parentTaskId);
            if (anchorMatch[2] === "subtasks") {
              const beforeIds = new Set(before.tasks.map((task) => task.id));
              for (const task of after.tasks) {
                if (!beforeIds.has(task.id)) affected.add(task.id);
              }
            }
            additionalDependencies.add("parent");
            additionalDependencies.add("subtasks");
            affectedTasks = after.tasks.filter((task) => affected.has(task.id));
          }
        }
        reconcileSuccessfulTaskMutation(
          affectedTasks,
          before,
          after,
          additionalDependencies,
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

  async function loadMoreCatalog(kind: WorkspaceCatalogKind) {
    const currentPage = catalogPages[kind];
    if (!currentPage?.page.hasMore || !currentPage.page.nextCursor) return;
    setCatalogLoading(true);
    setError("");
    try {
      const parameters = new URLSearchParams({
        kind,
        limit: "30",
        cursor: currentPage.page.nextCursor,
        order: catalogOrder,
        direction: catalogDirection,
      });
      if (workspaceScopeToken) parameters.set("workspace_scope", workspaceScopeToken);
      if (search.trim()) parameters.set("search", search.trim());
      const response = await fetch(`/api/catalog?${parameters}`, { cache: "no-store" });
      const value = await response.json() as WorkspaceCatalogPage | { error: string };
      if (!response.ok || "error" in value) {
        throw new Error("error" in value ? value.error : "Catalog could not be loaded");
      }
      const merged: WorkspaceCatalogPage = {
        ...value,
        projects: mergeUnique(value.projects, currentPage.projects, (item) => item.id),
        releases: mergeUnique(value.releases, currentPage.releases, (item) => item.id),
        views: mergeUnique(value.views, currentPage.views, (item) => item.id),
        total: currentPage.total,
      };
      setCatalogPages((current) => ({ ...current, [kind]: merged }));
      setData((current) => mergeWorkspaceCatalogPage(current, value));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Catalog could not be loaded");
    } finally {
      setCatalogLoading(false);
    }
  }

  async function createTaskForComposer(
    input: Record<string, unknown>,
  ): Promise<TaskRecord | null> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        scopedUiApiPath("/api/tasks", workspaceScopeTokenRef.current),
        {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        },
      );
      const value = (await response.json()) as
        | (AppSnapshot & { createdTask: { id: string; publicId: string } })
        | { error: string };
      if (!response.ok || "error" in value) {
        throw new Error("error" in value ? value.error : "Task could not be created");
      }
      const { createdTask, ...snapshot } = value;
      const task = snapshot.tasks.find((item) => item.id === createdTask.id) ?? null;
      const before = dataRef.current;
      dataRef.current = snapshot;
      setData(snapshot);
      if (task) reconcileSuccessfulTaskMutation([task], before, snapshot);
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
    group: TaskGroup | null,
    previousTaskId: string | null,
    nextTaskId: string | null,
  ) {
    if (group && (!canMoveTaskToGroup(task, group) ||
      (group.kind === "status" && Boolean(statusMap.get(group.value ?? "")?.archivedAt)))) {
      return false;
    }
    if (currentGroupBy === "label_group") {
      const groupId = currentDisplay.labelGroupId;
      if (!groupId || !group) return false;
      return mutate(`/api/tasks/${task.id}/label-groups`, "PUT", {
        groupId,
        labelId: group.value,
      });
    }
    const projectMove = projectGroupMovePreview(task, group);
    if (projectMove) {
      setPendingProjectMove(projectMove);
      return true;
    }
    if (currentDisplay.orderBy !== "manual") {
      if (!group) return false;
      const confirmReleasedComposition = group.kind === "release" &&
        releasedCompositionNeedsConfirmation(
          task.releaseId,
          group.release?.id ?? null,
          data.releases,
        );
      if (confirmReleasedComposition && !confirmReleasedCompositionChange()) {
        return false;
      }
      if (group.kind === "project") return false;
      return mutate(`/api/tasks/${task.id}`, "PATCH", {
        version: taskMutationVersion(task),
        ...taskGroupCreateDefaults(group),
        ...(confirmReleasedComposition ? { confirmReleasedComposition: true } : {}),
      });
    }
    const previousTask = previousTaskId
      ? taskPool.find((item) => item.id === previousTaskId)
      : null;
    const nextTask = nextTaskId
      ? taskPool.find((item) => item.id === nextTaskId)
      : null;
    let rank: number;
    try {
      rank = rankBetweenNeighbors(previousTask?.rank ?? null, nextTask?.rank ?? null);
    } catch (rankError) {
      setError(rankError instanceof Error ? rankError.message : "Task order changed; reload and retry");
      return false;
    }
    const targetGroupValue = group?.value ?? null;
    const nextReleaseId = currentGroupBy === "release"
      ? targetGroupValue
      : task.releaseId;
    const confirmReleasedComposition = releasedCompositionNeedsConfirmation(
      task.releaseId,
      nextReleaseId,
      data.releases,
    );
    if (confirmReleasedComposition && !confirmReleasedCompositionChange()) {
      return false;
    }
    const optimistic = group
      ? projectTaskGroupMove(task, group, rank)
      : { ...task, rank };
    updateClientTask(
      task.id,
      (current) => group
        ? projectTaskGroupMove(current, group, rank)
        : { ...current, rank },
    );
    const saved = await mutate(`/api/tasks/${task.id}/reorder`, "POST", {
      version: taskMutationVersion(task),
      groupBy: currentGroupBy,
      expectedGroupValue: taskGroupValue(task, currentGroupBy, data.taskLabels, data.labels, currentDisplay.labelGroupId ?? null),
      targetGroupValue,
      previousTaskId,
      nextTaskId,
      ...(confirmReleasedComposition ? { confirmReleasedComposition: true } : {}),
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
      const response = await fetch(taskDetailUiApiPath(taskId, workspaceScopeTokenRef.current), {
        cache: "no-store",
      });
      const value = (await response.json()) as TaskDetailRecord | { error: string };
      if (!response.ok || "error" in value) {
        throw new Error("error" in value ? value.error : "Could not refresh task");
      }
      const retained = dataRef.current.tasks.find((task) => task.id === taskId);
      if (retained && retained.version > value.task.version) return retained;
      dataRef.current = mergeTaskDetailContext(dataRef.current, value);
      setTaskDetail((current) => current?.task.id === taskId
        ? { ...value, task: mergeLoadedTask(current.task, value.task) }
        : current);
      setData((current) => {
        const currentTask = current.tasks.find((task) => task.id === taskId);
        if (currentTask && currentTask.version > value.task.version) return current;
        const next = mergeTaskDetailContext(current, value);
        dataRef.current = next;
        return next;
      });
      return value.task;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not refresh task");
      return null;
    }
  }, []);

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

  async function loadWorkspaceScopeSnapshot(
    requestedToken: string,
    historyMode: "push" | "replace" | "none" = "push",
    goToWorkspace = true,
  ) {
    const scope = dataRef.current.workspaceScope;
    if (!scope) return false;
    const currentToken = scope.options.find((option) => option.current)?.token ??
      scope.selectedToken;
    const membership = resolveWorkspaceScopeMembership(
      requestedToken,
      scope.options,
      currentToken,
    );
    setWorkspaceScopeLoading(true);
    setError("");
    try {
      const incoming = await fetchTaskSnapshot(fetch, membership.token);
      const selectedToken = incoming.workspaceScope?.selectedToken ?? currentToken;
      workspaceScopeTokenRef.current = selectedToken;
      setWorkspaceScopeToken(selectedToken);
      dataRef.current = incoming;
      setData(incoming);
      completeCatalogFlights.current = {};
      setCatalogPages({});
      setCatalogEpoch((current) => current + 1);
      setTaskSearch(null);
      setSelected(new Set());
      setPeekTaskId(null);
      setTaskDetail(null);
      setForcedTaskDetailId(null);
      taskQueryGenerationRef.current += 1;
      window.localStorage.setItem(
        workspaceScopeStorageKey(incoming.user.id),
        selectedToken,
      );
      const next: ResolvedNavigation = goToWorkspace
        ? { surface: "workspace", layout: "list", taskId: null }
        : { surface, layout, taskId: activeTaskId };
      if (goToWorkspace) {
        setSurface(next.surface);
        setLayout(next.layout);
        setActiveTaskId(null);
        taskReturnPath.current = "/workspace";
      }
      if (historyMode !== "none") {
        window.history[historyMode === "push" ? "pushState" : "replaceState"](
          navigationStateWithWorkspaceScope(next, selectedToken),
          "",
          goToWorkspace ? "/workspace" : window.location.href,
        );
      }
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error
        ? requestError.message
        : "Workspace scope could not be loaded");
      return false;
    } finally {
      setWorkspaceScopeLoading(false);
    }
  }

  function applyNavigation(
    next: ResolvedNavigation,
    historyMode: "push" | "replace" | "none" = "push",
    preserveTemporaryFilter = false,
    canonicalPath?: string,
  ) {
    const nextPath = canonicalPath ?? (
      preserveTemporaryFilter
        ? navigationPathWithTemporaryFilter(
            navigationPath(next, data),
            window.location.href,
          )
        : navigationPath(next, data)
    );
    setSurface(next.surface);
    setLayout(next.layout);
    setActiveTaskId(next.taskId);
    if (!next.taskId) taskReturnPath.current = nextPath;
    if (historyMode === "push") {
      window.history.pushState(
        navigationStateWithWorkspaceScope(next, workspaceScopeTokenRef.current),
        "",
        nextPath,
      );
    } else if (historyMode === "replace") {
      window.history.replaceState(
        navigationStateWithWorkspaceScope(next, workspaceScopeTokenRef.current),
        "",
        nextPath,
      );
    }
  }

  function navigateSurface(nextSurface: string, nextLayout?: Layout) {
    setMobileSidebarOpen(false);
    setMobileActionsOpen(false);
    setSearch("");
    setTemporaryQuery(emptyViewQuery());
    if (nextSurface === "admin") {
      // The initial workspace snapshot intentionally omits the admin overview.
      // Let the server build the gated projection before rendering this surface.
      window.location.assign("/admin");
      return;
    }
    if (
      nextSurface === "shared" &&
      workspaceScopeTokenRef.current !== ALL_ACCESSIBLE_WORKSPACE_SCOPE
    ) {
      void (async () => {
        if (await loadWorkspaceScopeSnapshot(
          ALL_ACCESSIBLE_WORKSPACE_SCOPE,
          "none",
          false,
        )) {
          applyNavigation({ surface: "shared", layout: "list", taskId: null });
        }
      })();
      return;
    }
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
    applyNavigation(
      { surface, layout: nextLayout, taskId: null },
      "push",
      true,
    );
  }

  function changeGroupBy(nextGroupBy: ViewDisplay["groupBy"]) {
    changeDisplay({
      groupBy: nextGroupBy,
      labelGroupId: nextGroupBy === "label_group"
        ? currentDisplay.labelGroupId ?? (data.labelGroups ?? []).find((group) => !group.archivedAt)?.id ?? null
        : null,
    });
    setCollapsedGroups(new Set());
  }

  function changeDisplay(changes: Partial<ViewDisplay>) {
    setDisplayOverrides((current) => ({
      ...current,
      [surface]: {
        ...currentDisplay,
        ...changes,
      },
    }));
  }

  function clearTemporaryFilters() {
    setSearch("");
    setTemporaryQuery(emptyViewQuery());
  }

  function resetDisplayChanges() {
    setDisplayOverrides((current) => {
      const next = { ...current };
      delete next[surface];
      return next;
    });
    const baselineLayout = activeSavedView?.display.layout ?? defaultViewDisplay().layout;
    if (layout !== baselineLayout) {
      applyNavigation({
        surface,
        layout: baselineLayout,
        taskId: null,
      });
    }
  }

  function openTask(taskId: string) {
    if (!activeTaskId) {
      taskReturnPath.current = navigationPathWithTemporaryFilter(
        navigationPath({ surface, layout, taskId: null }, data),
        window.location.href,
      );
    }
    applyNavigation({ surface, layout, taskId }, "push", true);
  }

  function closeTask() {
    setActiveTaskId(null);
    const target = parseNavigationPath(taskReturnPath.current);
    const next = target ? resolveNavigationTarget(target, data) : null;
    window.history.replaceState(
      next
        ? navigationStateWithWorkspaceScope(next, workspaceScopeTokenRef.current)
        : null,
      "",
      taskReturnPath.current,
    );
  }

  async function copyCurrentLink() {
    await navigator.clipboard.writeText(window.location.href);
  }

  function currentUserProfile(): UserProfile {
    const current = dataRef.current;
    return current.userProfile ?? {
      user: {
        ...current.user,
        version: current.user.version ?? 1,
        theme: current.user.theme ?? "system",
        sidebarPreference: current.user.sidebarPreference ?? "expanded",
      },
      identities: [{ provider: "chatgpt", verifiedEmail: current.user.email }],
    };
  }

  function applyOptimisticPreferences(changes: UserPreferenceChanges) {
    if (changes.theme) setTheme(changes.theme);
    if (changes.sidebarPreference) {
      setSidebarCollapsed(changes.sidebarPreference === "collapsed");
    }
  }

  function applyUserProfile(
    profile: UserProfile,
    pendingPreferences: UserPreferenceChanges | null = null,
  ) {
    dataRef.current = {
      ...dataRef.current,
      user: profile.user,
      userProfile: profile,
    };
    setData((current) => ({ ...current, user: profile.user, userProfile: profile }));
    setTheme(pendingPreferences?.theme ?? profile.user.theme);
    setSidebarCollapsed(
      (pendingPreferences?.sidebarPreference ?? profile.user.sidebarPreference) === "collapsed",
    );
  }

  function saveUserPreferences(changes: UserPreferenceChanges) {
    return preferenceSaveQueueRef.current!.enqueue(changes);
  }

  async function openCreate(defaults: TaskCreateDefaults = {}) {
    if (!canCreateTask) return;
    setMobileSidebarOpen(false);
    setMobileActionsOpen(false);
    setCreateDefaults(defaults);
    await openDialogWithCatalog("task", ["projects", "releases"]);
  }

  async function toggleFilters(focusEditor = false) {
    if (filterOpen) {
      setFilterOpen(false);
      return;
    }
    setCatalogLoading(true);
    setError("");
    try {
      await ensureCompleteCatalogs(["projects", "releases"]);
      setFilterOpen(true);
      if (focusEditor) {
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>(".filter-popover input")?.focus();
        });
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Catalog could not be loaded");
    } finally {
      setCatalogLoading(false);
    }
  }

  function openGlobalSearch() {
    globalSearchReturnFocus.current = mobileSidebarOpen
      ? mobileMenuRef.current
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setMobileSidebarOpen(false);
    setMobileActionsOpen(false);
    setAccountMenuOpen(false);
    setGlobalSearchOpen(true);
  }

  function closeGlobalSearch() {
    setGlobalSearchOpen(false);
    window.requestAnimationFrame(() => {
      const target = globalSearchReturnFocus.current;
      if (target?.isConnected) target.focus();
      else mobileMenuRef.current?.focus();
    });
  }

  function openGlobalSearchResult(result: GlobalSearchResult) {
    const next = resolveGlobalSearchNavigation(result, data, {
      surface,
      layout,
      taskId: activeTaskId,
    });
    setGlobalSearchOpen(false);
    if (!next) {
      window.location.assign(result.href);
      return;
    }
    if (result.type === "task") {
      if (!activeTaskId) {
        taskReturnPath.current = navigationPathWithTemporaryFilter(
          navigationPath({ surface, layout, taskId: null }, data),
          window.location.href,
        );
      }
      setTaskDetail((current) => current?.task.id === result.id ? current : null);
      if (!data.tasks.some((task) => task.id === result.id)) {
        setForcedTaskDetailId(result.id);
      }
    }
    applyNavigation(next, "push", false, result.href);
  }

  async function toggleMobileViewControls(focusMobileSearch = false) {
    setMobileSidebarOpen(false);
    if (mobileActionsOpen) {
      if (focusMobileSearch) mobileSearchRef.current?.focus();
      else setMobileActionsOpen(false);
      return;
    }
    setCatalogLoading(true);
    setError("");
    try {
      await ensureCompleteCatalogs(["projects", "releases"]);
      setMobileActionsOpen(true);
      if (focusMobileSearch) {
        window.requestAnimationFrame(() => mobileSearchRef.current?.focus());
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Catalog could not be loaded");
    } finally {
      setCatalogLoading(false);
    }
  }

  function focusLocalSearch() {
    const mobile = window.matchMedia("(max-width: 900px)").matches;
    setMobileSidebarOpen(false);
    if (mobile) {
      void toggleMobileViewControls(true);
      return;
    }
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }

  function toggleSelection(id: string, extendRange = false) {
    const task = data.tasks.find((item) => item.id === id);
    if (!task || !canEditContent(task.accessRole)) return;
    setHighlightedTaskId(id);
    setSelected((current) => {
      const result = extendRange
        ? selectTaskRange(
            current,
            selectionAnchorRef.current,
            id,
            keyboardTaskIds,
            selectableTaskIds,
          )
        : toggleTaskSelection(current, selectionAnchorRef.current, id);
      selectionAnchorRef.current = result.anchorId;
      return result.selected as Set<string>;
    });
  }

  function openContextualActions(
    context: ContextualActionContext,
    x: number,
    y: number,
    restoreFocus: HTMLElement | null,
  ) {
    if (!context.entities.length) return;
    setContextualMenu({ context, x, y, restoreFocus });
  }

  function openTaskContextualActions(
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
    openContextualActions(
      { entities: tasks },
      x,
      y,
      restoreFocus,
    );
  }

  function closeContextualActions() {
    const restoreFocus = contextualMenu?.restoreFocus;
    setContextualMenu(null);
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

  function focusedContextualActionEntity(element: HTMLElement): ContextualActionEntity | null {
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

  async function executeContextualAction(action: ResolvedContextualAction) {
    if (!contextualMenu) return;
    try {
      const liveContext = currentContext(contextualMenu.context);
      const liveAction = resolveContextualActions(liveContext).find((item) => item.id === action.id);
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
        closeContextualActions();
        return;
      }

      if (action.id === "delete") {
        closeContextualActions();
        await openRecoverableDelete(entity);
        return;
      }

      if (entity.kind === "task") {
        const command = buildTaskArchiveCommand(liveContext, action);
        const ok = await mutate(command.path, command.method, command.body);
        if (ok) {
          setSelected(new Set());
          closeContextualActions();
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
        closeContextualActions();
        return;
      }

      if (entity.kind === "project") {
        const ok = await mutate(`/api/projects/${entity.id}`, "PATCH", {
          version: entity.version,
          archived: action.id === "archive",
        });
        if (ok) closeContextualActions();
      } else if (entity.kind === "saved_view") {
        const ok = await mutate(`/api/views/${entity.id}`, "PATCH", {
          version: entity.version,
          archived: action.id === "archive",
        });
        if (ok) {
          if (action.id === "archive" && surface === `view:${entity.id}`) {
            navigateSurface("views", "list");
          }
          closeContextualActions();
        }
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Contextual action failed");
    }
  }

  useEffect(() => {
    function handlePopState(event: PopStateEvent) {
      void (async () => {
        const historyScope = workspaceScopeFromHistory(event.state);
        if (historyScope && historyScope !== workspaceScopeTokenRef.current) {
          await loadWorkspaceScopeSnapshot(historyScope, "none", false);
        }
        const currentData = dataRef.current;
        const target = parseNavigationPath(window.location.pathname);
        const resolved =
          resolveNavigationHistoryState(
            event.state,
            window.location.pathname,
            currentData,
          ) ?? (target ? resolveNavigationTarget(target, currentData) : null);
        if (resolved) {
          setSurface(resolved.surface);
          setLayout(resolved.layout);
          setActiveTaskId(resolved.taskId);
          if (!resolved.taskId) {
            taskReturnPath.current = navigationPath(resolved, currentData);
          }
        }
      })();
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
    // The handler intentionally resolves the latest loader inputs through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
      const searchShortcut = resolveSearchShortcut(event, {
        typing,
        localSearchAvailable: !isCollectionSurface(surface) && surface !== "admin" && surface !== "workspace",
      });
      if (searchShortcut === "local") {
        event.preventDefault();
        focusLocalSearch();
        return;
      }
      const layerOwnsKeyboard = Boolean(
        globalSearchOpen || mobileActionsOpen || mobileSidebarOpen ||
        accountMenuOpen || pendingProjectMove || dialog || peekTaskId ||
        filterOpen || displayOpen || contextualMenu || recoverableDeletion,
      );
      const command = keyboardCommandFor(event, { layerOwnsKeyboard });
      if (!command) return;
      if (
        command === "escape" &&
        activeTaskId &&
        !dialog &&
        event.target instanceof Element &&
        event.target.closest("[role='dialog'][aria-modal='true']")
      ) {
        return;
      }
      if (
        activeTaskId &&
        command !== "escape" &&
        command !== "toggle-details" &&
        command !== "contextual-actions"
      ) return;

      const focusHighlightedTask = () => {
        const taskId = highlightedTaskId;
        if (!taskId) return;
        window.setTimeout(() => {
          document.querySelector<HTMLElement>(`[data-task-keyboard-id="${CSS.escape(taskId)}"]`)?.focus();
        }, 0);
      };

      if (command === "escape") {
        let handled = true;
        if (contextualMenu) closeContextualActions();
        else if (globalSearchOpen) closeGlobalSearch();
        else if (pendingProjectMove) {
          if (!busy) setPendingProjectMove(null);
          else handled = false;
        }
        else if (dialog) {
          if (dialog !== "systemImport" || !systemBackupBusy) setDialog(null);
          else handled = false;
        }
        else if (activeTaskId) {
          closeTask();
          focusHighlightedTask();
        }
        else if (peekTaskId) {
          setPeekTaskId(null);
          focusHighlightedTask();
        }
        else if (displayOpen) {
          setDisplayOpen(false);
          displayTriggerRef.current?.focus();
        }
        else if (filterOpen) {
          setFilterOpen(false);
          filterTriggerRef.current?.focus();
        }
        else if (mobileActionsOpen) setMobileActionsOpen(false);
        else if (mobileSidebarOpen) closeMobileSidebar();
        else if (accountMenuOpen) {
          setAccountMenuOpen(false);
          accountTriggerRef.current?.focus();
        }
        else if (selected.size) {
          setSelected(new Set());
          selectionAnchorRef.current = null;
        }
        else handled = false;
        if (handled) event.preventDefault();
        return;
      }
      if (command === "global-search") {
        const claimed = dispatchTaskKeyboardIntegrationCommand(window, {
          command,
          taskId: highlightedTaskId ?? keyboardTaskIds[0] ?? null,
          selectedTaskIds: [...selected],
          surface,
        });
        event.preventDefault();
        if (!claimed) openGlobalSearch();
        return;
      }
      if (surface === "admin") return;
      if (command === "compose") {
        if (!canCreateTask) return;
        event.preventDefault();
        void openCreate();
        return;
      }

      const integrationTaskId = highlightedTaskId ?? keyboardTaskIds[0] ?? null;
      if (command === "contextual-actions") {
        const focusedEntity = focusedContextualActionEntity(target);
        const activeTaskEntity = activeTaskId
          ? data.tasks.find((task) => task.id === activeTaskId)
          : null;
        const entities = resolveKeyboardContextualEntities(
          data.tasks.map(taskContextualEntity),
          selected,
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
              surface,
            })
          : false;
        event.preventDefault();
        if (!claimed) {
          const contextualEntities = entities.length
            ? entities
            : surfaceContextualEntity
              ? [surfaceContextualEntity]
              : [];
          if (contextualEntities.length) {
            openContextualActions(
              { entities: contextualEntities },
              Math.max(8, window.innerWidth / 2 - 120),
              Math.max(8, window.innerHeight / 3),
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null,
            );
          }
        }
        return;
      }

      const taskSurface = !isCollectionSurface(surface);
      if (!taskSurface) return;
      if (command === "filter") {
        event.preventDefault();
        setDisplayOpen(false);
        void toggleFilters(true);
      } else if (command === "display") {
        event.preventDefault();
        setFilterOpen(false);
        setDisplayOpen(true);
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(".display-anchor .popover select, .display-anchor .popover button")?.focus();
        });
      } else if (command === "toggle-layout") {
        event.preventDefault();
        const nextLayout = layout === "list" ? "board" : "list";
        const next: ResolvedNavigation = { surface, layout: nextLayout, taskId: null };
        setLayout(nextLayout);
        setActiveTaskId(null);
        taskReturnPath.current = navigationPath(next, data);
        window.history.pushState(
          navigationStateWithWorkspaceScope(next, workspaceScopeTokenRef.current),
          "",
          navigationPath(next, data),
        );
      } else if (command === "highlight-next" || command === "highlight-previous") {
        event.preventDefault();
        const next = moveTaskHighlight(
          highlightedTaskId,
          keyboardTaskIds,
          command === "highlight-next" ? 1 : -1,
        );
        setHighlightedTaskId(next);
        if (next) {
          window.requestAnimationFrame(() => {
            document.querySelector<HTMLElement>(`[data-task-keyboard-id="${CSS.escape(next)}"]`)
              ?.scrollIntoView({ block: "nearest" });
          });
        }
      } else if ((command === "toggle-selection" || command === "extend-selection") && integrationTaskId) {
        event.preventDefault();
        toggleSelection(integrationTaskId, command === "extend-selection");
      } else if (command === "peek" && integrationTaskId) {
        event.preventDefault();
        setHighlightedTaskId(integrationTaskId);
        setPeekTaskId(integrationTaskId);
      } else if (command === "open" && integrationTaskId) {
        event.preventDefault();
        setHighlightedTaskId(integrationTaskId);
        openTask(integrationTaskId);
      } else if (command === "select-visible") {
        event.preventDefault();
        setSelected(new Set(keyboardTaskIds.filter((id) => selectableTaskIds.has(id))));
        selectionAnchorRef.current = integrationTaskId;
      } else if (command === "toggle-details" && activeTaskId) {
        event.preventDefault();
        closeTask();
        focusHighlightedTask();
      } else if (command === "toggle-details" && integrationTaskId) {
        event.preventDefault();
        setHighlightedTaskId(integrationTaskId);
        openTask(integrationTaskId);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
    // The handlers close over the state listed below; adding the local wrapper
    // functions themselves would recreate this listener on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountMenuOpen, activeTaskId, busy, canCreateTask, contextualMenu, data, dialog, displayOpen, filterOpen, globalSearchOpen, highlightedTaskId, keyboardTaskIdsKey, layout, mobileActionsOpen, mobileSidebarOpen, peekTaskId, pendingProjectMove, recoverableDeletion, selectableTaskIdsKey, selected, surface, surfaceContextualEntity, systemBackupBusy]);

  useEffect(() => {
    // Navigation changes deliberately reset ephemeral list state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHighlightedTaskId(null);
    setSelected(new Set());
    setPendingProjectMove(null);
    selectionAnchorRef.current = null;
  }, [surface, search, temporaryQuery]);

  const pendingMoveTask = pendingProjectMove
    ? taskPool.find((task) => task.id === pendingProjectMove.taskId)
    : undefined;
  const pendingMoveSourceProject = pendingMoveTask
    ? projectMap.get(pendingMoveTask.projectId)
    : undefined;
  const pendingMoveTargetProject = pendingProjectMove
    ? projectMap.get(pendingProjectMove.targetProjectId)
    : undefined;
  const pendingMoveParent = pendingMoveTask?.parentTaskId
    ? data.tasks.find((task) => task.id === pendingMoveTask.parentTaskId) ?? pendingMoveTask
    : undefined;
  const pendingMoveSubtasks = pendingMoveTask
    ? data.tasks.filter((task) => task.parentTaskId === pendingMoveTask.id)
    : [];

  useEffect(() => {
    const result = reconcileTaskInteraction(
      {
        highlightedId: highlightedTaskId,
        selected,
        anchorId: selectionAnchorRef.current,
      },
      keyboardTaskIds,
      selectableTaskIds,
      previousKeyboardTaskIdsRef.current,
    );
    previousKeyboardTaskIdsRef.current = keyboardTaskIds;
    selectionAnchorRef.current = result.anchorId;
    if (result.highlightedId !== highlightedTaskId) {
      setHighlightedTaskId(result.highlightedId);
    }
    if (!setsEqual(result.selected, selected)) {
      setSelected(new Set(result.selected));
    }
    // Stable ID keys intentionally represent the derived arrays without making
    // this reconciliation effect run merely because TaskGroup objects re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedTaskId, keyboardTaskIdsKey, selectableTaskIdsKey, selected]);

  return (
    <main data-theme={theme} className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${mobileSidebarOpen ? "mobile-sidebar-open" : ""}`}>
      {globalSearchOpen && (
        <GlobalSearchOverlay
          onClose={closeGlobalSearch}
          onOpen={openGlobalSearchResult}
        />
      )}
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
          {sidebarCompact && (
            <button className="icon-button" type="button" onClick={openGlobalSearch} title="Global search (/)" aria-label="Open global search">
              <Search size={15} />
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
          <button className="sidebar-search" onClick={openGlobalSearch}>
            <Search size={14} /><span>Search</span><kbd>/</kbd>
          </button>
        )}
        <nav className="nav-scroll" aria-label="Workspace">
          <NavItem compact={sidebarCompact} icon={<PanelsTopLeft size={15} />} label="Workspace" active={surface === "workspace"} href="/workspace" onNavigate={() => navigateSurface("workspace", "list")} />
          <NavItem compact={sidebarCompact} icon={<Inbox size={15} />} label="My tasks" active={surface === "mine"} href="/issues" onNavigate={() => navigateSurface("mine", "list")} count={taskCountForView("mine", data, statusMap)} />
          <NavItem compact={sidebarCompact} icon={<UsersRound size={15} />} label="Shared with me" active={surface === "shared"} href="/shared" onNavigate={() => navigateSurface("shared", "list")} />
          <NavItem compact={sidebarCompact} icon={<UsersRound size={15} />} label="Teams" active={surface === "teams"} href="/teams" onNavigate={() => navigateSurface("teams", "list")} />
          {!sidebarCompact && (
            <>
              <SidebarSection title="Views" action={() => void openDialogWithCatalog("view", ["projects"])}>
                <NavItem compact={false} icon={<Boxes size={13} />} label="All views" active={surface === "views"} href="/views" onNavigate={() => navigateSurface("views", "list")} />
                {builtInViews.filter((view) => view.id !== "mine").map((view) => (
                  <NavItem key={view.id} compact={false} icon={<Circle size={9} />} label={view.label} active={surface === view.id} href={navigationPath({ surface: view.id, layout: "list", taskId: null }, data)} onNavigate={() => navigateSurface(view.id, "list")} count={taskCountForView(view.id, data, statusMap)} />
                ))}
                {sidebarViews.map((view) => (
                  <SidebarSavedViewItem
                    key={view.id}
                    view={view}
                    active={surface === `view:${view.id}`}
                    href={navigationPath({ surface: `view:${view.id}`, layout: view.display.layout, taskId: null }, data)}
                    onNavigate={() => navigateSurface(`view:${view.id}`, view.display.layout)}
                    onContextActions={(x, y, focus) => openContextualActions({ entities: [viewContextualEntity(view)] }, x, y, focus)}
                  />
                ))}
              </SidebarSection>
              <SidebarSection title="Projects" action={() => setDialog("project")}>
                <NavItem compact={false} icon={<Boxes size={13} />} label="All projects" active={surface === "projects"} href="/projects" onNavigate={() => navigateSurface("projects", "list")} />
                {sidebarProjects.map((project) => (
                  <NavItem key={project.id} compact={false} icon={<span className="project-dot" style={{ background: project.color }} />} label={project.name} active={surface === `project:${project.id}`} href={navigationPath({ surface: `project:${project.id}`, layout: "list", taskId: null }, data)} onNavigate={() => navigateSurface(`project:${project.id}`, "list")} />
                ))}
              </SidebarSection>
              <SidebarSection title="Releases" action={() => void openDialogWithCatalog("release", ["projects"])}>
                <NavItem compact={false} icon={<Rocket size={13} />} label="All releases" active={surface === "releases"} href="/releases" onNavigate={() => navigateSurface("releases", "list")} />
                {sidebarReleases.map((release) => (
                  <NavItem key={release.id} compact={false} icon={<CircleDot size={12} />} label={formatReleaseName(projectMap.get(release.projectId)?.name, release.name)} active={surface === `release:${release.id}`} href={navigationPath({ surface: `release:${release.id}`, layout: "list", taskId: null }, data)} onNavigate={() => navigateSurface(`release:${release.id}`, "list")} />
                ))}
              </SidebarSection>
            </>
          )}
        </nav>
        <div className="sidebar-foot">
          <div className="account-control" ref={accountMenuRef}>
            {accountMenuOpen && (
              <AccountMenu
                user={data.user}
                isAdmin={data.isAdmin}
                onNavigate={(event, nextSurface) => handleLocalLink(event, () => {
                  navigateSurface(nextSurface, "list");
                  setAccountMenuOpen(false);
                })}
              />
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
                onClick={() => void saveUserPreferences({ sidebarPreference: sidebarCollapsed ? "expanded" : "collapsed" })}
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
            {data.workspaceScope && (
              <WorkspaceScopeSelector
                value={workspaceScopeToken}
                options={data.workspaceScope.options}
                busy={workspaceScopeLoading}
                onChange={(token) => void loadWorkspaceScopeSnapshot(token)}
              />
            )}
            {resourceOwnerLabel && (
              <span className="workspace-resource-owner" title={`Resource owner: ${resourceOwnerLabel}`}>
                Owner: {resourceOwnerLabel}
              </span>
            )}
            <div className="title-actions">
              {surface.startsWith("project:") && contextProjectRecord && <a className="button ghost" href={projectReleasesPath(contextProjectRecord.publicId)} onClick={(event) => handleLocalLink(event, () => navigateSurface(`project-releases:${contextProjectRecord.id}`, "list"))}><Rocket size={14} />Releases</a>}
              {surface.startsWith("project:") && contextProjectRecord && canEditContent(contextProjectRecord.accessRole) && <button className="button ghost" onClick={() => setDialog("projectEdit")}><FolderKanban size={14} />Edit project</button>}
              {surface.startsWith("release:") && contextReleaseRecord && canEditContent(contextReleaseRecord.accessRole) && <button className="button ghost" onClick={() => setDialog("releaseEdit")}><Rocket size={14} />Edit release</button>}
              {activeSavedView && canEditContent(activeSavedView.accessRole) && <button className="button ghost" onClick={() => void openDialogWithCatalog("viewEdit", ["projects", "releases"])}><Zap size={14} />Edit view</button>}
              {surface.startsWith("project:") && contextProjectRecord?.accessRole === "owner" && <button className="button ghost" disabled={systemBackupBusy} onClick={() => void downloadProjectBackup(contextProjectRecord)}><Download size={14} />{systemBackupBusy ? "Exporting…" : "Backup"}</button>}
              {currentShareTarget && <button className="button ghost" onClick={() => setDialog("share")}><Share2 size={14} />People &amp; Teams</button>}
              {surfaceContextualEntity && canEditContent(surfaceContextualEntity.accessRole) && <button className="icon-button" type="button" aria-label={`Open contextual actions for ${surfaceContextualEntity.label}`} title="Actions (Cmd/Ctrl+K)" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openContextualActions({ entities: [surfaceContextualEntity] }, rect.right, rect.bottom, event.currentTarget); }}><MoreHorizontal size={16} /></button>}
              <button className="icon-button" title="Copy direct link" onClick={() => void copyCurrentLink()}><Link2 size={16} /></button>
            </div>
          </div>
          {!isCollectionSurface(surface) && (
            <div className="toolbar-row">
              <div className="toolbar-left">
                <div className="desktop-view-controls">
                  <div className="search-control">
                    <Search size={13} />
                    <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`${searchLabel}…`} aria-label={searchLabel} />
                    {search && <button onClick={() => setSearch("")}><X size={12} /></button>}
                  </div>
                  <div className="popover-anchor">
                    <button ref={filterTriggerRef} className={`button ghost ${filterOpen ? "active" : ""}`} aria-keyshortcuts="F" title="Filter (F)" onClick={() => { setDisplayOpen(false); void toggleFilters(); }}><ListFilter size={14} />Filter{queryFilterCount(currentViewQuery) > 0 && <span className="filter-count">{queryFilterCount(currentViewQuery)}</span>}</button>
                    {filterOpen && <FilterPopover data={data} savedView={activeSavedView} temporaryQuery={canonicalTemporaryQuery} scopeProjectId={activeSavedView?.scopeProjectId ?? contextProject} onTemporaryQuery={setTemporaryQuery} onEditSaved={activeSavedView && canEditContent(activeSavedView.accessRole) ? () => { setFilterOpen(false); void openDialogWithCatalog("viewEdit", ["projects", "releases"]); } : undefined} onClose={() => { setFilterOpen(false); filterTriggerRef.current?.focus(); }} />}
                  </div>
                  <div className="segmented" aria-label="Layout">
                    <button className={layout === "list" ? "active" : ""} aria-keyshortcuts="Meta+B Control+B" onClick={() => changeLayout("list")} title="List (⌘/Ctrl+B)"><LayoutList size={14} /></button>
                    <button className={layout === "board" ? "active" : ""} aria-keyshortcuts="Meta+B Control+B" onClick={() => changeLayout("board")} title="Board (⌘/Ctrl+B)"><Columns3 size={14} /></button>
                  </div>
                  <div className="popover-anchor display-anchor">
                    <button ref={displayTriggerRef} className={`button ghost ${displayOpen ? "active" : ""}`} aria-keyshortcuts="Shift+V" title="Display (Shift+V)" onClick={() => { setFilterOpen(false); setDisplayOpen((value) => !value); }}><SlidersHorizontal size={14} />Display</button>
                    {displayOpen && <DisplayPopover display={currentDisplay} labelGroups={data.labelGroups ?? []} onLayout={changeLayout} onDisplay={changeDisplay} onClose={() => { setDisplayOpen(false); displayTriggerRef.current?.focus(); }} />}
                  </div>
                  {hasTemporaryFilters && <button className="button ghost" onClick={clearTemporaryFilters}><X size={13} />Clear temporary</button>}
                  {hasDisplayChanges && <button className="button ghost" onClick={resetDisplayChanges}><SlidersHorizontal size={13} />Reset display</button>}
                  {canSaveView && (activeSavedView || hasRuntimeViewChanges) && <button className="button ghost" onClick={() => void openDialogWithCatalog("view", ["projects", "releases"])}><Copy size={13} />Save as</button>}
                </div>
                {activeSavedView && <SavedFilterChips data={data} view={activeSavedView} onEdit={canEditContent(activeSavedView.accessRole) ? () => void openDialogWithCatalog("viewEdit", ["projects", "releases"]) : undefined} />}
                {canonicalTemporaryQuery.conditions.length > 0 && <FilterChips data={data} query={canonicalTemporaryQuery} scopeProjectId={activeSavedView?.scopeProjectId ?? contextProject} onQuery={setTemporaryQuery} onEdit={() => void toggleFilters()} />}
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
                    aria-busy={catalogLoading && !mobileActionsOpen}
                    onClick={() => void toggleMobileViewControls()}
                  >
                    <SlidersHorizontal size={17} />
                    {queryFilterCount(currentViewQuery) > 0 && <span className="filter-count">{queryFilterCount(currentViewQuery)}</span>}
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
                      <input ref={mobileSearchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`${searchLabel}…`} aria-label={`${searchLabel} on mobile`} />
                      {search && <button type="button" aria-label="Clear search" onClick={() => setSearch("")}><X size={13} /></button>}
                    </label>
                    <section className="mobile-control-section">
                      <h3>Filter</h3>
                      <SavedViewFilterLayers data={data} savedView={activeSavedView} temporaryQuery={canonicalTemporaryQuery} scopeProjectId={activeSavedView?.scopeProjectId ?? contextProject} onTemporaryQuery={setTemporaryQuery} onEditSaved={activeSavedView && canEditContent(activeSavedView.accessRole) ? () => { setMobileActionsOpen(false); void openDialogWithCatalog("viewEdit", ["projects", "releases"]); } : undefined} compact />
                    </section>
                    <section className="mobile-control-section">
                      <h3>Display</h3>
                      <div className="segmented wide" aria-label="Mobile layout">
                        <button className={layout === "list" ? "active" : ""} onClick={() => changeLayout("list")}><LayoutList size={14} />List</button>
                        <button className={layout === "board" ? "active" : ""} onClick={() => changeLayout("board")}><Columns3 size={14} />Board</button>
                      </div>
                      <label className="mobile-display-summary"><span>Group by</span><select value={currentGroupBy} onChange={(event) => changeGroupBy(event.target.value as ViewDisplay["groupBy"])}>{groupByOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                      {currentGroupBy === "label_group" && <label className="mobile-display-summary"><span>Label group</span><select value={currentDisplay.labelGroupId ?? ""} onChange={(event) => changeDisplay({ labelGroupId: event.target.value || null })}>{(data.labelGroups ?? []).filter((group) => !group.archivedAt || group.id === currentDisplay.labelGroupId).map((group) => <option key={group.id} value={group.id}>{group.name}{group.archivedAt ? " (archived)" : ""}</option>)}</select></label>}
                      <label className="mobile-display-summary"><span>Order</span><select value={currentDisplay.orderBy} onChange={(event) => changeDisplay({ orderBy: event.target.value as ViewDisplay["orderBy"] })}>{viewOrderOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                      <label className="mobile-display-summary"><span>Direction</span><select value={currentDisplay.direction} disabled={currentDisplayDependencies.directionDisabled} aria-describedby={currentDisplayDependencies.directionReason ? "mobile-direction-help" : undefined} onChange={(event) => changeDisplay({ direction: event.target.value as ViewDisplay["direction"] })}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
                      {currentDisplayDependencies.directionReason && <small id="mobile-direction-help" className="display-dependency-hint">{currentDisplayDependencies.directionReason}</small>}
                      <fieldset className="display-properties"><legend>Properties</legend>{viewFieldOptions.map((option) => <label key={option.value}><input type="checkbox" checked={currentDisplay.visibleFields.includes(option.value)} onChange={() => changeDisplay({ visibleFields: toggleViewField(currentDisplay.visibleFields, option.value) })} />{option.label}</label>)}</fieldset>
                      <label className="display-checkbox"><input type="checkbox" checked={currentDisplay.showEmptyGroups} disabled={currentDisplayDependencies.emptyGroupsDisabled} aria-describedby={currentDisplayDependencies.emptyGroupsReason ? "mobile-empty-groups-help" : undefined} onChange={(event) => changeDisplay({ showEmptyGroups: event.target.checked })} /><span>Show empty groups</span></label>
                      {currentDisplayDependencies.emptyGroupsReason && <small id="mobile-empty-groups-help" className="display-dependency-hint">{currentDisplayDependencies.emptyGroupsReason}</small>}
                    </section>
                    <div className="mobile-controls-footer">
                      {hasTemporaryFilters && <button className="button ghost" type="button" onClick={clearTemporaryFilters}>Clear temporary</button>}
                      {hasDisplayChanges && <button className="button ghost" type="button" onClick={resetDisplayChanges}>Reset display</button>}
                      {canSaveView && (activeSavedView || hasRuntimeViewChanges) && <button className="button ghost" type="button" onClick={() => { setMobileActionsOpen(false); void openDialogWithCatalog("view", ["projects", "releases"]); }}><Copy size={14} />Save as</button>}
                    </div>
                  </div>
                </div>
              </div>
              {canCreateTask && <button className="button primary" onClick={() => openCreate()}><Plus size={14} />New task</button>}
            </div>
          )}
        </header>

        {(surface === "projects" || surface === "releases" || surface === "views") && (
          <div className="toolbar-row catalog-toolbar" aria-label={`${surface} catalog controls`}>
            <div className="toolbar-left">
              <div className="search-control">
                <Search size={13} />
                <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`${searchLabel}…`} aria-label={searchLabel} />
                {search && <button type="button" aria-label="Clear catalog search" onClick={() => setSearch("")}><X size={12} /></button>}
              </div>
              <label className="catalog-sort">
                <span>Sort</span>
                <select
                  aria-label="Sort catalog"
                  value={catalogOrder}
                  onChange={(event) => {
                    const order = event.target.value as "updated" | "name";
                    setCatalogOrder(order);
                    setCatalogDirection(order === "name" ? "asc" : "desc");
                  }}
                >
                  <option value="updated">Recently updated</option>
                  <option value="name">Name</option>
                </select>
              </label>
              <button
                className="button ghost compact"
                type="button"
                aria-label={catalogDirection === "asc" ? "Sort descending" : "Sort ascending"}
                onClick={() => setCatalogDirection((current) => current === "asc" ? "desc" : "asc")}
              >
                {catalogDirection === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                {catalogDirection === "asc" ? "Ascending" : "Descending"}
              </button>
            </div>
          </div>
        )}

        {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")}><X size={14} /></button></div>}
        {deletionConvergenceError && <DeletionConvergenceAlert
          message={deletionConvergenceError}
          busy={deletionBusy}
          onRetry={() => void retryDeletionConvergence()}
        />}
        {data.taskWindow?.truncated && !taskWindowLoading && !searchNeedle && <div className="snapshot-warning" role="status">Showing the {data.taskWindow.limit.toLocaleString()} most recently updated tasks. Narrow the workspace with a saved view or use the Agent API for the full collection.</div>}
        {(busy || taskWindowLoading) && <div className="progress-line" aria-label={busy ? "Saving" : "Loading remaining tasks"} />}

        {surface.startsWith("project:") && contextProjectRecord && <ProjectOverview project={contextProjectRecord} lead={contextProjectRecord.leadUserId ? userMap.get(contextProjectRecord.leadUserId) : undefined} tasks={data.tasks.filter((task) => task.projectId === contextProjectRecord.id && !task.archivedAt)} statuses={statusMap} onEdit={canEditContent(contextProjectRecord.accessRole) ? () => setDialog("projectEdit") : undefined} />}
        {contextReleaseRecord && <ReleaseOverview release={contextReleaseRecord} project={projectMap.get(contextReleaseRecord.projectId)} tasks={data.tasks.filter((task) => task.releaseId === contextReleaseRecord.id && !task.archivedAt)} statuses={statusMap} onEdit={canEditContent(contextReleaseRecord.accessRole) ? () => setDialog("releaseEdit") : undefined} />}
        {surface.startsWith("settings:") ? (
          <SettingsSurface
            section={surface.slice("settings:".length)}
            data={data}
            theme={theme}
            sidebarCollapsed={sidebarCollapsed}
            signOutPath={signOutPath}
            onNavigate={(section) => navigateSurface(`settings:${section}`, "list")}
            onProfile={applyUserProfile}
            onAppearance={(changes) => void saveUserPreferences(changes)}
            onStatuses={(statuses) => setData((current) => ({ ...current, statuses: [...current.statuses.filter((status) => status.ownerUserId !== current.user.id), ...statuses] }))}
            onLabels={(labels) => setData((current) => ({ ...current, labels: [...current.labels.filter((label) => label.ownerUserId !== current.user.id), ...labels] }))}
            onGroups={(labelGroups) => setData((current) => ({ ...current, labelGroups: [...(current.labelGroups ?? []).filter((group) => group.ownerUserId !== current.user.id), ...labelGroups] }))}
            recentlyDeletedEpoch={recentlyDeletedEpoch}
            onDeletionWorkspaceChanged={refreshAfterDeletionMutation}
          />
        ) : surface === "workspace" ? (
          <WorkspaceOverviewSurface
            data={data}
            statusMap={statusMap}
            projectMap={projectMap}
            onOpen={(nextSurface, nextLayout = "list") => navigateSurface(nextSurface, nextLayout)}
            onOpenTask={openTask}
            onCreateTask={() => void openCreate()}
            onCreateProject={() => setDialog("project")}
            onCreateRelease={() => void openDialogWithCatalog("release", ["projects"])}
          />
        ) : surface === "shared" ? (
          <SharedWithMeSurface
            data={{
              ...data,
              projects: catalogPages.projects?.projects ?? data.projects,
              views: catalogPages.views?.views ?? data.views,
            }}
            tasks={data.tasks}
            statuses={data.statuses}
            users={userMap}
            onOpenProject={(id) => navigateSurface(`project:${id}`, "list")}
            onOpenView={(view) => navigateSurface(`view:${view.id}`, view.display.layout)}
            onProjectContextActions={(project, x, y, focus) => openContextualActions(
              { entities: [projectContextualEntity(project)] },
              x,
              y,
              focus,
            )}
          />
        ) : surface === "teams" ? (
          <TeamsSurface currentUser={data.user} />
        ) : surface === "admin" && data.admin ? (
          <AdminSurface
            overview={data.admin}
            timeZone={data.user.timezone}
            backupBusy={systemBackupBusy}
            exportActive={Boolean(
              systemExportStartFlightRef.current ||
              (systemExportStatus && !backupJobIsTerminal(systemExportStatus)),
            )}
            onExport={openSystemExport}
            onImport={() => setDialog("systemImport")}
          />
        ) : surface === "views" ? (
          <><ViewsSurface data={{ ...data, views: catalogPages.views?.views ?? data.views }} statusMap={statusMap} onOpen={(nextSurface, nextLayout) => navigateSurface(nextSurface, nextLayout)} onContextActions={(view, x, y, focus) => openContextualActions({ entities: [viewContextualEntity(view)] }, x, y, focus)} onRestore={(view) => mutate(`/api/views/${view.id}`, "PATCH", { version: view.version, archived: false })} busy={busy} />{catalogPages.views?.page.hasMore && <CatalogPagination busy={catalogLoading} onMore={() => void loadMoreCatalog("views")} />}</>
        ) : surface === "projects" ? (
          <><ProjectsSurface projects={catalogPages.projects?.projects ?? data.projects} tasks={data.tasks} statuses={data.statuses} users={userMap} onOpen={(id) => navigateSurface(`project:${id}`, "list")} onContextActions={(project, x, y, focus) => openContextualActions({ entities: [projectContextualEntity(project)] }, x, y, focus)} onCreate={() => setDialog("project")} />{catalogPages.projects?.page.hasMore && <CatalogPagination busy={catalogLoading} onMore={() => void loadMoreCatalog("projects")} />}</>
        ) : surface === "releases" || projectReleaseSurfaceId ? (
          <><ReleasesSurface releases={surface === "releases" ? (catalogPages.releases?.releases ?? data.releases) : scopedReleases} projects={projectMap} tasks={data.tasks} statuses={data.statuses} onOpen={(id) => navigateSurface(`release:${id}`, "list")} onContextActions={(release, x, y, focus) => openContextualActions({ entities: [releaseContextualEntity(release)] }, x, y, focus)} onCreate={() => { if (canCreateTask) void openDialogWithCatalog("release", ["projects"]); }} />{surface === "releases" && catalogPages.releases?.page.hasMore && <CatalogPagination busy={catalogLoading} onMore={() => void loadMoreCatalog("releases")} />}</>
        ) : taskSearchStatus ? (
          <TaskSearchNotice status={taskSearchStatus} />
        ) : layout === "board" ? (
          <><TaskBoard tasks={visibleTasks} hierarchyTasks={data.tasks} groups={taskGroups} groupBy={currentGroupBy} visibleFields={currentDisplay.visibleFields} canReorder={currentDisplay.orderBy === "manual"} canMoveGroups={currentGroupBy !== "none"} statuses={statusMap} projects={projectMap} releases={releaseMap} users={userMap} labelContext={data} selected={selected} highlightedTaskId={highlightedTaskId} canCreate={canCreateTask} createOwnerUserId={contextProjectRecord?.ownerUserId ?? data.user.id} createAssigneeUserIds={createAssigneeUserIds} onSelect={toggleSelection} onHighlight={setHighlightedTaskId} onOpen={openTask} onContextActions={openTaskContextualActions} onCreate={(defaults) => openCreate(defaults)} onMove={moveTaskToGroup} onDragState={setDraggingTaskId} />{taskSearch?.query === taskQueryKey && taskSearch.page?.hasMore && <TaskQueryPagination busy={taskQueryPaging} onMore={() => void loadMoreFilteredTasks()} />}</>
        ) : (
          <><TaskList tasks={visibleTasks} hierarchyTasks={data.tasks} groups={taskGroups} statuses={statusMap} groupBy={currentGroupBy} visibleFields={currentDisplay.visibleFields} canReorder={currentDisplay.orderBy === "manual"} canMoveGroups={currentGroupBy !== "none"} projects={projectMap} releases={releaseMap} users={userMap} labelContext={data} selected={selected} highlightedTaskId={highlightedTaskId} collapsed={collapsedGroups} canCreate={canCreateTask} createOwnerUserId={contextProjectRecord?.ownerUserId ?? data.user.id} createAssigneeUserIds={createAssigneeUserIds} pullRefreshing={pullRefreshing} pullRefreshError={pullRefreshError} pullRefreshDisabled={busy || taskWindowLoading} onRefresh={refreshTaskList} onToggleGroup={(id) => setCollapsedGroups((current) => toggleSet(current, id))} onSelect={toggleSelection} onHighlight={setHighlightedTaskId} onOpen={openTask} onContextActions={openTaskContextualActions} onCreate={(defaults) => openCreate(defaults)} onMove={moveTaskToGroup} onStatusChange={(task, statusId) => mutate(`/api/tasks/${task.id}`, "PATCH", { version: taskMutationVersion(task), statusId })} onDragState={setDraggingTaskId} />{taskSearch?.query === taskQueryKey && taskSearch.page?.hasMore && <TaskQueryPagination busy={taskQueryPaging} onMore={() => void loadMoreFilteredTasks()} />}</>
        )}
      </section>

      {selected.size > 0 && (
        <BulkBar data={data} tasks={selectedTasks} statuses={statusGroupsForTasks(selectedTasks, data.statuses)} archiveAction={archiveAction} onStatus={(value) => mutate("/api/tasks/bulk", "POST", { ids: [...selected], versions: selectedTaskVersions, field: "statusId", value }).then((ok) => ok && setSelected(new Set()))} onPriority={(value) => mutate("/api/tasks/bulk", "POST", { ids: [...selected], versions: selectedTaskVersions, field: "priority", value }).then((ok) => ok && setSelected(new Set()))} onAssignee={(value) => mutate("/api/tasks/bulk", "POST", { ids: [...selected], versions: selectedTaskVersions, field: "assigneeUserId", value }).then((ok) => ok && setSelected(new Set()))} onProject={() => void openDialogWithCatalog("bulkProject", ["projects", "releases"])} onRelease={() => void openDialogWithCatalog("bulkRelease", ["releases"])} onLabel={(labelId, active) => mutate("/api/tasks/labels/bulk", "POST", { ids: [...selected], labelId, active })} onArchive={() => mutate("/api/tasks/bulk", "POST", { ids: [...selected], versions: selectedTaskVersions, field: "archived", value: archiveAction.archived }).then((ok) => ok && setSelected(new Set()))} onClose={() => setSelected(new Set())} />
      )}

      {contextualMenu && (
        <ContextualActionMenu
          actions={resolveContextualActions(contextualMenu.context)}
          x={contextualMenu.x}
          y={contextualMenu.y}
          busy={busy}
          onExecute={executeContextualAction}
          onClose={closeContextualActions}
        />
      )}

      {recoverableDeletion && <RecoverableDeleteDialog
        target={recoverableDeletion}
        busy={deletionBusy}
        onConfirm={() => void deleteRecoverably()}
        onClose={() => setRecoverableDeletion(null)}
      />}
      {deletionUndo && <DeletionUndoToast
        label={deletionUndo.label}
        busy={deletionBusy}
        onUndo={() => void undoRecoverableDelete()}
        onDismiss={() => setDeletionUndo(null)}
      />}

      {activeTask && <div className={currentShareTarget ? undefined : "details-no-share"}>{activeTask.description === null ? <TaskDetailsLoading task={activeTask} onClose={closeTask} /> : <TaskDetails key={activeTask.id} task={activeTask} data={activeDetailsData} catalogReady={taskPropertyCatalogReady} onClose={closeTask} onOpenTask={openTask} onContextActions={(x, y, focus) => openContextualActions({ entities: [taskContextualEntity(activeTask)] }, x, y, focus)} onSave={async (changes) => { const nextReleaseId = Object.hasOwn(changes, "releaseId") ? changes.releaseId as string | null : activeTask.releaseId; const confirmReleasedComposition = releasedCompositionNeedsConfirmation(activeTask.releaseId, nextReleaseId, data.releases); if (confirmReleasedComposition && !confirmReleasedCompositionChange()) return false; return mutate(`/api/tasks/${activeTask.id}`, "PATCH", { version: taskMutationVersion(activeTask), ...changes, ...(confirmReleasedComposition ? { confirmReleasedComposition: true } : {}) }); }} onMove={async (changes) => { const nextReleaseId = Object.hasOwn(changes, "releaseId") ? changes.releaseId as string | null : null; const confirmReleasedComposition = releasedCompositionNeedsConfirmation(activeTask.releaseId, nextReleaseId, data.releases); if (confirmReleasedComposition && !confirmReleasedCompositionChange()) return false; return mutate(`/api/tasks/${activeTask.id}/move`, "POST", { version: taskMutationVersion(activeTask), ...changes, ...(confirmReleasedComposition ? { confirmReleasedComposition: true } : {}) }); }} onSetParent={(parentTaskId) => mutate(`/api/tasks/${activeTask.id}/parent`, "PATCH", { version: taskMutationVersion(activeTask), parentTaskId })} onCreateSubtask={(title) => mutate(`/api/tasks/${activeTask.id}/subtasks`, "POST", { version: taskMutationVersion(activeTask), title })} onSetLabel={(labelId, active) => mutate(`/api/tasks/${activeTask.id}/labels`, "POST", { labelId, active })} onRebase={refreshTaskDetail} onRelationMutation={(tasks, dependencies) => reconcileSuccessfulTaskMutation(tasks, dataRef.current, dataRef.current, dependencies)} onShare={() => setDialog("share")} busy={busy} />}</div>}
      {pendingMoveTask && pendingMoveSourceProject && pendingMoveTargetProject && (
        <TaskMoveDialog
          task={pendingMoveTask}
          sourceProject={pendingMoveSourceProject}
          targetProject={pendingMoveTargetProject}
          data={data}
          parent={pendingMoveParent}
          subtasks={pendingMoveSubtasks}
          busy={busy}
          onClose={() => setPendingProjectMove(null)}
          onMove={async (changes) => {
            const nextReleaseId = Object.hasOwn(changes, "releaseId")
              ? changes.releaseId as string | null
              : null;
            const confirmReleasedComposition = releasedCompositionNeedsConfirmation(
              pendingMoveTask.releaseId,
              nextReleaseId,
              data.releases,
            );
            if (confirmReleasedComposition && !confirmReleasedCompositionChange()) return;
            const moved = await mutate(`/api/tasks/${pendingMoveTask.id}/move`, "POST", {
              version: taskMutationVersion(pendingMoveTask),
              ...changes,
              ...(confirmReleasedComposition ? { confirmReleasedComposition: true } : {}),
            });
            if (moved) setPendingProjectMove(null);
          }}
        />
      )}
      {peekTask && <Peek task={peekTask} status={statusMap.get(peekTask.statusId)} project={peekTask.projectId ? projectMap.get(peekTask.projectId) : undefined} labels={labelsForTask(data, peekTask.id)} hierarchy={taskHierarchySummary(peekTask, data.tasks)} onClose={() => setPeekTaskId(null)} onOpen={() => { openTask(peekTask.id); setPeekTaskId(null); }} />}
      {dialog === "task" && canCreateTask && <TaskComposer data={data} contextProject={contextProject} contextRelease={contextRelease} defaults={createDefaults} onClose={() => setDialog(null)} onSubmit={createTaskForComposer} busy={busy} />}
      {dialog === "project" && <ProjectDialog currentUser={data.user} leadOptions={[data.user]} openTaskCount={0} onClose={() => setDialog(null)} onSubmit={async (input) => { const before = new Set(dataRef.current.projects.map((project) => project.id)); const ok = await mutate("/api/projects", "POST", input); if (!ok) return; const created = dataRef.current.projects.find((project) => !before.has(project.id)); setDialog(null); if (created) { const next = { surface: `project:${created.id}`, layout: "list" as const, taskId: null }; setSurface(next.surface); setLayout(next.layout); setActiveTaskId(null); const path = `/projects/${encodeURIComponent(created.publicId)}`; taskReturnPath.current = path; window.history.pushState(navigationStateWithWorkspaceScope(next, workspaceScopeTokenRef.current), "", path); } }} busy={busy} />}
      {dialog === "projectEdit" && contextProjectRecord && <ProjectDialog project={contextProjectRecord} currentUser={data.user} leadOptions={projectMemberOptions(data, contextProjectRecord)} openTaskCount={openProjectTaskCount(contextProjectRecord.id, data.tasks, statusMap)} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate(`/api/projects/${contextProjectRecord.id}`, "PATCH", { version: contextProjectRecord.version, ...input }); if (ok) setDialog(null); }} onArchive={async () => { const ok = await mutate(`/api/projects/${contextProjectRecord.id}`, "PATCH", { version: contextProjectRecord.version, archived: !contextProjectRecord.archivedAt }); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "release" && <ReleaseDialog projects={data.projects.filter((project) => !project.archivedAt && canEditContent(project.accessRole))} initialProjectId={contextProject} openTaskCount={0} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/releases", "POST", input); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "releaseEdit" && contextReleaseRecord && <ReleaseDialog release={contextReleaseRecord} projects={data.projects.filter((project) => project.id === contextReleaseRecord.projectId)} initialProjectId={contextReleaseRecord.projectId} openTaskCount={openReleaseTaskCount(contextReleaseRecord.id, data.tasks, statusMap)} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate(`/api/releases/${contextReleaseRecord.id}`, "PATCH", { version: contextReleaseRecord.version, ...input }); if (ok) setDialog(null); }} onDelete={() => void openRecoverableDelete(releaseContextualEntity(contextReleaseRecord))} busy={busy} />}
      {dialog === "view" && canSaveView && <ViewDialog view={activeSavedView} editing={false} query={currentViewQuery} display={currentDisplay} data={data} initialScopeProjectId={activeSavedView?.scopeProjectId ?? contextProject} temporaryFilterCount={0} submissionError={error} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/views", "POST", input); if (ok) setDialog(null); return ok; }} busy={busy} />}
      {dialog === "viewEdit" && activeSavedView && canSaveView && <ViewDialog key={activeSavedView.id} view={activeSavedView} editing query={activeSavedView.query} display={activeSavedView.display} data={data} initialScopeProjectId={activeSavedView.scopeProjectId} temporaryFilterCount={queryFilterCount(temporaryViewQuery)} submissionError={error} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate(`/api/views/${activeSavedView.id}`, "PATCH", { version: activeSavedView.version, ...input }, { onConflict: refreshSavedViewsAfterConflict, conflictMessage: "This Saved View changed in another session. The latest saved version was reloaded; review it and try again." }); if (ok) { setDialog(null); setDisplayOverrides((current) => { const next = { ...current }; delete next[surface]; return next; }); const savedDisplay = input.display as ViewDisplay; if (savedDisplay.layout !== layout) changeLayout(savedDisplay.layout); } return ok; }} busy={busy} />}
      {dialog === "share" && <ShareDialog target={currentShareTarget} currentUser={data.user} users={data.users} collaborators={data.collaborators} onClose={() => setDialog(null)} onShare={(input) => mutate("/api/shares", "POST", input)} onRoleChange={(grantId, permission) => mutate("/api/shares", "PATCH", { grantId, permission })} onRevoke={(grantId) => mutate("/api/shares", "DELETE", { grantId })} onTransfer={(projectId, targetUserId) => mutate("/api/shares/transfer", "POST", { projectId, targetUserId })} busy={busy} />}
      {dialog === "systemExport" && <SystemBackupExportDialog
        status={systemExportStatus}
        busy={systemExportRunning || Boolean(systemExportStartFlightRef.current)}
        waitingForNetwork={systemExportWaitingForNetwork}
        error={systemExportError}
        onClose={() => setDialog(null)}
        onStart={(fresh) => void startSystemExport(fresh)}
        onResume={() => {
          const current = systemExportStatusRef.current;
          if (current && !backupJobIsTerminal(current)) void driveSystemExport(current);
        }}
      />}
      {dialog === "systemImport" && <SystemImportDialog onClose={() => setDialog(null)} onBusyChange={setSystemBackupBusy} onApplied={() => window.location.assign("/admin")} />}
      {dialog === "codexSetup" && <CodexSetupDialog onClose={() => setDialog(null)} />}
      {dialog === "workflowSettings" && <WorkflowSettingsDialog initialStatuses={data.statuses.filter((status) => status.ownerUserId === data.user.id)} onClose={() => setDialog(null)} onStatuses={(statuses) => setData((current) => ({ ...current, statuses: [...current.statuses.filter((status) => status.ownerUserId !== current.user.id), ...statuses] }))} />}
      {dialog === "labelSettings" && <LabelSettingsDialog onClose={() => setDialog(null)} onLabels={(labels) => setData((current) => ({ ...current, labels: [...current.labels.filter((label) => label.ownerUserId !== current.user.id), ...labels] }))} onGroups={(labelGroups) => setData((current) => ({ ...current, labelGroups: [...(current.labelGroups ?? []).filter((group) => group.ownerUserId !== current.user.id), ...labelGroups] }))} />}
      {dialog === "labelGroupSettings" && <LabelGroupSettingsDialog initialGroups={(data.labelGroups ?? []).filter((group) => group.ownerUserId === data.user.id)} initialLabels={data.labels.filter((label) => label.ownerUserId === data.user.id)} onClose={() => setDialog(null)} onGroups={(labelGroups) => setData((current) => ({ ...current, labelGroups: [...(current.labelGroups ?? []).filter((group) => group.ownerUserId !== current.user.id), ...labelGroups] }))} onLabels={(labels) => setData((current) => ({ ...current, labels: [...current.labels.filter((label) => label.ownerUserId !== current.user.id), ...labels] }))} />}
      {dialog === "bulkProject" && selectedTasks.length > 0 && <BulkProjectDialog data={data} tasks={selectedTasks} busy={busy} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/tasks/bulk", "POST", { ids: [...selected], versions: selectedTaskVersions, field: "projectId", value: input.targetProjectId, clearRelease: input.clearRelease, clearAssignee: input.clearAssignee, confirmReleasedComposition: input.confirmReleasedComposition }); if (ok) { setDialog(null); setSelected(new Set()); } }} />}
      {dialog === "bulkRelease" && selectedTasks.length > 0 && <BulkReleaseDialog data={data} tasks={selectedTasks} busy={busy} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/tasks/bulk", "POST", { ids: [...selected], versions: selectedTaskVersions, field: "releaseId", value: input.releaseId, confirmReleasedComposition: input.confirmReleasedComposition }); if (ok) { setDialog(null); setSelected(new Set()); } }} />}
    </main>
  );
}

function NavItem({ compact, icon, label, active, href, onNavigate, count }: { compact: boolean; icon: React.ReactNode; label: string; active: boolean; href: string; onNavigate: () => void; count?: number }) {
  return <a className={`nav-item ${active ? "active" : ""}`} href={href} aria-current={active ? "page" : undefined} aria-label={label} onClick={(event) => handleLocalLink(event, onNavigate)} title={label}><span className="nav-icon">{icon}</span>{!compact && <><span className="nav-label">{label}</span>{count !== undefined && <small className="nav-count">{count}</small>}</>}</a>;
}

function SidebarSavedViewItem({ view, active, href, onNavigate, onContextActions }: {
  view: SavedViewRecord;
  active: boolean;
  href: string;
  onNavigate: () => void;
  onContextActions: (x: number, y: number, restoreFocus: HTMLElement | null) => void;
}) {
  const editable = canEditContent(view.accessRole);
  return <div className="sidebar-saved-view-item">
    <NavItem compact={false} icon={<Zap size={13} />} label={view.name} active={active} href={href} onNavigate={onNavigate} />
    {editable && <button type="button" aria-label={`Open actions for ${view.name}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onContextActions(rect.right, rect.bottom, event.currentTarget); }}><MoreHorizontal size={14} /></button>}
  </div>;
}

function WorkspaceScopeSelector({ value, options, busy, onChange }: {
  value: string;
  options: NonNullable<AppSnapshot["workspaceScope"]>["options"];
  busy: boolean;
  onChange: (token: string) => void;
}) {
  return (
    <label className="workspace-scope-selector">
      <UsersRound size={14} aria-hidden="true" />
      <span>Owner workspace</span>
      <select
        value={value}
        disabled={busy}
        aria-label="Owner workspace"
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.token} value={option.token}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function SidebarSection({ title, action, children }: { title: string; action: () => void; children: React.ReactNode }) {
  return <section className="sidebar-section"><div className="section-label"><span>{title}</span><button onClick={action} title={`Add ${title.toLowerCase()}`}><Plus size={12} /></button></div>{children}</section>;
}

function TaskList({ tasks, hierarchyTasks, groups, statuses, groupBy, visibleFields, canReorder, canMoveGroups, projects, releases, users, labelContext, selected, highlightedTaskId, collapsed, canCreate, createOwnerUserId, createAssigneeUserIds, pullRefreshing, pullRefreshError, pullRefreshDisabled, onRefresh, onToggleGroup, onSelect, onHighlight, onOpen, onContextActions, onCreate, onMove, onStatusChange, onDragState }: { tasks: TaskRecord[]; hierarchyTasks: TaskRecord[]; groups: TaskGroup[]; statuses: Map<string, WorkflowStatusRecord>; groupBy: ViewDisplay["groupBy"]; visibleFields: ViewDisplay["visibleFields"]; canReorder: boolean; canMoveGroups: boolean; projects: Map<string, ProjectRecord>; releases: Map<string, ReleaseRecord>; users: Map<string, UserRecord>; labelContext: Pick<AppSnapshot, "labels" | "taskLabels">; selected: Set<string>; highlightedTaskId: string | null; collapsed: Set<string>; canCreate: boolean; createOwnerUserId: string; createAssigneeUserIds: ReadonlySet<string>; pullRefreshing: boolean; pullRefreshError: string; pullRefreshDisabled: boolean; onRefresh: () => Promise<AppSnapshot>; onToggleGroup: (id: string) => void; onSelect: (id: string, extendRange?: boolean) => void; onHighlight: (taskId: string) => void; onOpen: (id: string) => void; onContextActions: (task: TaskRecord, x: number, y: number, restoreFocus: HTMLElement | null) => void; onCreate: (defaults?: TaskCreateDefaults) => void; onMove: (task: TaskRecord, group: TaskGroup | null, previousTaskId: string | null, nextTaskId: string | null) => Promise<unknown>; onStatusChange: (task: TaskRecord, statusId: string) => Promise<unknown>; onDragState: (taskId: string | null) => void }) {
  const [over, setOver] = useState<string | null>(null);
  const hierarchySummaries = useMemo(
    () => buildTaskHierarchySummaries(hierarchyTasks),
    [hierarchyTasks],
  );
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

  function moveFromDrop(
    draggedTaskId: string,
    group: TaskGroup | null,
    groupTasks: TaskRecord[],
    beforeTaskId: string | null,
  ) {
    const task = tasks.find((item) => item.id === draggedTaskId);
    if (!task || selected.size > 1 || group && !canMoveTaskToGroup(task, group)) return;
    if (!canReorder && (!canMoveGroups || !group || beforeTaskId !== null)) return;
    const neighbors = canReorder
      ? reorderInsertionNeighbors(groupTasks, task.id, beforeTaskId)
      : { previousTaskId: null, nextTaskId: null };
    void onMove(task, group, neighbors.previousTaskId, neighbors.nextTaskId);
  }

  function moveFromKeyboard(
    task: TaskRecord,
    group: TaskGroup | null,
    groupTasks: TaskRecord[],
    direction: "up" | "down",
  ) {
    const neighbors = keyboardReorderNeighbors(groupTasks, task.id, direction);
    if (neighbors) void onMove(task, group, neighbors.previousTaskId, neighbors.nextTaskId);
  }

  if (!tasks.length) {
    content = <EmptyState onCreate={canCreate ? () => onCreate() : undefined} />;
  } else if (groupBy === "none") {
    content = tasks.map((task) => {
      const status = statuses.get(task.statusId);
      return status ? <TaskRow key={task.id} task={task} status={status} statusOptions={taskStatusOptions(task, statuses)} showStatus project={task.projectId ? projects.get(task.projectId) : undefined} release={task.releaseId ? releases.get(task.releaseId) : undefined} assignee={task.assigneeUserId ? users.get(task.assigneeUserId) : undefined} labels={labelsForTask(labelContext, task.id)} hierarchy={hierarchySummaries.get(task.id) ?? EMPTY_TASK_HIERARCHY_SUMMARY} visibleFields={visibleFields} selected={selected.has(task.id)} highlighted={highlightedTaskId === task.id} canDrag={canReorder && selected.size <= 1} reorderEnabled={canReorder} dropBefore={over === `before:${task.id}`} onDragTarget={(active) => setOver(active ? `before:${task.id}` : null)} onDropBefore={(draggedId) => moveFromDrop(draggedId, null, tasks, task.id)} onKeyboardMove={(direction) => moveFromKeyboard(task, null, tasks, direction)} onStatusChange={(statusId) => onStatusChange(task, statusId)} onSelect={(extendRange) => onSelect(task.id, extendRange)} onHighlight={() => onHighlight(task.id)} onOpen={() => onOpen(task.id)} onContextActions={(x, y, focus) => onContextActions(task, x, y, focus)} onDragState={onDragState} /> : null;
    });
  } else {
    content = groups.map((group) => {
      const isCollapsed = collapsed.has(group.id);
      const groupCanCreate = canCreateInTaskGroup(group, canCreate, createOwnerUserId, createAssigneeUserIds);
      return <section
        className={`task-group ${over === group.id ? "drag-over" : ""}`}
        data-drop-target={group.kind}
        key={group.id}
        onDragOver={(event) => {
          if (!canMoveGroups) return;
          event.preventDefault();
          setOver(group.id);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
        }}
        onDrop={(event) => {
          if (!canMoveGroups) return;
          event.preventDefault();
          const id = event.dataTransfer.getData("text/task-id");
          const task = tasks.find((item) => item.id === id);
          setOver(null);
          onDragState(null);
          if (task) moveFromDrop(task.id, group, group.tasks, null);
        }}
      ><div className="group-header"><button className="group-title" onClick={() => onToggleGroup(group.id)}><ChevronDown size={13} className={isCollapsed ? "rotated" : ""} /><TaskGroupIcon group={group} /><span>{group.label}</span><small>{group.tasks.length}</small></button>{groupCanCreate && <button className="icon-button quiet" onClick={() => onCreate(taskGroupCreateDefaults(group) as TaskCreateDefaults)} title={`Add to ${group.label}`}><Plus size={13} /></button>}</div>{!isCollapsed && group.tasks.map((task) => { const status = statuses.get(task.statusId); return status ? <TaskRow key={task.id} task={task} status={status} statusOptions={taskStatusOptions(task, statuses)} showStatus={groupBy !== "status"} project={task.projectId ? projects.get(task.projectId) : undefined} release={task.releaseId ? releases.get(task.releaseId) : undefined} assignee={task.assigneeUserId ? users.get(task.assigneeUserId) : undefined} labels={labelsForTask(labelContext, task.id)} hierarchy={hierarchySummaries.get(task.id) ?? EMPTY_TASK_HIERARCHY_SUMMARY} visibleFields={visibleFields} selected={selected.has(task.id)} highlighted={highlightedTaskId === task.id} canDrag={(canReorder || canMoveGroups) && selected.size <= 1} reorderEnabled={canReorder} dragGroupLabel={displayLabel(group.kind)} dropBefore={canReorder && over === `before:${task.id}`} onDragTarget={(active) => setOver(active ? `before:${task.id}` : null)} onDropBefore={(draggedId) => moveFromDrop(draggedId, group, group.tasks, task.id)} onKeyboardMove={(direction) => moveFromKeyboard(task, group, group.tasks, direction)} onStatusChange={(statusId) => onStatusChange(task, statusId)} onSelect={(extendRange) => onSelect(task.id, extendRange)} onHighlight={() => onHighlight(task.id)} onOpen={() => onOpen(task.id)} onContextActions={(x, y, focus) => onContextActions(task, x, y, focus)} onDragState={onDragState} /> : null; })}</section>;
    });
  }

  return <div
    ref={pullListRef}
    role="list"
    aria-label="Tasks"
    className={`task-list ${groupBy === "none" ? "ungrouped" : ""} ${over === "end:none" ? "drag-over" : ""}`}
    onDragOver={(event) => {
      if (groupBy !== "none" || !canReorder) return;
      event.preventDefault();
      setOver("end:none");
    }}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
    }}
    onDrop={(event) => {
      if (groupBy !== "none" || !canReorder) return;
      event.preventDefault();
      const draggedId = event.dataTransfer.getData("text/task-id");
      setOver(null);
      onDragState(null);
      if (draggedId) moveFromDrop(draggedId, null, tasks, null);
    }}
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

function TaskRow({ task, status, statusOptions, showStatus, project, release, assignee, labels, hierarchy, visibleFields, selected, highlighted, canDrag, reorderEnabled, dragGroupLabel, dropBefore, onDragTarget, onDropBefore, onKeyboardMove, onStatusChange, onSelect, onHighlight, onOpen, onContextActions, onDragState }: { task: TaskRecord; status: WorkflowStatusRecord; statusOptions: WorkflowStatusRecord[]; showStatus: boolean; project?: ProjectRecord; release?: ReleaseRecord; assignee?: UserRecord; labels: LabelRecord[]; hierarchy: TaskHierarchySummary; visibleFields: ViewDisplay["visibleFields"]; selected: boolean; highlighted: boolean; canDrag: boolean; reorderEnabled: boolean; dragGroupLabel?: string; dropBefore: boolean; onDragTarget: (active: boolean) => void; onDropBefore: (draggedTaskId: string) => void; onKeyboardMove: (direction: "up" | "down") => void; onStatusChange: (statusId: string) => Promise<unknown>; onSelect: (extendRange?: boolean) => void; onHighlight: () => void; onOpen: () => void; onContextActions: (x: number, y: number, restoreFocus: HTMLElement | null) => void; onDragState: (taskId: string | null) => void }) {
  const editable = canEditContent(task.accessRole);
  const draggable = editable && canDrag;
  const reorderTitle = editable
    ? reorderEnabled
      ? "Drag to reorder; Option+Arrow Up or Down also moves this Task"
      : dragGroupLabel
        ? `Drag to change ${dragGroupLabel}; Priority order remains authoritative`
        : "Choose Manual order to reorder Tasks"
    : undefined;
  return <div role="button" tabIndex={0} data-task-keyboard-id={task.id} data-context-entity-kind="task" data-context-entity-id={task.id} aria-pressed={selected} aria-current={highlighted ? "true" : undefined} title={reorderTitle} className={`task-row ${showStatus ? "show-status" : ""} ${selected ? "selected" : ""} ${highlighted ? "highlighted" : ""} ${dropBefore ? "drop-before" : ""}`} draggable={draggable} onContextMenu={(event) => { event.preventDefault(); onContextActions(event.clientX, event.clientY, event.currentTarget); }} onDragStart={(event) => { if (!draggable) return; event.dataTransfer.setData("text/task-id", task.id); event.dataTransfer.effectAllowed = "move"; onDragState(task.id); }} onDragEnd={() => { onDragTarget(false); onDragState(null); }} onDragOver={(event) => { if (!reorderEnabled) return; event.preventDefault(); event.stopPropagation(); onDragTarget(true); }} onDragLeave={() => onDragTarget(false)} onDrop={(event) => { if (!reorderEnabled) return; event.preventDefault(); event.stopPropagation(); const draggedId = event.dataTransfer.getData("text/task-id"); onDragTarget(false); onDragState(null); if (draggedId) onDropBefore(draggedId); }} onClick={(event) => { if (event.target === event.currentTarget) onOpen(); }} onKeyDown={(event) => { const reorderDirection = taskRowReorderDirection({ draggable, reorderEnabled, altKey: event.altKey, key: event.key, targetIsRow: event.target === event.currentTarget }); if (reorderDirection) { event.preventDefault(); onKeyboardMove(reorderDirection); return; } if (event.target === event.currentTarget && event.key === "Enter") { event.preventDefault(); onOpen(); } }} onMouseEnter={onHighlight} onFocus={onHighlight}>{editable ? <button className={`row-check ${selected ? "checked" : ""}`} onClick={(event) => { event.stopPropagation(); onSelect(event.shiftKey); }} aria-label={selected ? "Deselect task" : "Select task"}>{selected ? <Check size={12} /> : <span />}</button> : <span className="row-check-spacer" />}{visibleFields.includes("priority") ? <PriorityIcon priority={task.priority} /> : <span className="priority-icon-placeholder" />}<a className="task-identity" href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, onOpen)}>{task.identifier}</a>{showStatus && <TaskStatusControl status={status} statuses={statusOptions} onChange={editable ? onStatusChange : undefined} />}<a className="task-title" href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, onOpen)} title={task.title}>{task.title}</a><div className="row-metadata">{labels.slice(0, 3).map((label) => <LabelChip key={label.id} label={label} />)}{labels.length > 3 && <span className="label-overflow">+{labels.length - 3}</span>}<TaskHierarchyChip hierarchy={hierarchy} />{visibleFields.includes("project") && project && <span className="metadata-chip" title={project.name}><span className="project-dot" style={{ background: project.color }} />{project.name}</span>}{visibleFields.includes("release") && release && <span className="metadata-chip" title={release.name}><Rocket size={12} />{release.name}</span>}{visibleFields.includes("dueDate") && task.dueDate && <span className={`metadata-chip ${isOverdue(task.dueDate, status.category) ? "overdue" : ""}`}><CalendarDays size={12} />{shortDate(task.dueDate)}</span>}{visibleFields.includes("assignee") && assignee && <span className="avatar" title={assignee.displayName}>{initials(assignee.displayName)}</span>}<button className="row-more" type="button" data-context-entity-kind="task" data-context-entity-id={task.id} aria-label={`Open contextual actions for ${task.identifier}`} title="Actions" onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); onContextActions(rect.right, rect.bottom, event.currentTarget); }}><MoreHorizontal size={14} /></button></div></div>;
}

function TaskBoard({ tasks, hierarchyTasks, groups, groupBy, visibleFields, canReorder, canMoveGroups, statuses, projects, releases, users, labelContext, selected, highlightedTaskId, canCreate, createOwnerUserId, createAssigneeUserIds, onSelect, onHighlight, onOpen, onContextActions, onCreate, onMove, onDragState }: { tasks: TaskRecord[]; hierarchyTasks: TaskRecord[]; groups: TaskGroup[]; groupBy: ViewDisplay["groupBy"]; visibleFields: ViewDisplay["visibleFields"]; canReorder: boolean; canMoveGroups: boolean; statuses: Map<string, WorkflowStatusRecord>; projects: Map<string, ProjectRecord>; releases: Map<string, ReleaseRecord>; users: Map<string, UserRecord>; labelContext: Pick<AppSnapshot, "labels" | "taskLabels">; selected: Set<string>; highlightedTaskId: string | null; canCreate: boolean; createOwnerUserId: string; createAssigneeUserIds: ReadonlySet<string>; onSelect: (id: string, extendRange?: boolean) => void; onHighlight: (taskId: string) => void; onOpen: (id: string) => void; onContextActions: (task: TaskRecord, x: number, y: number, restoreFocus: HTMLElement | null) => void; onCreate: (defaults?: TaskCreateDefaults) => void; onMove: (task: TaskRecord, group: TaskGroup | null, previousTaskId: string | null, nextTaskId: string | null) => Promise<unknown>; onDragState: (taskId: string | null) => void }) {
  const [over, setOver] = useState<string | null>(null);
  const hierarchySummaries = useMemo(
    () => buildTaskHierarchySummaries(hierarchyTasks),
    [hierarchyTasks],
  );
  function moveFromDrop(draggedTaskId: string, group: TaskGroup | null, groupTasks: TaskRecord[], beforeTaskId: string | null) {
    const task = tasks.find((item) => item.id === draggedTaskId);
    if (!task || selected.size > 1 || group && !canMoveTaskToGroup(task, group)) return;
    if (!canReorder && (!canMoveGroups || !group || beforeTaskId !== null)) return;
    const neighbors = canReorder
      ? reorderInsertionNeighbors(groupTasks, task.id, beforeTaskId)
      : { previousTaskId: null, nextTaskId: null };
    void onMove(task, group, neighbors.previousTaskId, neighbors.nextTaskId);
  }
  function moveFromKeyboard(task: TaskRecord, group: TaskGroup | null, groupTasks: TaskRecord[], direction: "up" | "down") {
    const neighbors = keyboardReorderNeighbors(groupTasks, task.id, direction);
    if (neighbors) void onMove(task, group, neighbors.previousTaskId, neighbors.nextTaskId);
  }
  if (!tasks.length) return <EmptyState onCreate={canCreate ? () => onCreate() : undefined} />;
  if (groupBy === "none") {
    return <div className="board" role="list" aria-label="Tasks"><section className={`board-column ${over === "end:none" ? "drag-over" : ""}`} onDragOver={(event) => { if (!canReorder) return; event.preventDefault(); setOver("end:none"); }} onDragLeave={() => setOver(null)} onDrop={(event) => { if (!canReorder) return; event.preventDefault(); const draggedId = event.dataTransfer.getData("text/task-id"); setOver(null); onDragState(null); if (draggedId) moveFromDrop(draggedId, null, tasks, null); }}><div className="column-header"><div><LayoutList size={14} /><span>Tasks</span><small>{tasks.length}</small></div>{canCreate && <button className="icon-button quiet" onClick={() => onCreate()}><Plus size={13} /></button>}</div><div className="column-cards">{tasks.map((task) => <TaskBoardCard key={task.id} task={task} status={statuses.get(task.statusId)} project={task.projectId ? projects.get(task.projectId) : undefined} release={task.releaseId ? releases.get(task.releaseId) : undefined} assignee={task.assigneeUserId ? users.get(task.assigneeUserId) : undefined} labels={labelsForTask(labelContext, task.id)} hierarchy={hierarchySummaries.get(task.id) ?? EMPTY_TASK_HIERARCHY_SUMMARY} visibleFields={visibleFields} canDrag={canReorder && selected.size <= 1} reorderEnabled={canReorder} dropBefore={over === `before:${task.id}`} onDragTarget={(active) => setOver(active ? `before:${task.id}` : null)} onDropBefore={(draggedId) => moveFromDrop(draggedId, null, tasks, task.id)} onKeyboardMove={(direction) => moveFromKeyboard(task, null, tasks, direction)} showStatus showAssignee selected={selected.has(task.id)} highlighted={highlightedTaskId === task.id} onSelect={(extendRange) => onSelect(task.id, extendRange)} onHighlight={() => onHighlight(task.id)} onOpen={() => onOpen(task.id)} onContextActions={(x, y, focus) => onContextActions(task, x, y, focus)} onDragState={onDragState} />)}</div>{canCreate && <button className="add-card" onClick={() => onCreate()}><Plus size={13} />Add task</button>}</section></div>;
  }
  return (
    <div className="board" role="list" aria-label="Tasks">
      {groups.map((group) => {
        const groupCanCreate = canCreateInTaskGroup(group, canCreate, createOwnerUserId, createAssigneeUserIds);
        return (
          <section
            key={group.id}
            className={`board-column ${over === group.id ? "drag-over" : ""}`}
            onDragOver={(event) => {
              if (!canMoveGroups) return;
              event.preventDefault();
              setOver(group.id);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(event) => {
              if (!canMoveGroups) return;
              event.preventDefault();
              const id = event.dataTransfer.getData("text/task-id");
              const task = tasks.find((item) => item.id === id);
              setOver(null);
              onDragState(null);
              if (task) moveFromDrop(task.id, group, group.tasks, null);
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
              {group.tasks.map((task) => <TaskBoardCard key={task.id} task={task} status={statuses.get(task.statusId)} project={task.projectId ? projects.get(task.projectId) : undefined} release={task.releaseId ? releases.get(task.releaseId) : undefined} assignee={task.assigneeUserId ? users.get(task.assigneeUserId) : undefined} labels={labelsForTask(labelContext, task.id)} hierarchy={hierarchySummaries.get(task.id) ?? EMPTY_TASK_HIERARCHY_SUMMARY} visibleFields={visibleFields} canDrag={(canReorder || canMoveGroups) && selected.size <= 1} reorderEnabled={canReorder} dragGroupLabel={displayLabel(group.kind)} dropBefore={canReorder && over === `before:${task.id}`} onDragTarget={(active) => setOver(active ? `before:${task.id}` : null)} onDropBefore={(draggedId) => moveFromDrop(draggedId, group, group.tasks, task.id)} onKeyboardMove={(direction) => moveFromKeyboard(task, group, group.tasks, direction)} showStatus={group.kind !== "status"} showAssignee={group.kind !== "assignee"} selected={selected.has(task.id)} highlighted={highlightedTaskId === task.id} onSelect={(extendRange) => onSelect(task.id, extendRange)} onHighlight={() => onHighlight(task.id)} onOpen={() => onOpen(task.id)} onContextActions={(x, y, focus) => onContextActions(task, x, y, focus)} onDragState={onDragState} />)}
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

function TaskBoardCard({ task, status, project, release, assignee, labels, hierarchy, visibleFields, canDrag, reorderEnabled, dragGroupLabel, dropBefore, onDragTarget, onDropBefore, onKeyboardMove, showStatus, showAssignee, selected, highlighted, onSelect, onHighlight, onOpen, onContextActions, onDragState }: { task: TaskRecord; status?: WorkflowStatusRecord; project?: ProjectRecord; release?: ReleaseRecord; assignee?: UserRecord; labels: LabelRecord[]; hierarchy: TaskHierarchySummary; visibleFields: ViewDisplay["visibleFields"]; canDrag: boolean; reorderEnabled: boolean; dragGroupLabel?: string; dropBefore: boolean; onDragTarget: (active: boolean) => void; onDropBefore: (draggedTaskId: string) => void; onKeyboardMove: (direction: "up" | "down") => void; showStatus: boolean; showAssignee: boolean; selected: boolean; highlighted: boolean; onSelect: (extendRange?: boolean) => void; onHighlight: () => void; onOpen: () => void; onContextActions: (x: number, y: number, restoreFocus: HTMLElement | null) => void; onDragState: (taskId: string | null) => void }) {
  const editable = canEditContent(task.accessRole);
  const draggable = editable && canDrag;
  const reorderTitle = editable
    ? reorderEnabled
      ? "Drag to reorder; Option+Arrow Up or Down also moves this Task"
      : dragGroupLabel
        ? `Drag to change ${dragGroupLabel}; Priority order remains authoritative`
        : "Choose Manual order to reorder Tasks"
    : undefined;
  return <div role="button" tabIndex={0} data-task-keyboard-id={task.id} data-context-entity-kind="task" data-context-entity-id={task.id} aria-pressed={selected} aria-current={highlighted ? "true" : undefined} title={reorderTitle} className={`task-card ${editable ? "editable" : ""} ${selected ? "selected" : ""} ${highlighted ? "highlighted" : ""} ${dropBefore ? "drop-before" : ""}`} draggable={draggable} onContextMenu={(event) => { event.preventDefault(); onContextActions(event.clientX, event.clientY, event.currentTarget); }} onDragStart={(event) => { if (!draggable) return; event.dataTransfer.setData("text/task-id", task.id); event.dataTransfer.effectAllowed = "move"; onDragState(task.id); }} onDragEnd={() => { onDragTarget(false); onDragState(null); }} onDragOver={(event) => { if (!reorderEnabled) return; event.preventDefault(); event.stopPropagation(); onDragTarget(true); }} onDragLeave={() => onDragTarget(false)} onDrop={(event) => { if (!reorderEnabled) return; event.preventDefault(); event.stopPropagation(); const draggedId = event.dataTransfer.getData("text/task-id"); onDragTarget(false); onDragState(null); if (draggedId) onDropBefore(draggedId); }} onClick={onOpen} onMouseEnter={onHighlight} onFocus={onHighlight} onKeyDown={(event) => { const direction = taskRowReorderDirection({ draggable, reorderEnabled, altKey: event.altKey, key: event.key, targetIsRow: event.target === event.currentTarget }); if (direction) { event.preventDefault(); onKeyboardMove(direction); return; } if (event.target === event.currentTarget && event.key === "Enter") { event.preventDefault(); onOpen(); } }}>{editable && <button className={`card-check ${selected ? "checked" : ""}`} onClick={(event) => { event.stopPropagation(); onSelect(event.shiftKey); }} aria-label={selected ? "Deselect task" : "Select task"}>{selected ? <Check size={11} /> : <span />}</button>}<button className="card-more" type="button" data-context-entity-kind="task" data-context-entity-id={task.id} aria-label={`Open contextual actions for ${task.identifier}`} title="Actions" onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); onContextActions(rect.right, rect.bottom, event.currentTarget); }}><MoreHorizontal size={14} /></button><a href={taskPath(task.publicId)} onClick={(event) => { event.stopPropagation(); handleLocalLink(event, onOpen); }}><h3>{task.title}</h3>{labels.length > 0 && <div className="card-labels">{labels.slice(0, 4).map((label) => <LabelChip key={label.id} label={label} />)}{labels.length > 4 && <span className="label-overflow">+{labels.length - 4}</span>}</div>}<div className="card-meta"><span className="card-identifier">{task.identifier}</span>{visibleFields.includes("priority") && <PriorityIcon priority={task.priority} />}<TaskHierarchyChip hierarchy={hierarchy} />{showStatus && status && <span className="metadata-chip"><StatusIcon status={status} />{status.name}</span>}{visibleFields.includes("project") && project && <span className="metadata-chip"><span className="project-dot" style={{ background: project.color }} />{project.name}</span>}{visibleFields.includes("release") && release && <span className="metadata-chip"><Rocket size={12} />{release.name}</span>}{visibleFields.includes("dueDate") && task.dueDate && <span className={`metadata-chip ${status && isOverdue(task.dueDate, status.category) ? "overdue" : ""}`}><CalendarDays size={12} />{shortDate(task.dueDate)}</span>}{visibleFields.includes("assignee") && showAssignee && assignee && <span className="avatar" title={assignee.displayName}>{initials(assignee.displayName)}</span>}</div></a></div>;
}

function TaskGroupIcon({ group }: { group: TaskGroup }) {
  if (group.status) return <StatusIcon status={group.status} />;
  if (group.priority) return <PriorityIcon priority={group.priority} />;
  if (group.assignee) return <span className="avatar group-avatar" title={group.assignee.displayName}>{initials(group.assignee.displayName)}</span>;
  if (group.project) return <span className="project-dot" style={{ background: group.project.color }} />;
  if (group.release) return <Rocket size={13} />;
  return <Circle size={11} />;
}

function taskStatusOptions(
  task: TaskRecord,
  statuses: ReadonlyMap<string, WorkflowStatusRecord>,
) {
  return [...statuses.values()]
    .filter((status) => status.ownerUserId === task.ownerUserId)
    .filter((status) => !status.archivedAt || status.id === task.statusId)
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
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

type StatusIconVariant = "backlog" | "todo" | "started" | "completed" | "canceled" | "duplicate";

export function statusIconVariant(status: WorkflowStatusRecord): StatusIconVariant {
  if (status.systemRole === "duplicate") return "duplicate";
  if (status.category === "backlog") return "backlog";
  if (status.category === "unstarted") return "todo";
  if (status.category === "started") return "started";
  if (status.category === "completed") return "completed";
  return "canceled";
}

function statusProgress(status: WorkflowStatusRecord) {
  return 45 + (Math.abs(status.position) % 6) * 45;
}

export function StatusIcon({ status, announce = false }: { status: WorkflowStatusRecord; announce?: boolean }) {
  const variant = statusIconVariant(status);
  const progress = variant === "started" ? statusProgress(status) : undefined;
  const label = `Status: ${status.name}`;
  return <span
    className={`status-icon status-${status.category} status-variant-${variant}`}
    data-status-variant={variant}
    data-status-progress={progress}
    style={{
      "--status-color": status.color,
      ...(progress === undefined ? {} : { "--status-progress": `${progress}deg` }),
    } as React.CSSProperties}
    role={announce ? "img" : undefined}
    aria-label={announce ? label : undefined}
    aria-hidden={announce ? undefined : true}
    title={announce ? status.name : undefined}
  >
    {variant === "completed" && <Check size={9} aria-hidden="true" />}
    {variant === "canceled" && <X size={9} aria-hidden="true" />}
    {variant === "duplicate" && <Copy size={8} aria-hidden="true" />}
  </span>;
}

function TaskStatusControl({ status, statuses, onChange }: { status: WorkflowStatusRecord; statuses: WorkflowStatusRecord[]; onChange?: (statusId: string) => Promise<unknown> }) {
  const editable = onChange !== undefined;
  const label = `Status: ${status.name}`;
  return <span className={`task-status-control ${editable ? "editable" : "read-only"}`} title={status.name}>
    <StatusIcon status={status} announce={!editable} />
    {editable && <select
      aria-label={label}
      title={status.name}
      value={status.id}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => {
        if (event.target.value !== status.id) void onChange(event.target.value);
      }}
    >
      {statuses.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
    </select>}
  </span>;
}

type ComposerAttachment = {
  id: string;
  uploadKey: string;
  bindKey: string;
  file: File | null;
  fileRef: string | null;
  fileVersion: number | null;
  filename: string;
  mediaType: string;
  byteSize: number;
  checksumSha256: string | null;
  readyExpiresAt: string | null;
  progress: number;
  status: "uploading" | "staged" | "binding" | "failed" | "canceled" | "complete";
  failedPhase: "upload" | "bind" | "delete" | null;
  error: string | null;
};

type ComposerRecoveryState = {
  version: 1;
  createdTask: { id: string; identifier: string } | null;
  files: Array<{
    id: string;
    uploadKey: string;
    bindKey: string;
    fileRef: string;
    fileVersion: number;
    filename: string;
    mediaType: string;
    byteSize: number;
    checksumSha256: string;
    readyExpiresAt: string | null;
  }>;
};

function TaskComposer({ data, contextProject, contextRelease, defaults, onClose, onSubmit, busy }: { data: AppSnapshot; contextProject: string | null; contextRelease: string | null; defaults: TaskCreateDefaults; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<TaskRecord | null>; busy: boolean }) {
  const editableProjects = data.projects.filter(
    (project) => !project.archivedAt && canEditContent(project.accessRole),
  );
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
  const [labelCatalog, setLabelCatalog] = useState<LabelRecord[]>(
    data.labels.filter((label) => label.ownerUserId === ownerId && !label.archivedAt),
  );
  const [selectedLabelIds, setSelectedLabelIds] = useState<Set<string>>(
    new Set(defaults.labelId ? [defaults.labelId] : []),
  );
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [createdTask, setCreatedTask] = useState<{ id: string; identifier: string } | null>(null);
  const [recoveryHydrated, setRecoveryHydrated] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeUploads = useRef(new Map<string, () => void>());
  const recoveryKey = `tm:task-composer-staged:${data.user.id}`;

  useEffect(() => () => {
    for (const cancel of activeUploads.current.values()) cancel();
    activeUploads.current.clear();
  }, []);

  useEffect(() => {
    let stopped = false;
    const timer = window.setTimeout(() => {
      const saved = readComposerRecoveryState(window.localStorage.getItem(recoveryKey));
      if (!saved) {
        setRecoveryHydrated(true);
        return;
      }
      setCreatedTask(saved.createdTask);
      void Promise.all(saved.files.map(async (file) => {
        try {
          const current = await getStoredFile(file.fileRef);
          return recoveredComposerAttachment(file, current);
        } catch {
          return null;
        }
      })).then((files) => {
        if (stopped) return;
        setAttachments(files.filter((file): file is ComposerAttachment => file !== null));
        setRecoveryHydrated(true);
      });
    }, 0);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [recoveryKey]);

  useEffect(() => {
    if (!recoveryHydrated) return;
    const files = attachments.flatMap((attachment) =>
      attachment.fileRef && attachment.fileVersion && attachment.checksumSha256 && attachment.status !== "complete"
        ? [{
            id: attachment.id,
            uploadKey: attachment.uploadKey,
            bindKey: attachment.bindKey,
            fileRef: attachment.fileRef,
            fileVersion: attachment.fileVersion,
            filename: attachment.filename,
            mediaType: attachment.mediaType,
            byteSize: attachment.byteSize,
            checksumSha256: attachment.checksumSha256,
            readyExpiresAt: attachment.readyExpiresAt,
          }]
        : [],
    );
    if (!createdTask && files.length === 0) {
      window.localStorage.removeItem(recoveryKey);
      return;
    }
    const state: ComposerRecoveryState = { version: 1, createdTask, files };
    window.localStorage.setItem(recoveryKey, JSON.stringify(state));
  }, [attachments, createdTask, recoveryHydrated, recoveryKey]);

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    void fetch(`/api/labels?projectId=${encodeURIComponent(projectId)}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const value = await response.json() as { labels?: LabelRecord[]; error?: string };
      if (!response.ok || !value.labels) throw new Error(value.error ?? "Labels could not be loaded");
      setLabelCatalog(value.labels);
      setSelectedLabelIds((current) => new Set(
        [...current].filter((id) => value.labels!.some((label) => label.id === id)),
      ));
    }).catch((requestError: unknown) => {
      if (!(requestError instanceof DOMException && requestError.name === "AbortError")) {
        setComposerError(requestError instanceof Error ? requestError.message : "Labels could not be loaded");
      }
    });
    return () => controller.abort();
  }, [projectId]);

  function patchAttachment(id: string, patch: Partial<ComposerAttachment>) {
    setAttachments((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function addFiles(files: FileList | File[]) {
    if (createdTask) return;
    const additions = Array.from(files).map((file) => {
      const id = crypto.randomUUID();
      return {
        id,
        uploadKey: `task-composer-file:${id}`,
        bindKey: `task-composer-bind:${id}`,
        file,
        fileRef: null,
        fileVersion: null,
        filename: file.name,
        mediaType: file.type || "application/octet-stream",
        byteSize: file.size,
        checksumSha256: null,
        readyExpiresAt: null,
        progress: 0,
        status: "uploading" as const,
        failedPhase: null,
        error: null,
      };
    });
    setAttachments((current) => [...current, ...additions]);
    for (const attachment of additions) void stageOne(attachment);
  }

  async function stageOne(attachment: ComposerAttachment) {
    if (!attachment.file) {
      patchAttachment(attachment.id, {
        status: "failed",
        failedPhase: "upload",
        error: "Choose the local file again to retry this upload.",
      });
      return null;
    }
    patchAttachment(attachment.id, {
      status: "uploading",
      failedPhase: null,
      progress: 0,
      error: null,
    });
    const running = startStoredFileUpload(
      attachment.file,
      attachment.uploadKey,
      (progress) => patchAttachment(attachment.id, { progress }),
    );
    activeUploads.current.set(attachment.id, running.cancel);
    try {
      const stored = await running.promise;
      patchAttachment(attachment.id, {
        fileRef: stored.ref,
        fileVersion: stored.version,
        filename: stored.filename,
        mediaType: stored.mediaType,
        byteSize: stored.byteSize,
        checksumSha256: stored.checksumSha256,
        readyExpiresAt: stored.readyExpiresAt,
        status: "staged",
        failedPhase: null,
        progress: 100,
        error: null,
      });
      return stored;
    } catch (requestError) {
      const canceled = requestError instanceof DOMException && requestError.name === "AbortError";
      patchAttachment(attachment.id, {
        status: canceled ? "canceled" : "failed",
        failedPhase: "upload",
        error: canceled
          ? "Upload canceled"
          : requestError instanceof Error
            ? requestError.message
            : "Upload failed",
      });
      return null;
    } finally {
      activeUploads.current.delete(attachment.id);
    }
  }

  async function bindOne(
    task: { id: string; identifier: string },
    attachment: ComposerAttachment,
  ) {
    if (!attachment.fileRef) return false;
    patchAttachment(attachment.id, {
      status: "binding",
      failedPhase: null,
      progress: 100,
      error: null,
    });
    const controller = new AbortController();
    activeUploads.current.set(attachment.id, () => controller.abort());
    try {
      await bindStoredFileToTask(
        task.id,
        attachment.fileRef,
        attachment.bindKey,
        controller.signal,
      );
      patchAttachment(attachment.id, {
        status: "complete",
        failedPhase: null,
        error: null,
      });
      return true;
    } catch (requestError) {
      const canceled = requestError instanceof DOMException && requestError.name === "AbortError";
      patchAttachment(attachment.id, {
        status: canceled ? "canceled" : "failed",
        failedPhase: "bind",
        error: `${task.identifier}: ${canceled
          ? "binding canceled"
          : requestError instanceof Error ? requestError.message : "binding failed"}`,
      });
      return false;
    } finally {
      activeUploads.current.delete(attachment.id);
    }
  }

  async function retryAttachment(attachment: ComposerAttachment) {
    if (attachment.failedPhase === "delete") {
      await removeAttachment(attachment);
      return;
    }
    if (attachment.fileRef) {
      if (createdTask) await bindOne(createdTask, attachment);
      else patchAttachment(attachment.id, { status: "staged", failedPhase: null, error: null });
      return;
    }
    await stageOne(attachment);
  }

  async function removeAttachment(attachment: ComposerAttachment) {
    activeUploads.current.get(attachment.id)?.();
    if (!attachment.fileRef) {
      setAttachments((current) => current.filter((item) => item.id !== attachment.id));
      return;
    }
    try {
      await deleteStoredFile(attachment.fileRef, attachment.fileVersion ?? 0);
      setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    } catch (requestError) {
      patchAttachment(attachment.id, {
        status: "failed",
        failedPhase: "delete",
        error: requestError instanceof Error ? requestError.message : "Staged file could not be deleted",
      });
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if ((!createdTask && (!title.trim() || !projectId)) || busy) return;
    setComposerError("");
    const selectedRelease = data.releases.find((release) => release.id === releaseId);
    const confirmReleasedComposition = !createdTask && selectedRelease?.status === "released";
    if (confirmReleasedComposition && !confirmReleasedCompositionChange()) return;
    let bindCandidates = [...attachments];
    let stagingFailed = 0;
    for (const attachment of bindCandidates.filter((item) => !item.fileRef && item.status !== "complete")) {
      const stored = await stageOne(attachment);
      if (!stored) {
        stagingFailed += 1;
        continue;
      }
      bindCandidates = bindCandidates.map((item) => item.id === attachment.id
        ? composerAttachmentWithStoredFile(item, stored)
        : item);
    }
    if (stagingFailed > 0) {
      setComposerError(`${stagingFailed} file${stagingFailed === 1 ? "" : "s"} could not be staged. Retry or remove them before creating the Task.`);
      return;
    }
    const task = createdTask ?? await onSubmit({
      title,
      description,
      projectId,
      releaseId: releaseId || null,
      statusId,
      priority,
      assigneeUserId: assigneeUserId || null,
      labelIds: [...selectedLabelIds],
      ...(confirmReleasedComposition ? { confirmReleasedComposition: true } : {}),
    });
    if (!task) {
      setComposerError("Task was not created. Staged files are still available for retry or deletion until their TTL expires.");
      return;
    }
    const taskIdentity = { id: task.id, identifier: task.identifier };
    setCreatedTask(taskIdentity);
    const pending = bindCandidates.filter((item) => item.status !== "complete");
    let failed = 0;
    for (const attachment of pending) {
      if (!(await bindOne(taskIdentity, attachment))) failed += 1;
    }
    if (failed === 0) {
      window.localStorage.removeItem(recoveryKey);
      onClose();
    } else {
      setComposerError(`${task.identifier} was created, but ${failed} staged file${failed === 1 ? "" : "s"} failed to bind. Each file remains available for a stable-key retry.`);
    }
  }

  function closeComposer() {
    for (const cancel of activeUploads.current.values()) cancel();
    onClose();
  }

  const pendingCount = attachments.filter((item) => item.status !== "complete").length;
  const fileWorkActive = attachments.some((item) => item.status === "uploading" || item.status === "binding");
  return (
    <Modal onClose={closeComposer} className="composer-modal">
      <form onSubmit={submit}>
        <div className="modal-title-row">
          <span className="muted">{createdTask ? `${createdTask.identifier} created` : "New task"}</span>
          <button type="button" className="icon-button" onClick={closeComposer}><X size={15} /></button>
        </div>
        <fieldset className="composer-fields" disabled={Boolean(createdTask)}>
          <input className="composer-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Task title" autoFocus />
          <textarea className="composer-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Add description…" rows={4} onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit(); }} />
          <div className="property-bar">
            <PropertySelect icon={<CircleDot size={13} />} value={statusId} onChange={setStatusId}>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</PropertySelect>
            <PropertySelect icon={<ArrowDownWideNarrow size={13} />} value={priority} onChange={(value) => setPriority(value as Priority)}>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</PropertySelect>
            <PropertySelect icon={<UsersRound size={13} />} value={assigneeUserId} onChange={setAssigneeUserId}><option value="">No assignee</option>{assignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.displayName}</option>)}</PropertySelect>
            <PropertySelect icon={<FolderKanban size={13} />} value={projectId} onChange={(value) => { setProjectId(value); setReleaseId(""); setSelectedLabelIds(new Set()); const nextOwner = data.projects.find((project) => project.id === value)?.ownerUserId ?? data.user.id; const nextAssignees = taskAssigneeOptions(data, value || null); setAssigneeUserId((current) => current === "" || nextAssignees.some((assignee) => assignee.id === current) ? current : data.user.id); setStatusId(data.statuses.find((status) => status.ownerUserId === nextOwner && status.isDefault)?.id ?? data.statuses.find((status) => status.ownerUserId === nextOwner)?.id ?? ""); }}><option value="" disabled>Select project</option>{editableProjects.map((project) => <option key={project.id} value={project.id}>{project.taskCode} · {project.name}</option>)}</PropertySelect>
            <PropertySelect icon={<Rocket size={13} />} value={releaseId} onChange={setReleaseId} disabled={!projectId}><option value="">No release</option>{data.releases.filter((release) => release.projectId === projectId && canEditContent(release.accessRole)).map((release) => <option key={release.id} value={release.id}>{release.name}</option>)}</PropertySelect>
          </div>
          <LabelPicker labels={labelCatalog} selected={selectedLabelIds} onToggle={(labelId) => setSelectedLabelIds((current) => toggleLabelSelection(current, labelId, labelCatalog))} disabled={Boolean(createdTask)} label="Task labels" />
        </fieldset>
        {!editableProjects.length && <p className="inline-note">Create an editable Project before adding a Task.</p>}
        <section
          className={`composer-attachments ${dragActive ? "drag-active" : ""}`}
          aria-label="Task attachments"
          onDragEnter={(event) => { if (!createdTask) { event.preventDefault(); setDragActive(true); } }}
          onDragOver={(event) => { if (!createdTask) event.preventDefault(); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }}
          onDrop={(event) => { if (createdTask) return; event.preventDefault(); setDragActive(false); addFiles(event.dataTransfer.files); }}
          onPaste={(event) => { if (createdTask || !event.clipboardData.files.length) return; event.preventDefault(); addFiles(event.clipboardData.files); }}
        >
          <div>
            <button className="button ghost" type="button" disabled={Boolean(createdTask)} onClick={() => fileInputRef.current?.click()}><Paperclip size={14} />Add files</button>
            <span>{attachments.length ? `${attachments.length} file${attachments.length === 1 ? "" : "s"} · staged before Task creation` : "Files are staged before Task creation"}</span>
          </div>
          <input ref={fileInputRef} className="visually-hidden" type="file" multiple aria-label="Choose files for the new task" disabled={Boolean(createdTask)} onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />
          {attachments.length > 0 && (
            <div className="composer-attachment-list" aria-live="polite">
              {attachments.map((attachment) => (
                <article key={attachment.id} data-upload-state={attachment.status}>
                  <FileAttachmentIcon filename={attachment.filename} />
                  <div>
                    <b title={attachment.filename}>{attachment.filename}</b>
                    <small>{composerAttachmentStatus(attachment)}</small>
                    {attachment.status === "uploading" && <progress value={attachment.progress} max="100" aria-label={`Upload progress for ${attachment.filename}`} />}
                  </div>
                  <div className="composer-attachment-actions">
                    {(attachment.status === "uploading" || attachment.status === "binding") && <button className="icon-button" type="button" aria-label={`Cancel ${attachment.filename}`} onClick={() => activeUploads.current.get(attachment.id)?.()}><X size={14} /></button>}
                    {(attachment.status === "failed" || attachment.status === "canceled") && <button className="icon-button" type="button" aria-label={`Retry ${attachment.filename}`} onClick={() => void retryAttachment(attachment)}><RotateComposerIcon /></button>}
                    {attachment.status !== "complete" && attachment.status !== "uploading" && attachment.status !== "binding" && <button className="icon-button" type="button" aria-label={`Delete staged ${attachment.filename}`} onClick={() => void removeAttachment(attachment)}><X size={14} /></button>}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
        {composerError && <p className="composer-upload-error" role="alert">{composerError}</p>}
        <div className="modal-footer">
          <span className="shortcut-hint">{createdTask ? "Unbound staged files remain recoverable until their TTL expires." : <><kbd>⌘</kbd><kbd>Enter</kbd> to create</>}</span>
          <button className="button primary" disabled={busy || (!createdTask && (!title.trim() || !projectId)) || fileWorkActive || !recoveryHydrated}>{busy || fileWorkActive ? "Working…" : createdTask ? pendingCount ? `Retry ${pendingCount} file${pendingCount === 1 ? "" : "s"}` : "Done" : attachments.length ? "Create and attach" : "Create task"}</button>
        </div>
      </form>
    </Modal>
  );
}

function composerAttachmentWithStoredFile(
  attachment: ComposerAttachment,
  stored: PublicStoredFileRecord,
): ComposerAttachment {
  return {
    ...attachment,
    fileRef: stored.ref,
    fileVersion: stored.version,
    filename: stored.filename,
    mediaType: stored.mediaType,
    byteSize: stored.byteSize,
    checksumSha256: stored.checksumSha256,
    readyExpiresAt: stored.readyExpiresAt,
    progress: 100,
    status: "staged",
    failedPhase: null,
    error: null,
  };
}

function recoveredComposerAttachment(
  saved: ComposerRecoveryState["files"][number],
  stored: PublicStoredFileRecord,
): ComposerAttachment {
  return composerAttachmentWithStoredFile({
    id: saved.id,
    uploadKey: saved.uploadKey,
    bindKey: saved.bindKey,
    file: null,
    fileRef: saved.fileRef,
    fileVersion: saved.fileVersion,
    filename: saved.filename,
    mediaType: saved.mediaType,
    byteSize: saved.byteSize,
    checksumSha256: saved.checksumSha256,
    readyExpiresAt: saved.readyExpiresAt,
    progress: 100,
    status: "staged",
    failedPhase: null,
    error: null,
  }, stored);
}

function readComposerRecoveryState(value: string | null): ComposerRecoveryState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ComposerRecoveryState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.files)) return null;
    const createdTask = parsed.createdTask &&
      typeof parsed.createdTask.id === "string" &&
      typeof parsed.createdTask.identifier === "string"
      ? { id: parsed.createdTask.id, identifier: parsed.createdTask.identifier }
      : null;
    const files = parsed.files.filter((file) =>
      file &&
      typeof file.id === "string" &&
      typeof file.uploadKey === "string" &&
      typeof file.bindKey === "string" &&
      typeof file.fileRef === "string" &&
      Number.isSafeInteger(file.fileVersion) &&
      typeof file.filename === "string" &&
      typeof file.mediaType === "string" &&
      Number.isSafeInteger(file.byteSize) &&
      typeof file.checksumSha256 === "string" &&
      (file.readyExpiresAt === null || typeof file.readyExpiresAt === "string"),
    );
    return { version: 1, createdTask, files };
  } catch {
    return null;
  }
}

function composerAttachmentStatus(attachment: ComposerAttachment) {
  if (attachment.status === "uploading") return `${attachment.progress}% uploaded to staging`;
  if (attachment.status === "staged") return `Staged · ${formatComposerBytes(attachment.byteSize)} · ready to attach`;
  if (attachment.status === "binding") return "Attaching to Task…";
  if (attachment.status === "complete") return "Attached";
  return attachment.error ?? (attachment.status === "canceled" ? "Canceled" : "Failed");
}

function formatComposerBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
}

function FileAttachmentIcon({ filename }: { filename: string }) {
  return <span className="composer-attachment-icon" aria-hidden="true">{filename.split(".").at(-1)?.slice(0, 4).toUpperCase() || "FILE"}</span>;
}

function RotateComposerIcon() {
  return <span aria-hidden="true">↻</span>;
}

function TaskDetails({ task, data, catalogReady, onClose, onOpenTask, onContextActions, onSave, onMove, onSetParent, onCreateSubtask, onSetLabel, onRebase, onRelationMutation, onShare, busy }: { task: TaskRecord; data: AppSnapshot; catalogReady: boolean; onClose: () => void; onOpenTask: (id: string) => void; onContextActions: (x: number, y: number, restoreFocus: HTMLElement | null) => void; onSave: (input: Record<string, unknown>) => Promise<unknown>; onMove: (input: Record<string, unknown>) => Promise<unknown>; onSetParent: (parentTaskId: string | null) => Promise<unknown>; onCreateSubtask: (title: string) => Promise<unknown>; onSetLabel: (labelId: string, active: boolean) => Promise<unknown>; onRebase: (taskId: string) => Promise<TaskRecord | null>; onRelationMutation: (tasks: TaskRecord[], dependencies: TaskQueryDependency[]) => void; onShare: () => void; busy: boolean }) {
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
  const [moveTargetProjectId, setMoveTargetProjectId] = useState<string | null>(null);
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [labelCatalog, setLabelCatalog] = useState<LabelRecord[]>(
    data.labels.filter((label) => label.ownerUserId === task.ownerUserId),
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/tasks/${encodeURIComponent(task.id)}/labels`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const value = await response.json() as LabelMutationResult | { error?: string };
      if (!response.ok || !("labels" in value)) throw new Error("error" in value ? value.error ?? "Labels could not be loaded" : "Labels could not be loaded");
      setLabelCatalog(value.labels);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [task.id]);
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
    return <ReadOnlyTaskDetails task={task} data={data} onClose={onClose} onOpenTask={onOpenTask} />;
  }
  const statuses = data.statuses.filter(
    (status) => status.ownerUserId === task.ownerUserId &&
      (!status.archivedAt || status.id === task.statusId),
  );
  const currentProject = data.projects.find((project) => project.id === task.projectId);
  const moveTargets = data.projects.filter(
    (project) => project.id !== task.projectId &&
      project.status !== "canceled" &&
      canEditContent(project.accessRole),
  );
  const moveTargetProject = moveTargetProjectId
    ? moveTargets.find((project) => project.id === moveTargetProjectId)
    : undefined;
  const assignees = taskAssigneeOptions(data, task.projectId, task.id);
  const taskMap = new Map(data.tasks.map((item) => [item.id, item]));
  const assignedLabels = data.taskLabels
    .filter((assignment) => assignment.taskId === task.id)
    .map((assignment) => data.labels.find((label) => label.id === assignment.labelId))
    .filter((label) => label !== undefined);
  const parent = task.parentTaskId ? taskMap.get(task.parentTaskId) : undefined;
  const subtasks = data.tasks.filter((item) => item.parentTaskId === task.id);
  const hierarchyCandidates = data.tasks.filter((candidate) =>
    candidate.id !== task.id &&
    candidate.projectId === task.projectId &&
    (!candidate.archivedAt || candidate.id === task.parentTaskId) &&
    !wouldCreateHierarchyCycle(task.id, candidate.id, taskMap));
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
          <div><button className="button ghost" onClick={onShare}><Share2 size={13} />Share</button><button className="icon-button" type="button" aria-label={`Open contextual actions for ${task.identifier}`} title="Actions (Cmd/Ctrl+K)" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onContextActions(rect.right, rect.bottom, event.currentTarget); }}><MoreHorizontal size={16} /></button><button className="icon-button" onClick={onClose}><X size={16} /></button></div>
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
            <PropertyRow label="Project" icon={<FolderKanban size={14} />}><select value={task.projectId} disabled={!catalogReady || hasVersionConflict || busy || moveTargets.length === 0} title={!catalogReady ? "Loading Projects…" : moveTargets.length ? "Move this Task to another Project" : "No other editable active Project"} onChange={(event) => setMoveTargetProjectId(event.target.value)}><option value={task.projectId}>{currentProject?.taskCode} · {currentProject?.name}</option>{moveTargets.map((project) => <option key={project.id} value={project.id}>{project.taskCode} · {project.name}</option>)}</select></PropertyRow>
            <PropertyRow label="Release" icon={<Rocket size={14} />}><select value={task.releaseId ?? ""} onChange={(event) => void onSave({ releaseId: event.target.value || null })} disabled={!catalogReady || hasVersionConflict || !task.projectId}><option value="">{catalogReady ? "No release" : "Loading Releases…"}</option>{data.releases.filter((release) => release.projectId === task.projectId).map((release) => <option key={release.id} value={release.id}>{release.name}</option>)}</select></PropertyRow>
            <PropertyRow label="Due date" icon={<CalendarDays size={14} />}><input type="date" value={task.dueDate ?? ""} disabled={hasVersionConflict} onChange={(event) => void onSave({ dueDate: event.target.value || null })} /></PropertyRow>
            <PropertyRow label="Estimate" icon={<Zap size={14} />}><input type="number" min="0" max="100" value={estimate} placeholder="No estimate" onChange={(event) => { const nextEstimate = event.target.value; setDirty((current) => ({ ...current, estimate: taskDraftValueChanged(nextEstimate, task.estimate?.toString() ?? "") })); setEstimate(nextEstimate); }} onBlur={() => { const value = estimate === "" ? null : Number(estimate); if (!hasVersionConflict && value !== task.estimate) void saveDraftField("estimate", { estimate: value }); }} /></PropertyRow>
          </div>
          <DetailsSection title="Labels" icon={<Tag size={14} />}><LabelPicker labels={labelCatalog} selected={new Set(assignedLabels.map((label) => label.id))} onToggle={(labelId) => void onSetLabel(labelId, !assignedLabels.some((label) => label.id === labelId))} disabled={busy} label="Edit Task labels" /></DetailsSection>
          <DetailsSection title="Hierarchy" icon={<Boxes size={14} />}>
            {(parent || subtasks.length > 0) && <div className="details-links">{parent && <TaskReference label="Parent" task={parent} onOpen={onOpenTask} />}{subtasks.map((subtask) => <TaskReference key={subtask.id} label="Subtask" task={subtask} onOpen={onOpenTask} />)}</div>}
            <div className="hierarchy-controls">
              <label>
                <span>Parent</span>
                <select
                  aria-label="Task parent"
                  value={task.parentTaskId ?? ""}
                  disabled={busy || hasVersionConflict}
                  onChange={(event) => void onSetParent(event.target.value || null)}
                >
                  <option value="">No parent</option>
                  {hierarchyCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.identifier} · {candidate.title}</option>)}
                </select>
              </label>
              <form onSubmit={(event) => {
                event.preventDefault();
                const nextTitle = subtaskTitle.trim();
                if (!nextTitle || busy || hasVersionConflict) return;
                void onCreateSubtask(nextTitle).then((created) => {
                  if (created === true) setSubtaskTitle("");
                });
              }}>
                <input
                  aria-label="New subtask title"
                  value={subtaskTitle}
                  maxLength={500}
                  placeholder="New subtask title"
                  disabled={busy || hasVersionConflict || Boolean(task.archivedAt)}
                  onChange={(event) => setSubtaskTitle(event.target.value)}
                />
                <button className="button ghost" type="submit" disabled={busy || hasVersionConflict || Boolean(task.archivedAt) || !subtaskTitle.trim()}><Plus size={13} />Add subtask</button>
              </form>
            </div>
          </DetailsSection>
          <TaskRelations
            task={task}
            data={data}
            onOpenTask={onOpenTask}
            onRefresh={onRebase}
            onMutation={onRelationMutation}
            canWrite
            busy={busy}
          />
          <TaskAttachments task={task} currentUser={data.user} users={data.users} canWrite description={task.description} />
          <TaskActivity task={task} currentUser={data.user} canWrite />
          <div className="timestamps"><span>Created {longDate(task.createdAt, data.user.timezone)}</span><span>Updated {longDate(task.updatedAt, data.user.timezone)}</span>{task.completedAt && <span>Completed {longDate(task.completedAt, data.user.timezone)}</span>}</div>
          <button className="button danger ghost archive-action" disabled={hasVersionConflict} onClick={() => { void onSave({ archived: !task.archivedAt }); onClose(); }}><Archive size={14} />{task.archivedAt ? "Restore task" : "Archive task"}</button>
        </div>
      </aside>
      {moveTargetProject && currentProject && (
        <TaskMoveDialog
          task={task}
          sourceProject={currentProject}
          targetProject={moveTargetProject}
          data={data}
          parent={parent}
          subtasks={subtasks}
          busy={busy}
          onClose={() => setMoveTargetProjectId(null)}
          onMove={async (input) => {
            const moved = await onMove(input);
            if (moved === true) setMoveTargetProjectId(null);
          }}
        />
      )}
    </div>
  );
}

export function TaskMoveDialog({ task, sourceProject, targetProject, data, parent, subtasks, busy, onClose, onMove }: { task: TaskRecord; sourceProject: ProjectRecord; targetProject: ProjectRecord; data: AppSnapshot; parent?: TaskRecord; subtasks: TaskRecord[]; busy: boolean; onClose: () => void; onMove: (input: Record<string, unknown>) => Promise<void> }) {
  const targetReleases = data.releases.filter(
    (release) => release.projectId === targetProject.id && canEditContent(release.accessRole),
  );
  const targetAssignees = taskAssigneeOptions(data, targetProject.id, task.id);
  const currentRelease = data.releases.find((release) => release.id === task.releaseId);
  const currentAssignee = [...data.users, data.user].find(
    (user) => user.id === task.assigneeUserId,
  );
  const currentAssigneeRemains = task.assigneeUserId === null || targetAssignees.some(
    (assignee) => assignee.id === task.assigneeUserId,
  );
  const [releaseId, setReleaseId] = useState(task.releaseId ? "__required__" : "");
  const [assigneeUserId, setAssigneeUserId] = useState(
    currentAssigneeRemains ? (task.assigneeUserId ?? "") : "__required__",
  );
  const hierarchyBlocked = Boolean(parent || subtasks.length);
  const choicesIncomplete = releaseId === "__required__" || assigneeUserId === "__required__";
  const expectedIdentifier = `${targetProject.taskCode}-${targetProject.taskSequence + 1}`;

  return (
    <Modal onClose={() => !busy && onClose()} className="task-move-modal" ariaLabel={`Move ${task.identifier}`}>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (hierarchyBlocked || choicesIncomplete) return;
        void onMove({
          targetProjectId: targetProject.id,
          releaseId: releaseId || null,
          assigneeUserId: assigneeUserId || null,
        });
      }}>
        <DialogHeader title="Move task" icon={<FolderKanban size={17} />} onClose={() => !busy && onClose()} />
        <div className="task-move-summary">
          <span><small>From</small><b>{sourceProject.name}</b><code>{task.identifier}</code></span>
          <ArrowDown size={15} aria-hidden="true" />
          <span><small>To</small><b>{targetProject.name}</b><code>{expectedIdentifier} expected</code></span>
        </div>
        <p className="dialog-copy">The final identifier is allocated only when the move commits. The response is authoritative; the old identifier remains searchable.</p>
        <div className="form-stack task-move-effects">
          <label>
            <span>Release effect</span>
            <select value={releaseId} onChange={(event) => setReleaseId(event.target.value)}>
              {task.releaseId && <option value="__required__" disabled>Choose how to replace {currentRelease?.name ?? "the current Release"}</option>}
              <option value="">Clear Release</option>
              {targetReleases.map((release) => <option key={release.id} value={release.id}>{release.name}</option>)}
            </select>
          </label>
          <label>
            <span>Assignee effect</span>
            <select value={assigneeUserId} onChange={(event) => setAssigneeUserId(event.target.value)}>
              {!currentAssigneeRemains && <option value="__required__" disabled>Choose how to replace {currentAssignee?.displayName ?? "the current assignee"}</option>}
              <option value="">No assignee</option>
              {targetAssignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.displayName}</option>)}
            </select>
          </label>
        </div>
        {hierarchyBlocked && <p className="dialog-error" role="alert">Detach or reparent {parent ? "the parent" : ""}{parent && subtasks.length ? " and " : ""}{subtasks.length ? `${subtasks.length} subtask${subtasks.length === 1 ? "" : "s"}` : ""} before moving this Task.</p>}
        <DialogFooter busy={busy} label="Move task" disabled={hierarchyBlocked || choicesIncomplete} />
      </form>
    </Modal>
  );
}

function TaskDetailsLoading({ task, onClose }: { task: TaskRecord; onClose: () => void }) {
  return <div className="details-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="details-panel" aria-busy="true"><header><div className="details-crumb"><span>{task.identifier}</span></div><button className="icon-button" onClick={onClose}><X size={16} /></button></header><div className="details-body task-details-loading"><h1 className="read-only-title">{task.title}</h1><p>Loading task details…</p></div></aside></div>;
}

function ReadOnlyTaskDetails({ task, data, onClose, onOpenTask }: { task: TaskRecord; data: AppSnapshot; onClose: () => void; onOpenTask: (id: string) => void }) {
  const status = data.statuses.find((item) => item.id === task.statusId);
  const project = task.projectId ? data.projects.find((item) => item.id === task.projectId) : undefined;
  const release = task.releaseId ? data.releases.find((item) => item.id === task.releaseId) : undefined;
  const assignee = task.assigneeUserId
    ? [...data.users, data.user].find((item) => item.id === task.assigneeUserId)
    : undefined;
  const parent = task.parentTaskId ? data.tasks.find((item) => item.id === task.parentTaskId) : undefined;
  const subtasks = data.tasks.filter((item) => item.parentTaskId === task.id);
  const labels = labelsForTask(data, task.id);
  return <div className="details-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="details-panel read-only"><header><div className="details-crumb"><span>{task.identifier}</span><small className="role-badge">Viewer</small></div><button className="icon-button" onClick={onClose}><X size={16} /></button></header><div className="details-body"><h1 className="read-only-title">{task.title}</h1>{task.description ? <TaskDescriptionMarkdown task={task} body={task.description} className="task-description-markdown" /> : <p className="task-description-empty">No description</p>}<div className="properties-grid"><PropertyValue label="Status" value={status?.name ?? "Unknown"} /><PropertyValue label="Priority" value={priorityMeta[task.priority].label} /><PropertyValue label="Assignee" value={assignee?.displayName ?? "No assignee"} /><PropertyValue label="Project" value={project ? `${project.taskCode} · ${project.name}` : "Unavailable"} /><PropertyValue label="Release" value={release?.name ?? "No release"} /><PropertyValue label="Due date" value={task.dueDate ? shortDate(task.dueDate) : "No due date"} /><PropertyValue label="Estimate" value={task.estimate == null ? "No estimate" : String(task.estimate)} /></div>{labels.length > 0 && <DetailsSection title="Labels" icon={<Tag size={14} />}><div className="label-chip-list">{labels.map((label) => <LabelChip key={label.id} label={label} />)}</div></DetailsSection>}{(parent || subtasks.length > 0) && <DetailsSection title="Hierarchy" icon={<Boxes size={14} />}><div className="details-links">{parent && <TaskReference label="Parent" task={parent} onOpen={onOpenTask} />}{subtasks.map((subtask) => <TaskReference key={subtask.id} label="Subtask" task={subtask} onOpen={onOpenTask} />)}</div></DetailsSection>}<TaskRelations task={task} data={data} onOpenTask={onOpenTask} onRefresh={async () => task} onMutation={() => undefined} canWrite={false} busy={false} /><TaskAttachments task={task} currentUser={data.user} users={data.users} canWrite={false} description={task.description} /><TaskActivity task={task} currentUser={data.user} canWrite={false} /><div className="timestamps"><span>Created {longDate(task.createdAt, data.user.timezone)}</span><span>Updated {longDate(task.updatedAt, data.user.timezone)}</span></div></div></aside></div>;
}

type RelativeRelationKind = "blocks" | "blocked_by" | "related" | "duplicate_of" | "duplicates";

export function relationCandidateAllowedForKind(
  kind: RelativeRelationKind,
  anchor: TaskRecord,
  candidate: TaskRecord,
) {
  return kind !== "duplicate_of" || candidate.projectId === anchor.projectId;
}

export function relationSelectionAfterKindChange(
  kind: RelativeRelationKind,
  anchor: TaskRecord,
  candidates: TaskRecord[],
  selectedTaskId: string,
) {
  const selected = candidates.find((candidate) => candidate.id === selectedTaskId);
  return selected && relationCandidateAllowedForKind(kind, anchor, selected)
    ? selectedTaskId
    : "";
}

function TaskRelations({
  task,
  data,
  onOpenTask,
  onRefresh,
  onMutation,
  canWrite,
  busy,
}: {
  task: TaskRecord;
  data: AppSnapshot;
  onOpenTask: (id: string) => void;
  onRefresh: (taskId: string) => Promise<TaskRecord | null>;
  onMutation: (tasks: TaskRecord[], dependencies: TaskQueryDependency[]) => void;
  canWrite: boolean;
  busy: boolean;
}) {
  const presentations = taskRelationPresentations(task, data);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<RelativeRelationKind>("related");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<TaskRecord[]>(data.tasks);
  const [candidateProjects, setCandidateProjects] = useState<ProjectRecord[]>(data.projects);
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
      relationCandidateAllowedForKind(kind, task, candidate) &&
      !existingTargetIds.has(candidate.id) &&
      (!query.trim() || `${candidate.identifier} ${candidate.title}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))
    .slice(0, 8);

  function searchCandidates(nextQuery: string) {
    setQuery(nextQuery);
    setSelectedTaskId("");
    setCandidates(data.tasks);
    setCandidateProjects(data.projects);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!nextQuery.trim()) {
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      void fetch(taskRelationSearchUiApiPath(nextQuery.trim(), task.id, kind), {
        cache: "no-store",
      })
        .then(async (response) => {
          const value = await response.json() as {
            tasks?: TaskRecord[];
            projects?: ProjectRecord[];
            error?: string;
          };
          if (!response.ok || value.error) throw new Error(value.error ?? "Task search failed");
          setCandidates(value.tasks ?? []);
          setCandidateProjects(value.projects ?? []);
          setRelationError("");
        })
        .catch((requestError: unknown) => {
          setRelationError(requestError instanceof Error ? requestError.message : "Task search failed");
        })
        .finally(() => setSearching(false));
    }, 180);
  }

  function changeKind(nextKind: RelativeRelationKind) {
    setKind(nextKind);
    setSelectedTaskId(relationSelectionAfterKindChange(
      nextKind,
      task,
      candidates,
      selectedTaskId,
    ));
  }

  async function sendRelationMutation(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    input: Record<string, unknown>,
    pendingId: string,
    affectedTaskIds: string[],
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
      const refreshed = await onRefresh(task.id);
      const affected = new Map(
        data.tasks
          .filter((candidate) => affectedTaskIds.includes(candidate.id))
          .map((candidate) => [candidate.id, candidate]),
      );
      if (refreshed) affected.set(refreshed.id, refreshed);
      onMutation(
        [...affected.values()],
        input.type === "duplicate_of" && method !== "DELETE"
          ? ["relation", "status", "status_category"]
          : ["relation"],
      );
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
      [task.id, selectedTaskId],
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
      [task.id, item.target.id],
    );
  }

  async function removeRelation(item: TaskRelationPresentation) {
    await sendRelationMutation(
      `/api/tasks/${encodeURIComponent(task.id)}/relations/${encodeURIComponent(item.relation.id)}`,
      "DELETE",
      { version: item.relation.version },
      item.relation.id,
      [task.id, item.target.id],
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
          <TaskReference
            label={data.projects.some((project) => project.id === item.target.projectId)
              ? `${item.label} · ${relationCandidateProjectLabel(item.target, data.projects)}`
              : item.label}
            task={item.target}
            onOpen={onOpenTask}
          />
          {canWrite && <div className="task-relation-actions">
            <select aria-label={`Change relation to ${item.target.identifier}`} value={relativeRelationKind(item)} disabled={relationBusy} onChange={(event) => void updateRelation(item, event.target.value as RelativeRelationKind)}>
              <option value="related">Related</option>
              <option value="blocks">Blocks</option>
              <option value="blocked_by">Blocked by</option>
              {item.target.projectId === task.projectId && <option value="duplicate_of">Duplicate of</option>}
              {relativeRelationKind(item) === "duplicates" && <option value="duplicates" disabled>Duplicate</option>}
            </select>
            <button className="icon-button" type="button" aria-label={`Remove relation to ${item.target.identifier}`} disabled={relationBusy} onClick={() => void removeRelation(item)}><X size={13} /></button>
          </div>}
        </div>)}
      </div>
    </div>)}
    {adding && <div className="task-relation-composer">
      <div>
        <select aria-label="Relation type" value={kind} disabled={relationBusy} onChange={(event) => changeKind(event.target.value as RelativeRelationKind)}>
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
        {!searching && availableCandidates.map((candidate) => <button type="button" key={candidate.id} className={selectedTaskId === candidate.id ? "selected" : ""} onClick={() => setSelectedTaskId(candidate.id)}><span>{candidate.identifier}</span><b>{relationCandidateProjectLabel(candidate, candidateProjects)} · {candidate.title}</b></button>)}
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

function TaskActivity({ task, currentUser, canWrite }: {
  task: TaskRecord;
  currentUser: UserRecord;
  canWrite: boolean;
}) {
  const [page, setPage] = useState<CommentPage | null>(null);
  const [activityPage, setActivityPage] = useState<ActivityPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [activityLoading, setActivityLoading] = useState(true);
  const [error, setError] = useState("");
  const [activityError, setActivityError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadBlocked, setUploadBlocked] = useState(false);
  const [composerEpoch, setComposerEpoch] = useState(0);
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

  async function loadActivity(cursor: string | null = null, append = false) {
    setActivityLoading(true);
    setActivityError("");
    try {
      const next = await fetchCommentJson<ActivityPage>(
        `/api/tasks/${encodeURIComponent(task.id)}/activity?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      setActivityPage((current) => append && current ? {
        ...next,
        events: [...current.events, ...next.events],
      } : next);
    } catch (requestError) {
      setActivityError(requestError instanceof Error ? requestError.message : "Activity could not be loaded");
    } finally {
      setActivityLoading(false);
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
    // Activity is a separate lazy projection; reload only for the open Task.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActivityPage(null);
    const timer = window.setTimeout(() => void loadActivity(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.activityInvalidationCursor, task.id]);

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
    if (!canWrite || busy || uploadBlocked || !draft.trim()) return;
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
      setComposerEpoch((current) => current + 1);
      setReplyTo(null);
      setDraft(submittedReplyTo
        ? window.localStorage.getItem(commentDraftStorageKey(currentUser.id, task.id)) ?? ""
        : "");
      await Promise.all([loadComments(), loadActivity()]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Comment could not be saved");
    } finally {
      setBusy(false);
    }
  }

  async function mutateComment(path: string, method: string, input: Record<string, unknown>) {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await fetchCommentJson(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      await Promise.all([loadComments(), loadActivity()]);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Comment action failed");
      return false;
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
  const activityCount = activityPage?.totalCount ?? 0;
  return <section className="task-activity details-section" aria-labelledby={`activity-${task.id}`}>
    <header className="activity-header">
      <h2 id={`activity-${task.id}`}><MessageSquare size={14} />Activity</h2>
      <span>{activityCount} {activityCount === 1 ? "event" : "events"} · {count} {count === 1 ? "comment" : "comments"}</span>
    </header>
    {activityLoading && !activityPage && <p className="inline-note" role="status">Loading activity…</p>}
    {activityError && <div className="comment-error" role="alert"><span>{activityError}</span><button type="button" onClick={() => void loadActivity()}>Retry</button></div>}
    {activityPage && activityPage.events.length > 0 && <div className="activity-events">
      {activityPage.events.map((event) => <ActivityTimelineEvent key={event.id} event={event} />)}
    </div>}
    {activityPage?.hasMore && <button className="button ghost load-comments" type="button" disabled={activityLoading} onClick={() => void loadActivity(activityPage.nextCursor, true)}>{activityLoading ? "Loading…" : "Load older activity"}</button>}
    {loading && !page && <p className="inline-note" role="status">Loading comments…</p>}
    {error && <div className="comment-error" role="alert"><span>{error}</span><button type="button" onClick={() => void loadComments()}>Retry</button></div>}
    {page && page.threads.length === 0 && <p className="activity-empty">No comments yet.</p>}
    <CommentAttachmentMetadataProvider task={task}>
      <div className="comment-threads">
        {page?.threads.map((thread) => <CommentThread
          key={`${thread.root.id}:${thread.root.resolvedAt ?? "open"}`}
          taskId={task.id}
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
    </CommentAttachmentMetadataProvider>
    {page?.hasMore && <button className="button ghost load-comments" type="button" disabled={loading} onClick={() => void loadComments(page.nextCursor, true)}>{loading ? "Loading…" : "Load older threads"}</button>}
    {canWrite && <div className="comment-composer">
      <span className="comment-avatar" style={{ "--avatar-hue": avatarHue(currentUser.id) } as React.CSSProperties}>{initials(currentUser.displayName)}</span>
      <div className="comment-composer-box">
        {replyTo && <div className="reply-context"><span>Replying in thread</span><button type="button" onClick={() => switchComposer(null)}>Cancel</button></div>}
        <CommentAttachmentAuthoring
          key={`${draftKey}:${composerEpoch}`}
          taskId={task.id}
          value={draft}
          onChange={setDraft}
          textareaRef={composerRef}
          disabled={busy}
          onBlockingChange={setUploadBlocked}
        >
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
        </CommentAttachmentAuthoring>
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
          <button className="button primary" type="button" disabled={busy || uploadBlocked || !draft.trim()} onClick={() => void submitComment()}>{busy ? "Saving…" : uploadBlocked ? "Upload pending" : replyTo ? "Reply" : "Comment"}</button>
        </div>
      </div>
    </div>}
  </section>;
}

function ActivityTimelineEvent({ event }: { event: ActivityEventRecord }) {
  const changes = event.payload.changes && typeof event.payload.changes === "object"
    ? event.payload.changes as Record<string, unknown>
    : null;
  const summary = changes
    ? Object.entries(changes).map(([field, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return field;
      const change = value as Record<string, unknown>;
      return `${activityFieldLabel(field)}: ${activityValue(change.before)} → ${activityValue(change.after)}`;
    }).join(" · ")
    : activityEventFallback(event);
  return <div className="activity-event">
    <span className="activity-event-icon"><CircleDot size={12} /></span>
    <div>
      <header><b>{event.actor.displayName}</b><span>{activityEventLabel(event.eventType)}</span>{event.actor.kind === "historical" && <small>Imported history</small>}<time dateTime={event.createdAt} title={longDateTime(event.createdAt)}>{relativeTime(event.createdAt)}</time></header>
      {summary && <p>{summary}</p>}
    </div>
  </div>;
}

function activityEventLabel(value: string) {
  return ({
    task_created: "created the task",
    task_updated: "updated the task",
    task_moved: "moved the task",
    task_archived: "archived the task",
    task_restored: "restored the task",
    task_deleted: "moved the task to Recently deleted",
    task_delete_restored: "restored the task from Recently deleted",
    status_changed: "changed status",
    hierarchy_changed: "changed hierarchy",
    labels_changed: "changed labels",
    relation_created: "added a relation",
    relation_updated: "updated a relation",
    relation_deleted: "removed a relation",
    comment_added: "added a comment",
    comment_edited: "edited a comment",
    comment_deleted: "deleted a comment",
    comment_resolved: "resolved a thread",
    comment_reopened: "reopened a thread",
    comment_reaction_changed: "changed a reaction",
  } as Record<string, string>)[value] ?? value.replaceAll("_", " ");
}

function activityFieldLabel(value: string) {
  return ({ assigneeUserId: "Assignee", dueDate: "Due date", estimate: "Estimate", parentTaskId: "Parent", project: "Project", projectId: "Project", releaseId: "Release", archivedAt: "Archive", status: "Status", priority: "Priority", identifier: "Identifier", title: "Title" } as Record<string, string>)[value] ?? value;
}

function activityValue(value: unknown): string {
  if (value == null || value === "") return "None";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return String(record.name ?? record.identifier ?? record.id ?? "Changed");
  }
  return "Changed";
}

function activityEventFallback(event: ActivityEventRecord) {
  if (event.eventType === "labels_changed") {
    const label = event.payload.label as Record<string, unknown> | undefined;
    return `${event.payload.active ? "Added" : "Removed"} ${String(label?.name ?? "label")}`;
  }
  if (event.eventType.startsWith("relation_")) return "Task relation changed";
  if (event.eventType.startsWith("comment_")) return "Discussion activity";
  return "";
}

function CommentThread({ taskId, thread, busy, onReply, onEdit, onDelete, onReact, onResolve }: {
  taskId: string;
  thread: CommentThreadRecord;
  busy: boolean;
  onReply: (rootId: string) => void;
  onEdit: (comment: CommentRecord, body: string) => Promise<boolean>;
  onDelete: (comment: CommentRecord) => Promise<boolean>;
  onReact: (comment: CommentRecord, emoji: string, active: boolean) => Promise<boolean>;
  onResolve: (comment: CommentRecord, resolved: boolean) => Promise<boolean>;
}) {
  const [collapsed, setCollapsed] = useState(Boolean(thread.root.resolvedAt));
  useEffect(() => {
    const targetId = window.location.hash.slice(1);
    if (!targetId || ![thread.root, ...thread.replies].some(
      (comment) => `comment-${comment.id}` === targetId,
    )) return;
    let focusFrame = 0;
    const openFrame = window.requestAnimationFrame(() => {
      setCollapsed(false);
      focusFrame = window.requestAnimationFrame(() => {
        const target = document.getElementById(targetId);
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
    return () => {
      window.cancelAnimationFrame(openFrame);
      window.cancelAnimationFrame(focusFrame);
    };
  }, [thread]);
  return <article className={`comment-thread ${thread.root.resolvedAt ? "resolved" : ""}`}>
    {thread.root.resolvedAt && <button className="resolved-thread-toggle" type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}><Check size={13} />Resolved thread · {thread.replies.length + 1} messages</button>}
    {!collapsed && <>
      <CommentEntry taskId={taskId} comment={thread.root} rootId={thread.root.id} busy={busy} onReply={onReply} onEdit={onEdit} onDelete={onDelete} onReact={onReact} onResolve={onResolve} />
      {thread.replies.length > 0 && <div className="comment-replies">{thread.replies.map((reply) => <CommentEntry key={reply.id} taskId={taskId} comment={reply} rootId={thread.root.id} busy={busy} onReply={onReply} onEdit={onEdit} onDelete={onDelete} onReact={onReact} onResolve={onResolve} />)}</div>}
    </>}
  </article>;
}

function CommentEntry({ taskId, comment, rootId, busy, onReply, onEdit, onDelete, onReact, onResolve }: {
  taskId: string;
  comment: CommentRecord;
  rootId: string;
  busy: boolean;
  onReply: (rootId: string) => void;
  onEdit: (comment: CommentRecord, body: string) => Promise<boolean>;
  onDelete: (comment: CommentRecord) => Promise<boolean>;
  onReact: (comment: CommentRecord, emoji: string, active: boolean) => Promise<boolean>;
  onResolve: (comment: CommentRecord, resolved: boolean) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const [editUploadBlocked, setEditUploadBlocked] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);
  const preview = commentBodyPreview(comment.body);
  const long = preview.truncated;
  const body = long && !expanded ? preview.body : comment.body;
  const isRoot = comment.parentCommentId === null;
  const permalink = `comment-${comment.id}`;
  return <div className="comment-entry" id={permalink} tabIndex={-1}>
    <span className="comment-avatar" style={{ "--avatar-hue": avatarHue(comment.author.id ?? comment.id) } as React.CSSProperties}>{initials(comment.author.displayName)}</span>
    <div className="comment-content">
      <header><b>{comment.author.displayName}</b>{comment.author.kind === "historical" && <small className="historical-comment-badge">Imported history</small>}<time dateTime={comment.createdAt} title={longDateTime(comment.createdAt)}>{relativeTime(comment.createdAt)}</time>{comment.source === "native" && comment.updatedAt !== comment.createdAt && <small>edited</small>}
        <details className="comment-menu"><summary aria-label="Comment actions"><MoreHorizontal size={14} /></summary><div>
          <button type="button" onClick={() => copyCommentPermalink(comment.id)}>Copy link</button>
          {comment.permissions.canEdit && <button type="button" onClick={() => setEditing(true)}>Edit</button>}
          {comment.permissions.canDelete && <button type="button" onClick={() => { if (window.confirm("Delete this comment?")) void onDelete(comment); }}>Delete</button>}
        </div></details>
      </header>
      {comment.historical?.quotedText && <blockquote className="historical-comment-quote">{comment.historical.quotedText}</blockquote>}
      {comment.deletedAt ? <p className="comment-tombstone">Comment deleted</p> : editing ? <div className="comment-edit"><CommentAttachmentAuthoring taskId={taskId} value={editBody} onChange={setEditBody} textareaRef={editRef} disabled={busy} onBlockingChange={setEditUploadBlocked}><textarea ref={editRef} value={editBody} onChange={(event) => setEditBody(event.target.value)} rows={4} autoFocus /></CommentAttachmentAuthoring><div><button className="button ghost" type="button" onClick={() => { setEditBody(comment.body); setEditing(false); }}>Cancel</button><button className="button primary" type="button" disabled={busy || editUploadBlocked || !editBody.trim()} onClick={() => void onEdit(comment, editBody).then((saved) => { if (saved) setEditing(false); })}>{editUploadBlocked ? "Upload pending" : "Save"}</button></div></div> : <><CommentMarkdown taskId={taskId} body={body} />{long && <button className="comment-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less" : "Show more"}</button>}</>}
      {!comment.deletedAt && <div className="comment-actions">
        {comment.reactions.map((reaction) => <button key={reaction.emoji} className={reaction.reactedByCurrentUser ? "active" : ""} type="button" disabled={!comment.permissions.canReact || busy} onClick={() => void onReact(comment, reaction.emoji, !reaction.reactedByCurrentUser)}>{reaction.emoji} <span>{reaction.count}</span></button>)}
        {comment.permissions.canReact && ["👍", "❤️", "🎉"].filter((emoji) => !comment.reactions.some((reaction) => reaction.emoji === emoji)).map((emoji) => <button className="reaction-add" key={emoji} type="button" disabled={busy} aria-label={`React ${emoji}`} onClick={() => void onReact(comment, emoji, true)}>{emoji}</button>)}
        {isRoot && comment.permissions.canReact && <button type="button" disabled={busy} onClick={() => onReply(rootId)}>Reply</button>}
        {isRoot && comment.permissions.canResolve && <button type="button" disabled={busy} onClick={() => void onResolve(comment, !comment.resolvedAt)}>{comment.resolvedAt ? "Reopen" : "Resolve"}</button>}
      </div>}
    </div>
  </div>;
}

function CommentMarkdown({ taskId, body }: { taskId: string; body: string }) {
  const attachments = useCommentAttachmentMetadata(body);
  return <MarkdownBody body={body} className="comment-body" taskId={taskId} attachments={attachments} />;
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
  const attachmentRefKey = [...new Set(
    parseTaskAttachmentReferences(body).map((reference) => reference.ref),
  )].sort().join(",");

  useEffect(() => {
    if (!attachmentRefKey) return;
    const controller = new AbortController();
    const requestedRefs = new Set(attachmentRefKey.split(","));
    void fetch(`/api/tasks/${encodeURIComponent(task.id)}/attachments`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const value = await response.json() as
          | { attachments: PublicAttachmentRecord[] }
          | { error?: string };
        if (!response.ok || !("attachments" in value)) {
          throw new Error("Native attachments could not be loaded");
        }
        setAttachmentState({
          key: attachmentRefKey,
          records: new Map(value.attachments
            .filter((attachment) => requestedRefs.has(attachment.ref))
            .map((attachment) => [attachment.ref, attachment])),
        });
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setAttachmentState({ key: attachmentRefKey, records: new Map() });
      });
    return () => controller.abort();
  }, [attachmentRefKey, task.id, task.attachmentInvalidationCursor]);

  const attachments = attachmentState.key === attachmentRefKey
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
  const lines = parseTaskMarkdownLines(body);
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
    const markdownLine = lines[index]!;
    const line = markdownLine.text;
    if (markdownLine.kind === "fence") {
      if (code) {
        blocks.push(<pre key={`code-${index}`}><code>{code.join("\n")}</code></pre>);
        code = null;
      } else {
        flushList();
        code = [];
      }
      continue;
    }
    if (markdownLine.kind === "code") {
      if (!code) code = [];
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
          width={nativeImage.width}
        />,
      );
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const checklist = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (checklist) {
      appendListItem(false, <label className="markdown-checklist-item"><input type="checkbox" checked={checklist[1].toLowerCase() === "x"} readOnly disabled /><span>{renderMarkdownInline(checklist[2], taskId, attachments)}</span></label>, index);
    } else if (bullet) {
      appendListItem(false, renderMarkdownInline(bullet[1], taskId, attachments), index);
    } else if (ordered) {
      appendListItem(true, renderMarkdownInline(ordered[1], taskId, attachments), index);
    } else {
      flushList();
      if (heading) {
        if (heading[1].length === 1) blocks.push(<h2 key={index}>{renderMarkdownInline(heading[2], taskId, attachments)}</h2>);
        else if (heading[1].length === 2) blocks.push(<h3 key={index}>{renderMarkdownInline(heading[2], taskId, attachments)}</h3>);
        else blocks.push(<h4 key={index}>{renderMarkdownInline(heading[2], taskId, attachments)}</h4>);
      } else if (line.startsWith("> ")) {
        blocks.push(<blockquote key={index}>{renderMarkdownInline(line.slice(2), taskId, attachments)}</blockquote>);
      } else if (line.trim()) {
        blocks.push(<p key={index}>{renderMarkdownInline(line, taskId, attachments)}</p>);
      }
    }
  }
  if (code) blocks.push(<pre key="code-final"><code>{code.join("\n")}</code></pre>);
  flushList();
  return <div className={className}>{blocks}</div>;
}

function renderMarkdownInline(
  value: string,
  taskId?: string,
  attachments?: Map<string, PublicAttachmentRecord> | null,
) {
  const nodes: React.ReactNode[] = [];
  for (const token of parseTaskMarkdownInlineTokens(value)) {
    if (token.kind === "code") {
      nodes.push(<code key={token.start}>{token.text}</code>);
    } else {
      nodes.push(...renderMarkdownInlineText(
        token.text,
        token.start,
        taskId,
        attachments,
      ));
    }
  }
  return nodes;
}

function renderMarkdownInlineText(
  value: string,
  keyOffset: number,
  taskId?: string,
  attachments?: Map<string, PublicAttachmentRecord> | null,
) {
  const pattern = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  const nodes: React.ReactNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > offset) nodes.push(value.slice(offset, match.index));
    const token = match[0];
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const escaped = isTaskMarkdownEscaped(value, match.index) ||
        (match.index > 0 && value[match.index - 1] === "!");
      const nativeFile = taskId && !escaped ? parseTaskFileToken(token) : null;
      if (nativeFile) {
        nodes.push(
          <TaskDescriptionFileLink
            key={keyOffset + match.index}
            taskId={taskId!}
            attachment={attachments === null || attachments === undefined
              ? undefined
              : attachments.get(nativeFile.ref) ?? null}
            label={nativeFile.label}
          />,
        );
      } else if (!escaped) {
        const href = safeMarkdownHref(link[2]);
        nodes.push(href ? <a key={keyOffset + match.index} href={href} target="_blank" rel="noreferrer">{link[1]}</a> : token);
      } else nodes.push(token);
    } else if (token.startsWith("**")) nodes.push(<strong key={keyOffset + match.index}>{token.slice(2, -2)}</strong>);
    else nodes.push(<em key={keyOffset + match.index}>{token.slice(1, -1)}</em>);
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

function PropertyValue({ label, value }: { label: string; value: string }) {
  return <div className="property-row read-only"><span>{label}</span><b>{value}</b></div>;
}

function DetailsSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) { return <section className="details-section"><h2>{icon}{title}</h2>{children}</section>; }
function TaskReference({ label, task, onOpen }: { label: string; task: TaskRecord; onOpen: (id: string) => void }) { return <a href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, () => onOpen(task.id))}><small>{label}</small><span>{task.identifier}</span><b>{task.title}</b></a>; }

function PropertyRow({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) { return <label className="property-row"><span>{icon}{label}</span>{children}</label>; }
function PropertySelect({ icon, value, onChange, children, disabled }: { icon: React.ReactNode; value: string; onChange: (value: string) => void; children: React.ReactNode; disabled?: boolean }) { return <label className="property-select">{icon}<select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>{children}</select><ChevronDown size={11} /></label>; }

function LabelChip({ label }: { label: LabelRecord }) {
  return <span className={`label-chip ${label.archivedAt ? "archived" : ""}`} style={{ "--label-color": label.color } as React.CSSProperties} title={label.description || label.name}>{label.name}</span>;
}

export function toggleLabelSelection(
  current: ReadonlySet<string>,
  labelId: string,
  labels: readonly LabelRecord[],
): Set<string> {
  const next = new Set(current);
  if (next.has(labelId)) {
    next.delete(labelId);
    return next;
  }
  const selected = labels.find((label) => label.id === labelId);
  if (selected?.groupId) {
    for (const label of labels) if (label.groupId === selected.groupId) next.delete(label.id);
  }
  next.add(labelId);
  return next;
}

function LabelPicker({ labels, selected, onToggle, disabled, label }: { labels: LabelRecord[]; selected: ReadonlySet<string>; onToggle: (labelId: string) => void; disabled?: boolean; label: string }) {
  const [query, setQuery] = useState("");
  const selectedLabels = labels.filter((item) => selected.has(item.id));
  const assignable = labels.filter((item) => !item.archivedAt || selected.has(item.id));
  const needle = query.trim().toLocaleLowerCase();
  const visible = needle
    ? assignable.filter((item) => `${item.name}\n${item.description}`.toLocaleLowerCase().includes(needle))
    : assignable;
  return <div className="label-picker"><div className="label-chip-list">{selectedLabels.map((item) => <LabelChip key={item.id} label={item} />)}{selectedLabels.length === 0 && <span className="muted-value">No labels</span>}</div><details><summary aria-label={label}><Tag size={13} />{selected.size ? `${selected.size} selected` : "Add labels"}<ChevronDown size={11} /></summary><div className="label-picker-menu" role="listbox" aria-multiselectable="true"><label className="label-picker-search"><Search size={13} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search labels…" aria-label="Search labels" /></label>{visible.length ? visible.map((item) => <label key={item.id} title={item.description || item.name}><input type="checkbox" checked={selected.has(item.id)} disabled={disabled || Boolean(item.archivedAt && !selected.has(item.id))} onChange={() => onToggle(item.id)} /><span className="label-color-dot" style={{ background: item.color }} /> <span>{item.name}</span>{item.archivedAt && <small>Archived</small>}</label>) : <p>{assignable.length ? "No matching labels." : "No active labels in this catalog."}</p>}</div></details></div>;
}

const filterFieldOptions: Array<{ value: ViewFilterField; label: string }> = [
  { value: "status", label: "Status" },
  { value: "status_category", label: "Status category" },
  { value: "priority", label: "Priority" },
  { value: "assignee", label: "Assignee" },
  { value: "project", label: "Project" },
  { value: "release", label: "Release" },
  { value: "label", label: "Label" },
  { value: "label_group", label: "Label group" },
  { value: "estimate", label: "Estimate" },
  { value: "due_date", label: "Due date" },
  { value: "parent", label: "Parent" },
  { value: "subtasks", label: "Subtasks" },
  { value: "relation", label: "Relation" },
  { value: "created_at", label: "Created date" },
  { value: "updated_at", label: "Updated date" },
  { value: "started_at", label: "Started date" },
  { value: "completed_at", label: "Completed date" },
  { value: "canceled_at", label: "Canceled date" },
  { value: "archived", label: "Archived" },
];

const filterOperatorLabels: Record<ViewFilterOperator, string> = {
  is: "is",
  is_not: "is not",
  in: "is any of",
  not_in: "is not any of",
  is_empty: "is empty",
  eq: "equals",
  neq: "does not equal",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  on: "is on",
  before: "is before",
  after: "is after",
  on_or_before: "is on or before",
  on_or_after: "is on or after",
  overdue: "is overdue",
  next_7_days: "is in the next 7 days",
  recent: "was updated recently",
};

function queryFilterCount(query: ViewQuery | undefined) {
  const canonical = canonicalViewQuery(query);
  return canonical.conditions.length + (canonical.search?.trim() ? 1 : 0);
}

function FilterLayerSummary({ data, query, emptyCopy, scopeProjectId = null }: {
  data: AppSnapshot;
  query: ViewQuery;
  emptyCopy: string;
  scopeProjectId?: string | null;
}) {
  const canonical = canonicalViewQuery(query);
  if (!queryFilterCount(canonical)) {
    return <p className="filter-layer-empty">{emptyCopy}</p>;
  }
  return <div className="filter-layer-summary" aria-label="Filter formula summary">
    {canonical.search?.trim() && <span>Search contains “{canonical.search.trim()}”</span>}
    {canonical.conditions.map((condition, index) => (
      <span key={`${condition.field}:${index}`}>{filterConditionSummary(condition, data, scopeProjectId)}</span>
    ))}
  </div>;
}

export function SavedViewFilterLayers({
  data,
  savedView,
  temporaryQuery,
  onTemporaryQuery,
  onEditSaved,
  scopeProjectId = null,
  compact = false,
}: {
  data: AppSnapshot;
  savedView?: SavedViewRecord;
  temporaryQuery: ViewQuery;
  onTemporaryQuery: (query: ViewQuery) => void;
  onEditSaved?: () => void;
  scopeProjectId?: string | null;
  compact?: boolean;
}) {
  return <div className={`filter-layers ${compact ? "compact" : ""}`}>
    {savedView && <section className="filter-layer saved-filter-layer" aria-label={`Saved in ${savedView.name}`}>
      <header>
        <span><Save size={13} />Saved in {savedView.name}</span>
        {onEditSaved && <button type="button" className="button ghost compact" onClick={onEditSaved}>Edit</button>}
      </header>
      <FilterLayerSummary data={data} query={savedView.query} emptyCopy="No saved filters" scopeProjectId={savedView.scopeProjectId} />
    </section>}
    <section className="filter-layer temporary-filter-layer" aria-label="Temporary filters">
      <header><span><ListFilter size={13} />Temporary filters</span></header>
      <FilterLayerSummary data={data} query={temporaryQuery} emptyCopy="No temporary filters" scopeProjectId={scopeProjectId} />
      <FilterConditionEditor
        data={data}
        query={temporaryQuery}
        onQuery={onTemporaryQuery}
        compact={compact}
        scopeProjectId={scopeProjectId}
        clearLabel="Clear temporary"
      />
    </section>
  </div>;
}

export function FilterPopover({ data, savedView, temporaryQuery, onTemporaryQuery, onEditSaved, scopeProjectId = null, onClose }: {
  data: AppSnapshot;
  savedView?: SavedViewRecord;
  temporaryQuery: ViewQuery;
  onTemporaryQuery: (query: ViewQuery) => void;
  onEditSaved?: () => void;
  scopeProjectId?: string | null;
  onClose: () => void;
}) {
  return <Popover title="Filter" className="filter-popover" onClose={onClose}>
    <SavedViewFilterLayers
      data={data}
      savedView={savedView}
      temporaryQuery={temporaryQuery}
      onTemporaryQuery={onTemporaryQuery}
      onEditSaved={onEditSaved}
      scopeProjectId={scopeProjectId}
    />
  </Popover>;
}

export function handleFilterPickerEscape(
  event: Pick<KeyboardEvent, "key" | "preventDefault" | "stopPropagation">,
  closePicker: () => void,
) {
  if (event.key !== "Escape") return false;
  event.preventDefault();
  event.stopPropagation();
  closePicker();
  return true;
}

export function FilterConditionEditor({ data, query, onQuery, scopeProjectId = null, compact = false, clearLabel = "Clear all" }: {
  data: AppSnapshot;
  query: ViewQuery;
  onQuery: (query: ViewQuery) => void;
  scopeProjectId?: string | null;
  compact?: boolean;
  clearLabel?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [propertySearch, setPropertySearch] = useState("");
  const [activeFieldIndex, setActiveFieldIndex] = useState(0);
  const [focusConditionIndex, setFocusConditionIndex] = useState<number | null>(null);
  const addFilterRef = useRef<HTMLButtonElement>(null);
  const fieldButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const builderRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const canonical = canonicalViewQuery(query);
  const needle = propertySearch.trim().toLocaleLowerCase();
  const availableFields = filterFieldOptions.filter((field) => field.value !== "label_group" || (data.labelGroups ?? []).length > 0);
  const fields = needle
    ? availableFields.filter((field) => field.label.toLocaleLowerCase().includes(needle))
    : availableFields;
  const replaceConditions = (conditions: ViewFilterCondition[]) => onQuery({
    version: 1,
    op: "all",
    conditions,
    ...(canonical.search?.trim() ? { search: canonical.search } : {}),
  });
  const replaceSearch = (search: string) => onQuery({
    version: 1,
    op: "all",
    conditions: canonical.conditions,
    ...(search.trim() ? { search } : {}),
  });
  const add = (field: ViewFilterField) => {
    const nextIndex = canonical.conditions.length;
    replaceConditions([...canonical.conditions, defaultFilterCondition(field, data, scopeProjectId)]);
    setPropertySearch("");
    setPickerOpen(false);
    setFocusConditionIndex(nextIndex);
  };
  const closePicker = () => {
    setPickerOpen(false);
    setPropertySearch("");
    setActiveFieldIndex(0);
    window.requestAnimationFrame(() => addFilterRef.current?.focus());
  };
  const focusField = (index: number) => {
    if (!fields.length) return;
    const next = (index + fields.length) % fields.length;
    setActiveFieldIndex(next);
    window.requestAnimationFrame(() => fieldButtonRefs.current[next]?.focus());
  };
  useEffect(() => {
    if (focusConditionIndex === null) return;
    const row = builderRef.current?.querySelectorAll<HTMLElement>("[data-filter-condition]")[focusConditionIndex];
    const nextControl = row?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    if (!nextControl) return;
    nextControl.focus();
    setFocusConditionIndex(null);
  }, [canonical.conditions.length, focusConditionIndex]);
  return <div ref={builderRef} className={`filter-builder ${compact ? "compact" : ""}`}>
    {queryFilterCount(canonical) > 0 && <div className="filter-formula" aria-label="Active filter formula">
      <span className="filter-formula-operator">AND</span>
      {canonical.search?.trim() && <div className="filter-condition-row filter-search-row">
        <b>Search</b>
        <span className="filter-search-operator" aria-label="Search operator">contains</span>
        <input
          type="search"
          aria-label="Search text"
          maxLength={500}
          value={canonical.search}
          onChange={(event) => replaceSearch(event.target.value)}
        />
        <button type="button" className="icon-button quiet" aria-label="Remove search filter" onClick={() => replaceSearch("")}><X size={13} /></button>
      </div>}
      {canonical.conditions.map((condition, index) => <div className="filter-condition-row" data-filter-condition key={`${condition.field}:${index}`}>
        <b>{filterFieldOptions.find((field) => field.value === condition.field)?.label ?? condition.field}</b>
        <select aria-label={`${condition.field} operator`} value={condition.operator} onChange={(event) => {
          const operator = event.target.value as ViewFilterOperator;
          const next = [...canonical.conditions];
          next[index] = {
            field: condition.field,
            operator,
            ...filterConditionValue(condition.field, operator, data, condition.value, scopeProjectId),
          };
          replaceConditions(next);
        }}>{filterOperators(condition.field).map((operator) => <option key={operator} value={operator}>{filterOperatorLabels[operator]}</option>)}</select>
        <FilterValueEditor condition={condition} data={data} scopeProjectId={scopeProjectId} onChange={(value) => {
          const next = [...canonical.conditions];
          next[index] = value === undefined
            ? { field: condition.field, operator: condition.operator }
            : { ...condition, value };
          replaceConditions(next);
        }} />
        <button type="button" className="icon-button quiet" aria-label={`Remove ${condition.field} filter`} onClick={() => replaceConditions(canonical.conditions.filter((_, itemIndex) => itemIndex !== index))}><X size={13} /></button>
      </div>)}
      <button className="button ghost popover-clear" type="button" onClick={() => onQuery({ version: 1, op: "all", conditions: [] })}>{clearLabel}</button>
    </div>}
    <button ref={addFilterRef} className="button ghost filter-add" type="button" aria-expanded={pickerOpen} aria-controls={pickerOpen ? menuId : undefined} onClick={() => { setPickerOpen((current) => !current); setActiveFieldIndex(0); }}><Plus size={13} />Add filter</button>
    {pickerOpen && <div className="filter-property-picker">
      <label className="filter-property-search"><Search size={13} /><input autoFocus type="search" value={propertySearch} onChange={(event) => { setPropertySearch(event.target.value); setActiveFieldIndex(0); }} onKeyDown={(event) => {
        if (handleFilterPickerEscape(event, closePicker)) return;
        if (event.key === "ArrowDown") { event.preventDefault(); focusField(activeFieldIndex); }
        if (event.key === "ArrowUp") { event.preventDefault(); focusField(activeFieldIndex - 1); }
        if (event.key === "Enter" && fields[activeFieldIndex]) { event.preventDefault(); add(fields[activeFieldIndex].value); }
      }} placeholder="Search properties…" aria-label="Search filter properties" aria-controls={menuId} /></label>
      <div id={menuId} className="filter-property-grid" role="menu" aria-label="Filter properties">
        {fields.map((field, index) => <button ref={(element) => { fieldButtonRefs.current[index] = element; }} type="button" role="menuitem" key={field.value} onClick={() => add(field.value)} onFocus={() => setActiveFieldIndex(index)} onKeyDown={(event) => {
          if (handleFilterPickerEscape(event, closePicker)) return;
          if (event.key === "ArrowDown") { event.preventDefault(); focusField(index + 1); }
          if (event.key === "ArrowUp") { event.preventDefault(); focusField(index - 1); }
        }}>{field.label}</button>)}
        {!fields.length && <p role="status">No matching properties.</p>}
      </div>
    </div>}
  </div>;
}

function FilterValueEditor({ condition, data, scopeProjectId, onChange }: {
  condition: ViewFilterCondition;
  data: AppSnapshot;
  scopeProjectId: string | null;
  onChange: (value: ViewFilterCondition["value"] | undefined) => void;
}) {
  if (["is_empty", "overdue", "next_7_days"].includes(condition.operator)) return null;
  if (condition.field === "relation") {
    const value = condition.value as { type: TaskRelationRecord["type"] | "any"; direction: "outgoing" | "incoming" | "either" };
    return <span className="filter-relation-value"><select aria-label="Relation type" value={value.type} onChange={(event) => onChange({ ...value, type: event.target.value as typeof value.type })}><option value="any">Any relation</option><option value="blocks">Blocks</option><option value="related">Related</option><option value="duplicate_of">Duplicate of</option></select><select aria-label="Relation direction" value={value.direction} onChange={(event) => onChange({ ...value, direction: event.target.value as typeof value.direction })}><option value="either">Either direction</option><option value="outgoing">Outgoing</option><option value="incoming">Incoming</option></select></span>;
  }
  if (condition.field === "label_group") {
    const value = condition.value as ViewFilterLabelGroupValue;
    const groups = data.labelGroups ?? [];
    const availableLabels = data.labels.filter((label) => label.groupId === value.groupId);
    const groupAvailable = groups.some((group) => group.id === value.groupId);
    const displayedGroupId = groupAvailable ? value.groupId : "__unavailable_label_group";
    return <span className="filter-relation-value"><select aria-label="Label Group" value={displayedGroupId} onChange={(event) => onChange({ groupId: event.target.value, mode: "any" })}>{!groupAvailable && <option value="__unavailable_label_group" disabled>Unavailable label group</option>}{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select><select aria-label="Label Group match" value={value.mode} onChange={(event) => { const mode = event.target.value as ViewFilterLabelGroupValue["mode"]; onChange({ groupId: value.groupId, mode, ...(mode === "values" ? { labelIds: availableLabels[0] ? [availableLabels[0].id] : [] } : {}) }); }}><option value="any">Any value</option><option value="values">Selected values</option><option value="none">No value</option></select>{value.mode === "values" && <select multiple aria-label="Label Group values" value={value.labelIds ?? []} onChange={(event) => onChange({ ...value, labelIds: [...event.currentTarget.selectedOptions].map((option) => option.value) })}>{availableLabels.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select>}</span>;
  }
  if (condition.field === "subtasks" || condition.field === "archived") {
    return <select aria-label={`${condition.field} value`} value={String(condition.value)} onChange={(event) => onChange(event.target.value === "true")}><option value="true">Yes</option><option value="false">No</option></select>;
  }
  if (condition.field === "estimate" || condition.operator === "recent") {
    return <input aria-label={`${condition.field} value`} type="number" min={condition.operator === "recent" ? 1 : undefined} step="1" value={Number(condition.value)} onChange={(event) => onChange(Number(event.target.value))} />;
  }
  if (["due_date", "created_at", "updated_at", "started_at", "completed_at", "canceled_at"].includes(condition.field)) {
    return <input aria-label={`${condition.field} date`} type="date" value={String(condition.value ?? "")} onChange={(event) => onChange(event.target.value)} />;
  }
  const options = filterCatalogOptions(condition.field, data, scopeProjectId);
  const selectedValues = filterConditionValues(condition);
  const missingValues = selectedValues.filter((value) => value && !options.some((option) => option.value === value));
  const unavailableOptions = missingValues.map((persistedValue, index) => ({
    value: `__unavailable_${condition.field}_${index}`,
    persistedValue,
    label: unavailableFilterLabel(condition.field),
    unavailable: true,
  }));
  const unavailableValues = new Map(
    unavailableOptions.map((option) => [option.value, option.persistedValue]),
  );
  const valueOptions = [
    ...unavailableOptions,
    ...options.map((option) => ({ ...option, persistedValue: option.value, unavailable: false })),
  ];
  if (condition.operator === "in" || condition.operator === "not_in") {
    const selected = new Set(Array.isArray(condition.value) ? condition.value : []);
    const displayed = [...selected].map((value) =>
      unavailableOptions.find((option) => option.persistedValue === value)?.value ?? String(value)
    );
    return <select multiple aria-label={`${condition.field} values`} value={displayed} onChange={(event) => onChange([...event.currentTarget.selectedOptions].map((option) => unavailableValues.get(option.value) ?? option.value))}>{valueOptions.map((option) => <option key={option.value} value={option.value} disabled={option.unavailable}>{option.label}</option>)}</select>;
  }
  const displayed = unavailableOptions[0]?.value ?? String(condition.value ?? "");
  return <select aria-label={`${condition.field} value`} value={displayed} onChange={(event) => onChange(unavailableValues.get(event.target.value) ?? event.target.value)}>{valueOptions.map((option) => <option key={option.value} value={option.value} disabled={option.unavailable}>{option.label}</option>)}</select>;
}

function FilterChips({ data, query, scopeProjectId, onQuery, onEdit }: {
  data: AppSnapshot;
  query: ViewQuery;
  scopeProjectId?: string | null;
  onQuery: (query: ViewQuery) => void;
  onEdit: () => void;
}) {
  const canonical = canonicalViewQuery(query);
  const remove = (index: number) => onQuery({ version: 1, op: "all", conditions: canonical.conditions.filter((_, itemIndex) => itemIndex !== index), ...(canonical.search?.trim() ? { search: canonical.search } : {}) });
  return <div className="filter-chip-list temporary" aria-label="Temporary filters"><span className="filter-chip-layer-label">Temporary</span>{canonical.conditions.map((condition, index) => <span className="filter-chip" key={`${condition.field}:${index}`}><button type="button" onClick={onEdit}>{filterConditionSummary(condition, data, scopeProjectId)}</button><button type="button" aria-label={`Remove ${condition.field} filter`} onClick={() => remove(index)}><X size={11} /></button></span>)}<button className="filter-clear-all" type="button" onClick={() => onQuery(emptyViewQuery())}>Clear temporary</button></div>;
}

function SavedFilterChips({ data, view, onEdit }: {
  data: AppSnapshot;
  view: SavedViewRecord;
  onEdit?: () => void;
}) {
  const canonical = canonicalViewQuery(view.query);
  if (!queryFilterCount(canonical)) return null;
  return <div className="filter-chip-list saved" aria-label={`Saved in ${view.name}`}>
    <span className="filter-chip-layer-label"><Save size={11} />Saved in {view.name}</span>
    {canonical.search?.trim() && <span className="filter-chip saved-filter-chip"><button type="button" onClick={onEdit}>Search contains “{canonical.search.trim()}”</button></span>}
    {canonical.conditions.map((condition, index) => <span className="filter-chip saved-filter-chip" key={`${condition.field}:${index}`}><button type="button" onClick={onEdit}>{filterConditionSummary(condition, data, view.scopeProjectId)}</button></span>)}
  </div>;
}

function filterOperators(field: ViewFilterField): ViewFilterOperator[] {
  if (field === "estimate") return ["eq", "neq", "gt", "gte", "lt", "lte", "is_empty"];
  if (field === "due_date") return ["on", "before", "after", "on_or_before", "on_or_after", "overdue", "next_7_days", "is_empty"];
  if (["created_at", "started_at", "completed_at", "canceled_at"].includes(field)) return ["on", "before", "after", "on_or_before", "on_or_after", "is_empty"];
  if (field === "updated_at") return ["on", "before", "after", "on_or_before", "on_or_after", "recent", "is_empty"];
  if (field === "subtasks" || field === "archived") return ["is", "is_not"];
  if (field === "relation") return ["is", "is_not", "is_empty"];
  if (field === "label_group") return ["is", "is_not"];
  return ["is", "is_not", "in", "not_in", "is_empty"];
}

function defaultFilterCondition(field: ViewFilterField, data: AppSnapshot, scopeProjectId: string | null): ViewFilterCondition {
  if (field === "label_group") {
    return { field, operator: "is", value: { groupId: (data.labelGroups ?? [])[0]?.id ?? "", mode: "any" } };
  }
  if (["status", "assignee", "project", "release", "label", "parent"].includes(field) && !filterCatalogOptions(field, data, scopeProjectId).length) {
    return { field, operator: "is_empty" };
  }
  const operator: ViewFilterOperator = field === "estimate" ? "eq" : ["due_date", "created_at", "updated_at", "started_at", "completed_at", "canceled_at"].includes(field) ? "on" : "is";
  return { field, operator, ...filterConditionValue(field, operator, data, undefined, scopeProjectId) };
}

function filterConditionValue(field: ViewFilterField, operator: ViewFilterOperator, data: AppSnapshot, previous?: ViewFilterCondition["value"], scopeProjectId: string | null = null): Pick<ViewFilterCondition, "value"> | Record<string, never> {
  if (["is_empty", "overdue", "next_7_days"].includes(operator)) return {};
  if (field === "relation") return { value: typeof previous === "object" && previous && !Array.isArray(previous) ? previous : { type: "any", direction: "either" } };
  if (field === "label_group") {
    const existing = typeof previous === "object" && previous && !Array.isArray(previous) ? previous as ViewFilterLabelGroupValue : null;
    return { value: existing ?? { groupId: (data.labelGroups ?? [])[0]?.id ?? "", mode: "any" } };
  }
  if (field === "subtasks") return { value: typeof previous === "boolean" ? previous : true };
  if (field === "archived") return { value: typeof previous === "boolean" ? previous : false };
  if (field === "estimate") return { value: typeof previous === "number" ? previous : 0 };
  if (operator === "recent") return { value: typeof previous === "number" ? previous : 24 };
  if (["due_date", "created_at", "updated_at", "started_at", "completed_at", "canceled_at"].includes(field)) return { value: typeof previous === "string" ? previous : new Date().toISOString().slice(0, 10) };
  const options = filterCatalogOptions(field, data, scopeProjectId);
  if (operator === "in" || operator === "not_in") {
    const previousValues = Array.isArray(previous) ? previous : typeof previous === "string" ? [previous] : [];
    return { value: previousValues.length ? previousValues : options[0] ? [options[0].value] : [] };
  }
  return { value: typeof previous === "string" ? previous : options[0]?.value ?? "" };
}

function filterConditionSummary(condition: ViewFilterCondition, data: AppSnapshot, scopeProjectId: string | null = null) {
  const field = filterFieldOptions.find((item) => item.value === condition.field)?.label ?? condition.field;
  if (["is_empty", "overdue", "next_7_days"].includes(condition.operator)) return `${field} ${filterOperatorLabels[condition.operator]}`;
  if (condition.field === "relation") {
    const value = condition.value as { type: string; direction: string };
    return `${field} ${filterOperatorLabels[condition.operator]} ${value.type}/${value.direction}`;
  }
  if (condition.field === "label_group") {
    const value = condition.value as ViewFilterLabelGroupValue;
    const group = (data.labelGroups ?? []).find((item) => item.id === value.groupId)?.name ?? "Unavailable label group";
    const labels = (value.labelIds ?? []).map((id) => data.labels.find((label) => label.id === id)?.name ?? "Unavailable label");
    return `${field} ${filterOperatorLabels[condition.operator]} ${group}: ${value.mode === "values" ? labels.join(", ") : value.mode}`;
  }
  const options = new Map(filterCatalogOptions(condition.field, data, scopeProjectId).map((item) => [item.value, item.label]));
  const values = Array.isArray(condition.value) ? condition.value : [String(condition.value)];
  return `${field} ${filterOperatorLabels[condition.operator]} ${values.map((value) => {
    const resolved = options.get(String(value));
    if (resolved) return resolved;
    return unavailableFilterLabel(condition.field);
  }).join(", ")}`;
}
function DisplayPopover({ display, labelGroups, onLayout, onDisplay, onClose }: { display: ViewDisplay; labelGroups: LabelGroupRecord[]; onLayout: (value: Layout) => void; onDisplay: (changes: Partial<ViewDisplay>) => void; onClose: () => void }) {
  const dependencies = viewDisplayDependencies(display);
  return <Popover title="Display" onClose={onClose}><div className="display-option"><span>Layout</span><div className="segmented wide"><button className={display.layout === "list" ? "active" : ""} onClick={() => onLayout("list")}><LayoutList size={13} />List</button><button className={display.layout === "board" ? "active" : ""} onClick={() => onLayout("board")}><Columns3 size={13} />Board</button></div></div><label className="popover-field"><span>Group by</span><select value={display.groupBy} onChange={(event) => { const groupBy = event.target.value as ViewDisplay["groupBy"]; onDisplay({ groupBy, labelGroupId: groupBy === "label_group" ? display.labelGroupId ?? labelGroups.find((group) => !group.archivedAt)?.id ?? null : null }); }}>{groupByOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>{display.groupBy === "label_group" && <label className="popover-field"><span>Label group</span><select value={display.labelGroupId ?? ""} onChange={(event) => onDisplay({ labelGroupId: event.target.value || null })}>{labelGroups.filter((group) => !group.archivedAt || group.id === display.labelGroupId).map((group) => <option key={group.id} value={group.id}>{group.name}{group.archivedAt ? " (archived)" : ""}</option>)}</select></label>}<label className="popover-field"><span>Order by</span><select value={display.orderBy} onChange={(event) => onDisplay({ orderBy: event.target.value as ViewDisplay["orderBy"] })}>{viewOrderOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label className="popover-field"><span>Direction</span><select value={display.direction} disabled={dependencies.directionDisabled} aria-describedby={dependencies.directionReason ? "display-direction-help" : undefined} onChange={(event) => onDisplay({ direction: event.target.value as ViewDisplay["direction"] })}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>{dependencies.directionReason && <small id="display-direction-help" className="display-dependency-hint">{dependencies.directionReason}</small>}<fieldset className="display-properties"><legend>Properties</legend>{viewFieldOptions.map((option) => <label key={option.value}><input type="checkbox" checked={display.visibleFields.includes(option.value)} onChange={() => onDisplay({ visibleFields: toggleViewField(display.visibleFields, option.value) })} />{option.label}</label>)}</fieldset><label className="display-checkbox"><input type="checkbox" checked={display.showEmptyGroups} disabled={dependencies.emptyGroupsDisabled} aria-describedby={dependencies.emptyGroupsReason ? "display-empty-groups-help" : undefined} onChange={(event) => onDisplay({ showEmptyGroups: event.target.checked })} /><span>Show empty groups</span></label>{dependencies.emptyGroupsReason && <small id="display-empty-groups-help" className="display-dependency-hint">{dependencies.emptyGroupsReason}</small>}</Popover>;
}
function Popover({ title, onClose, children, className = "" }: { title: string; onClose: () => void; children: React.ReactNode; className?: string }) { return <div className={`popover ${className}`}><header><b>{title}</b><button onClick={onClose}><X size={13} /></button></header>{children}</div>; }

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
  embedded = false,
}: {
  initialStatuses: WorkflowStatusRecord[];
  onClose: () => void;
  onStatuses: (statuses: WorkflowStatusRecord[]) => void;
  embedded?: boolean;
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

  const body = <>
      {!embedded && <DialogHeader title="Workflow statuses" icon={<SlidersHorizontal size={17} />} onClose={() => busyId === null && onClose()} />}
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
    </>;
  return embedded
    ? <section className="settings-catalog" aria-label="Workflow status settings">{body}</section>
    : <Modal onClose={() => busyId === null && onClose()} className="workflow-settings-modal" ariaLabel="Workflow status settings">{body}</Modal>;
}

type LabelSettingsRecord = LabelRecord & { taskCount: number };
type LabelGroupSettingsRecord = LabelGroupRecord & { taskCount: number; labelCount: number };

function LabelGroupSettingsDialog({
  initialGroups,
  initialLabels,
  onClose,
  onGroups,
  onLabels,
}: {
  initialGroups: LabelGroupRecord[];
  initialLabels: LabelRecord[];
  onClose: () => void;
  onGroups: (groups: LabelGroupRecord[]) => void;
  onLabels: (labels: LabelRecord[]) => void;
}) {
  const [groups, setGroups] = useState<LabelGroupSettingsRecord[]>(
    initialGroups.map((group) => ({ ...group, taskCount: 0, labelCount: 0 })),
  );
  const [labels, setLabels] = useState<LabelRecord[]>(initialLabels);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [groupResponse, labelResponse] = await Promise.all([
      fetch("/api/settings/label-groups", { cache: "no-store" }),
      fetch("/api/settings/labels", { cache: "no-store" }),
    ]);
    const groupValue = await groupResponse.json() as { labelGroups?: LabelGroupSettingsRecord[]; error?: string };
    const labelValue = await labelResponse.json() as { labels?: LabelSettingsRecord[]; error?: string };
    if (!groupResponse.ok || !groupValue.labelGroups) throw new Error(groupValue.error ?? "Label Groups could not be loaded");
    if (!labelResponse.ok || !labelValue.labels) throw new Error(labelValue.error ?? "Labels could not be loaded");
    setGroups(groupValue.labelGroups);
    setLabels(labelValue.labels);
    onGroups(groupValue.labelGroups);
    onLabels(labelValue.labels);
  }, [onGroups, onLabels]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "Catalog could not be loaded"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function write(path: string, method: "POST" | "PATCH", body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error ?? "Catalog could not be saved");
      await refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Catalog could not be saved");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const activeGroups = groups.filter((group) => !group.archivedAt);
  const archivedGroups = groups.filter((group) => group.archivedAt);
  const renderGroup = (group: LabelGroupSettingsRecord) => (
    <article className={`label-settings-row ${group.archivedAt ? "archived" : ""}`} key={`${group.id}:${group.version}`}>
      <form onSubmit={(event) => { event.preventDefault(); const value = Object.fromEntries(new FormData(event.currentTarget)); void write(`/api/settings/label-groups/${encodeURIComponent(group.id)}`, "PATCH", { action: "update", version: group.version, name: value.name, description: value.description, position: Number(value.position) }); }}>
        <span className="label-settings-main">
          <input name="name" defaultValue={group.name} disabled={busy || Boolean(group.archivedAt)} aria-label={`Name for ${group.name}`} />
          <input name="description" defaultValue={group.description} disabled={busy || Boolean(group.archivedAt)} placeholder="Usage guidance" />
          <input name="position" type="number" min="0" defaultValue={group.position} disabled={busy || Boolean(group.archivedAt)} aria-label={`Position for ${group.name}`} />
          <small>{group.labelCount} labels · {group.taskCount} tasks</small>
        </span>
        {!group.archivedAt && <button className="button ghost compact" disabled={busy}>Save</button>}
      </form>
      <div className="label-settings-actions">
        <button className={`button ghost compact ${group.archivedAt ? "" : "danger"}`} type="button" disabled={busy} onClick={() => void write(`/api/settings/label-groups/${encodeURIComponent(group.id)}`, "PATCH", { action: group.archivedAt ? "restore" : "archive", version: group.version })}>{group.archivedAt ? <ArchiveRestore size={13} /> : <Archive size={13} />}{group.archivedAt ? "Restore" : "Archive"}</button>
      </div>
    </article>
  );

  return <Modal onClose={() => !busy && onClose()} className="workflow-settings-modal" ariaLabel="Label Group settings">
    <DialogHeader title="Label groups" icon={<Tag size={17} />} onClose={() => !busy && onClose()} />
    <p className="dialog-copy">Each Task can hold one value from a group. Ungrouped labels remain independently selectable.</p>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    <div className="label-settings-list">{activeGroups.map(renderGroup)}</div>
    <form className="label-settings-create" onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; const value = Object.fromEntries(new FormData(form)); if (await write("/api/settings/label-groups", "POST", value)) form.reset(); }}>
      <input name="name" required maxLength={80} placeholder="New label group" disabled={busy} />
      <input name="description" maxLength={2000} placeholder="Usage guidance" disabled={busy} />
      <button className="button primary" disabled={busy}><Plus size={14} />Add group</button>
    </form>
    <section className="details-section">
      <h2><Tag size={14} />Group membership</h2>
      <div className="label-settings-list">{labels.map((label) => <label className="property-row" key={`${label.id}:${label.version}`}><span><span className="label-color-dot" style={{ background: label.color }} />{label.name}</span><select value={label.groupId ?? ""} disabled={busy || Boolean(label.archivedAt)} onChange={(event) => void write(`/api/settings/labels/${encodeURIComponent(label.id)}`, "PATCH", { action: "update", version: label.version, groupId: event.target.value || null })}><option value="">Ungrouped</option>{activeGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>)}</div>
    </section>
    {archivedGroups.length > 0 && <details className="workflow-archived"><summary>Archived groups ({archivedGroups.length})</summary><div className="label-settings-list">{archivedGroups.map(renderGroup)}</div></details>}
  </Modal>;
}

function LabelSettingsDialog({
  onClose,
  onLabels,
  onGroups,
  embedded = false,
}: {
  onClose: () => void;
  onLabels: (labels: LabelRecord[]) => void;
  onGroups?: (groups: LabelGroupRecord[]) => void;
  embedded?: boolean;
}) {
  const [labels, setLabels] = useState<LabelSettingsRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const onLabelsRef = useRef(onLabels);

  useEffect(() => { onLabelsRef.current = onLabels; }, [onLabels]);
  const apply = useCallback((next: LabelSettingsRecord[]) => {
    setLabels(next);
    onLabelsRef.current(next);
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
      const value = await response.json() as { labels?: LabelSettingsRecord[]; error?: string };
      if (!response.ok || !value.labels) {
        if (response.status === 409) {
          const refreshedResponse = await fetch("/api/settings/labels", { cache: "no-store" });
          const refreshed = await refreshedResponse.json() as { labels?: LabelSettingsRecord[] };
          if (refreshedResponse.ok && refreshed.labels) apply(refreshed.labels);
        }
        throw new Error(value.error ?? "Label could not be saved");
      }
      apply(value.labels);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Label could not be saved");
      return false;
    } finally {
      setBusyId(null);
    }
  }, [apply]);

  useEffect(() => {
    let current = true;
    void fetch("/api/settings/labels", { cache: "no-store" })
      .then(async (response) => {
        const value = await response.json() as { labels?: LabelSettingsRecord[]; error?: string };
        if (!response.ok || !value.labels) throw new Error(value.error ?? "Labels could not be loaded");
        if (current) apply(value.labels);
      })
      .catch((requestError: unknown) => {
        if (current) setError(requestError instanceof Error ? requestError.message : "Labels could not be loaded");
      })
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [apply]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    void onGroups;
    if (await request("/api/settings/labels", "POST", values, "create")) form.reset();
  }

  function row(label: LabelSettingsRecord) {
    return <article className={`label-settings-row ${label.archivedAt ? "archived" : ""}`} key={`${label.id}:${label.version}`}><form onSubmit={(event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); void request(`/api/settings/labels/${encodeURIComponent(label.id)}`, "PATCH", { action: "update", version: label.version, name: values.name, color: values.color, description: values.description }, label.id); }}><input className="workflow-color" type="color" name="color" defaultValue={label.color} aria-label={`Color for ${label.name}`} disabled={Boolean(label.archivedAt) || busyId !== null} /><span className="label-settings-main"><input name="name" defaultValue={label.name} aria-label={`Name for ${label.name}`} disabled={Boolean(label.archivedAt) || busyId !== null} /><input name="description" defaultValue={label.description} placeholder="Usage guidance" aria-label={`Description for ${label.name}`} disabled={Boolean(label.archivedAt) || busyId !== null} /><small>{label.taskCount} Task{label.taskCount === 1 ? "" : "s"}</small></span>{!label.archivedAt && <button className="button ghost compact" disabled={busyId !== null}>Save</button>}</form><div className="label-settings-actions">{label.archivedAt ? <button className="button ghost compact" type="button" disabled={busyId !== null} onClick={() => void request(`/api/settings/labels/${encodeURIComponent(label.id)}`, "PATCH", { action: "restore", version: label.version }, label.id)}><ArchiveRestore size={13} />Restore</button> : <button className="button ghost compact danger" type="button" disabled={busyId !== null} onClick={() => void request(`/api/settings/labels/${encodeURIComponent(label.id)}`, "PATCH", { action: "archive", version: label.version }, label.id)}><Archive size={13} />Archive</button>}</div></article>;
  }

  const active = labels.filter((label) => !label.archivedAt);
  const archived = labels.filter((label) => label.archivedAt);
  const body = <>{!embedded && <DialogHeader title="Labels" icon={<Tag size={17} />} onClose={() => busyId === null && onClose()} />}<p className="dialog-copy">Labels belong to your catalog. Archiving blocks new assignments while preserving existing Task history.</p>{error && <p className="dialog-error" role="alert">{error}</p>}{loading ? <p className="dialog-copy">Loading labels…</p> : <div className="label-settings-list">{active.map(row)}</div>}<form className="label-settings-create" onSubmit={create}><input className="workflow-color" type="color" name="color" defaultValue="#6b7280" aria-label="New Label color" disabled={busyId !== null} /><input name="name" required maxLength={80} placeholder="New label" aria-label="New Label name" disabled={busyId !== null} /><input name="description" maxLength={2000} placeholder="Usage guidance" aria-label="New Label description" disabled={busyId !== null} /><button className="button primary" disabled={busyId !== null}><Plus size={14} />Add</button></form>{archived.length > 0 && <details className="workflow-archived"><summary>Archived labels ({archived.length})</summary><div className="label-settings-list">{archived.map(row)}</div></details>}</>;
  return embedded
    ? <section className="settings-catalog" aria-label="Label settings">{body}</section>
    : <Modal onClose={() => busyId === null && onClose()} className="workflow-settings-modal" ariaLabel="Label settings">{body}</Modal>;
}

const settingsNavigation: Array<{
  group: string;
  items: Array<{ section: SettingsSection; label: string; icon: React.ReactNode }>;
}> = [
  { group: "Personal", items: [
    { section: "profile", label: "Profile", icon: <UserRound size={15} /> },
    { section: "appearance", label: "Appearance", icon: <Palette size={15} /> },
  ] },
  { group: "Workspace", items: [
    { section: "workflow-statuses", label: "Workflow statuses", icon: <SlidersHorizontal size={15} /> },
    { section: "labels", label: "Labels", icon: <Tag size={15} /> },
  ] },
  { group: "Integrations", items: [
    { section: "integrations", label: "Codex setup", icon: <CircleHelp size={15} /> },
  ] },
  { group: "Data & backups", items: [
    { section: "project-backup", label: "Project backup", icon: <Database size={15} /> },
    { section: "recently-deleted", label: "Recently deleted", icon: <Trash2 size={15} /> },
  ] },
];

export function SettingsSurface({
  section,
  data,
  theme,
  sidebarCollapsed,
  signOutPath,
  onNavigate,
  onProfile,
  onAppearance,
  onStatuses,
  onLabels,
  onGroups,
  recentlyDeletedEpoch,
  onDeletionWorkspaceChanged,
}: {
  section: string;
  data: AppSnapshot;
  theme: "system" | "light" | "dark";
  sidebarCollapsed: boolean;
  signOutPath: string;
  onNavigate: (section: SettingsSection) => void;
  onProfile: (profile: UserProfile) => void;
  onAppearance: (changes: { theme?: "system" | "light" | "dark"; sidebarPreference?: "expanded" | "collapsed" }) => void;
  onStatuses: (statuses: WorkflowStatusRecord[]) => void;
  onLabels: (labels: LabelRecord[]) => void;
  onGroups?: (groups: LabelGroupRecord[]) => void;
  recentlyDeletedEpoch?: number;
  onDeletionWorkspaceChanged?: () => Promise<unknown> | unknown;
}) {
  const [labelGroupsOpen, setLabelGroupsOpen] = useState(false);
  const active = settingsNavigation.flatMap((group) => group.items)
    .find((item) => item.section === section)?.section ?? "profile";
  const profile = data.userProfile ?? {
    user: {
      ...data.user,
      version: data.user.version ?? 1,
      theme: data.user.theme ?? "system",
      sidebarPreference: data.user.sidebarPreference ?? "expanded",
    },
    identities: [{ provider: "chatgpt" as const, verifiedEmail: data.user.email }],
  };

  return <div className="settings-surface">
    <nav className="settings-navigation" aria-label="Settings sections">
      {settingsNavigation.map((group) => <section key={group.group}>
        <h2>{group.group}</h2>
        {group.items.map((item) => <a
          key={item.section}
          className={active === item.section ? "active" : ""}
          href={`/settings/${item.section}`}
          aria-current={active === item.section ? "page" : undefined}
          onClick={(event) => handleLocalLink(event, () => onNavigate(item.section))}
        >{item.icon}<span>{item.label}</span></a>)}
      </section>)}
    </nav>
    <article className="settings-content">
      {active === "profile" && <SettingsSectionHeader title="Profile" description="Your verified identity and personal date semantics." />}
      {active === "appearance" && <SettingsSectionHeader title="Appearance" description="Choose how Task Manager looks and how its navigation opens." />}
      {active === "workflow-statuses" && <SettingsSectionHeader title="Workflow statuses" description="Manage your account-owned workflow catalog." />}
      {active === "labels" && <SettingsSectionHeader title="Labels" description="Manage labels without losing archived assignments or history." />}
      {active === "integrations" && <SettingsSectionHeader title="Codex setup" description="Connect through the published plugin and OAuth-safe flow." />}
      {active === "project-backup" && <SettingsSectionHeader title="Project backup" description="Export or atomically restore Projects that you currently own." />}
      {active === "recently-deleted" && <SettingsSectionHeader title="Recently deleted" description="Restore deleted records or permanently remove owner-controlled data." />}

      {active === "profile" && <ProfileSettingsPanel key={profile.user.version} profile={profile} signOutPath={signOutPath} onProfile={onProfile} />}
      {active === "appearance" && <AppearanceSettingsPanel theme={theme} sidebarCollapsed={sidebarCollapsed} onChange={onAppearance} />}
      {active === "workflow-statuses" && <WorkflowSettingsDialog embedded initialStatuses={data.statuses.filter((status) => status.ownerUserId === data.user.id)} onClose={() => undefined} onStatuses={onStatuses} />}
      {active === "labels" && <>
        <div className="catalog-toolbar">
          <button className="button ghost compact" type="button" onClick={() => setLabelGroupsOpen(true)}>Manage label groups</button>
        </div>
        <LabelSettingsDialog embedded onClose={() => undefined} onLabels={onLabels} />
        {labelGroupsOpen && <LabelGroupSettingsDialog
          initialGroups={(data.labelGroups ?? []).filter((group) => group.ownerUserId === data.user.id)}
          initialLabels={data.labels.filter((label) => label.ownerUserId === data.user.id)}
          onClose={() => setLabelGroupsOpen(false)}
          onGroups={(groups) => onGroups?.(groups)}
          onLabels={onLabels}
        />}
      </>}
      {active === "integrations" && <CodexSetupDialog embedded onClose={() => undefined} />}
      {active === "project-backup" && <ProjectBackupManager embedded initialSnapshot={data} />}
      {active === "recently-deleted" && <RecentlyDeletedManager invalidationEpoch={recentlyDeletedEpoch} onWorkspaceChanged={onDeletionWorkspaceChanged} />}
    </article>
  </div>;
}

function SettingsSectionHeader({ title, description }: { title: string; description: string }) {
  return <header className="settings-section-header"><h1>{title}</h1><p>{description}</p></header>;
}

function ProfileSettingsPanel({
  profile,
  signOutPath,
  onProfile,
}: {
  profile: UserProfile;
  signOutPath: string;
  onProfile: (profile: UserProfile) => void;
}) {
  const [displayName, setDisplayName] = useState(profile.user.displayName);
  const [timezone, setTimezone] = useState(profile.user.timezone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const timezones = supportedTimeZones(profile.user.timezone);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setSaved(false);
    try {
      const response = await fetch("/api/settings/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: profile.user.version, displayName, timezone }),
      });
      const value = await response.json() as UserProfile | { error: string };
      if (!response.ok || "error" in value) {
        if (response.status === 409) {
          const refreshed = await fetch("/api/settings/profile", { cache: "no-store" });
          const latest = await refreshed.json() as UserProfile | { error: string };
          if (refreshed.ok && !("error" in latest)) onProfile(latest);
        }
        throw new Error("error" in value ? value.error : "Profile could not be saved");
      }
      onProfile(value);
      setSaved(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Profile could not be saved");
    } finally {
      setBusy(false);
    }
  }

  return <form className="settings-form" onSubmit={save}>
    <div className="settings-form-row"><span><label htmlFor="settings-display-name">Display name</label><small>Shown on your tasks, comments, and shared resources.</small></span><input id="settings-display-name" required maxLength={120} value={displayName} onChange={(event) => { setDisplayName(event.target.value); setSaved(false); }} /></div>
    <div className="settings-form-row"><span><label htmlFor="settings-verified-email">Verified email</label><small>Managed by the authenticated provider.</small></span><input id="settings-verified-email" readOnly value={profile.user.email} aria-readonly="true" /></div>
    <div className="settings-form-row"><span><label htmlFor="settings-timezone">Timezone</label><small>Used for calendar dates, filters, and displayed timestamps.</small></span><select id="settings-timezone" value={timezone} onChange={(event) => { setTimezone(event.target.value); setSaved(false); }}>{timezones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></div>
    <section className="settings-provider-list" aria-labelledby="linked-provider-heading"><div><h2 id="linked-provider-heading">Linked providers</h2><p>Provider identity is projected by the server and cannot be changed by this form.</p></div>{profile.identities.map((identity) => <div className="settings-provider-row" key={`${identity.provider}:${identity.verifiedEmail}`}><span className="avatar small">{identity.provider === "chatgpt" ? "C" : "G"}</span><span><b>{identity.provider === "chatgpt" ? "ChatGPT" : "Google"}</b><small>{identity.verifiedEmail}</small></span><strong>Verified</strong></div>)}</section>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    <div className="settings-form-actions"><span role="status">{saved ? "Saved" : ""}</span><button className="button primary" disabled={busy || !displayName.trim()}>{busy ? "Saving…" : "Save profile"}</button></div>
    <div className="settings-signout"><span><b>Session</b><small>Sign out through the Sites-managed session.</small></span><a className="button secondary" href={signOutPath}><LogOut size={14} />Sign out</a></div>
  </form>;
}

function AppearanceSettingsPanel({
  theme,
  sidebarCollapsed,
  onChange,
}: {
  theme: "system" | "light" | "dark";
  sidebarCollapsed: boolean;
  onChange: (changes: { theme?: "system" | "light" | "dark"; sidebarPreference?: "expanded" | "collapsed" }) => void;
}) {
  return <div className="settings-form">
    <section className="settings-choice-row"><div className="settings-choice-label"><b>Theme</b><small>Synced to your Task Manager account.</small></div><div role="group" aria-label="Theme preference">{(["system", "light", "dark"] as const).map((value) => <button key={value} type="button" className={theme === value ? "active" : ""} aria-pressed={theme === value} onClick={() => onChange({ theme: value })}>{value === "system" ? <Monitor size={15} /> : value === "light" ? <Sun size={15} /> : <Moon size={15} />}{displayLabel(value)}</button>)}</div></section>
    <section className="settings-choice-row"><div className="settings-choice-label"><b>Sidebar</b><small>Choose the default navigation state for this account.</small></div><div role="group" aria-label="Sidebar preference"><button type="button" className={!sidebarCollapsed ? "active" : ""} aria-pressed={!sidebarCollapsed} onClick={() => onChange({ sidebarPreference: "expanded" })}><PanelLeftOpen size={15} />Expanded</button><button type="button" className={sidebarCollapsed ? "active" : ""} aria-pressed={sidebarCollapsed} onClick={() => onChange({ sidebarPreference: "collapsed" })}><PanelLeftClose size={15} />Collapsed</button></div></section>
  </div>;
}

function supportedTimeZones(current: string): string[] {
  const values = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] })
    .supportedValuesOf?.("timeZone") ?? [];
  return [...new Set(["UTC", current, ...values])].sort((left, right) => left.localeCompare(right));
}

export function ProjectDialog({ project, currentUser, leadOptions, openTaskCount, onClose, onSubmit, onArchive, busy }: { project?: ProjectRecord; currentUser: UserRecord; leadOptions: UserRecord[]; openTaskCount: number; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void>; onArchive?: () => Promise<void>; busy: boolean }) {
  const [name, setName] = useState(project?.name ?? "");
  const [taskCode, setTaskCode] = useState(project?.taskCode ?? "PR");
  const [codeEdited, setCodeEdited] = useState(Boolean(project));
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? "planned");
  const terminalWarning = Boolean(project && openTaskCount > 0 && (status === "completed" || status === "canceled") && status !== project.status);
  const codeLocked = Boolean(project?.codeLockedAt || (project?.taskSequence ?? 0) > 0);
  return <Modal onClose={onClose} className="project-dialog" ariaLabel={project ? `Edit ${project.name}` : "Create project"}><form onSubmit={(event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); void onSubmit({ ...values, leadUserId: values.leadUserId || null, confirmOpenTasks: values.confirmOpenTasks === "on" }); }}><DialogHeader title={project ? "Edit project" : "Create project"} icon={<ProjectIcon project={project} size={17} />} onClose={onClose} /><div className="form-stack project-form-stack"><label><span>Project name</span><input name="name" required autoFocus value={name} onChange={(event) => { const next = event.target.value; setName(next); if (!codeEdited) setTaskCode(suggestProjectTaskCode(next)); }} /></label><div className="project-form-grid"><label><span>Task code</span><input name="taskCode" required minLength={1} pattern={PROJECT_TASK_CODE_INPUT_PATTERN} value={taskCode} readOnly={codeLocked} className={codeLocked ? "read-only-control" : undefined} onChange={(event) => { setCodeEdited(true); setTaskCode(normalizeProjectTaskCodeDraft(event.target.value)); }} aria-describedby="project-code-help" /></label><label><span>Status</span><select name="status" value={status} onChange={(event) => setStatus(event.target.value as ProjectStatus)}>{projectStatusOptions.map((value) => <option key={value} value={value}>{projectStatusLabel(value)}</option>)}</select></label></div><small id="project-code-help" className="dialog-copy">{codeLocked ? `Locked after ${project?.taskSequence ?? 0} allocated Task number${project?.taskSequence === 1 ? "" : "s"}.` : "1–12 characters: Latin letters, digits, and internal hyphens. The code locks after this Project receives its first Task."}</small><label><span>Short summary</span><input name="summary" maxLength={500} defaultValue={project?.summary ?? ""} /></label><label><span>Markdown description</span><textarea name="description" rows={7} defaultValue={project?.description ?? ""} placeholder="Project context, outcome, and constraints…" /></label><div className="project-form-grid"><label><span>Lead</span><select name="leadUserId" defaultValue={project?.leadUserId ?? currentUser.id}><option value="">No lead</option>{leadOptions.map((user) => <option key={user.id} value={user.id}>{user.displayName}</option>)}</select></label><label><span>Icon</span><select name="icon" defaultValue={project?.icon ?? "cube"}><option value="cube">Cube</option><option value="folder">Folder</option><option value="target">Target</option><option value="rocket">Rocket</option></select></label><label><span>Color</span><input name="color" type="color" defaultValue={project?.color ?? "#8b7cf6"} /></label></div><div className="project-form-grid"><label><span>Start date</span><input name="startDate" type="date" defaultValue={project?.startDate ?? ""} /></label><label><span>Target date</span><input name="targetDate" type="date" defaultValue={project?.targetDate ?? ""} /></label></div>{terminalWarning && <label className="project-terminal-warning"><input name="confirmOpenTasks" type="checkbox" required /><span>This Project has {openTaskCount} open Task{openTaskCount === 1 ? "" : "s"}. Confirm the terminal transition.</span></label>}</div><div className="project-dialog-footer">{project && onArchive && <button className={`button ghost ${project.archivedAt ? "" : "danger"}`} type="button" disabled={busy} onClick={() => void onArchive()}>{project.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}{project.archivedAt ? "Restore project" : "Archive project"}</button>}<div><button className="button ghost" type="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !name.trim() || !isProjectTaskCode(taskCode)}>{busy ? "Saving…" : project ? "Save changes" : "Create"}</button></div></div></form></Modal>;
}
const releaseStatusOptions: ReleaseStatus[] = ["planned", "active", "released", "canceled"];

export function ReleaseDialog({ release, projects, initialProjectId, openTaskCount, onClose, onSubmit, onDelete, busy }: { release?: ReleaseRecord; projects: ProjectRecord[]; initialProjectId: string | null; openTaskCount: number; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void>; onDelete?: () => void; busy: boolean }) {
  const [name, setName] = useState(release?.name ?? "");
  const [status, setStatus] = useState<ReleaseStatus>(release?.status ?? "planned");
  const terminalWarning = status === "released" && release?.status !== "released" && openTaskCount > 0;
  const reopenWarning = release?.status === "released" && status !== "released";
  return <Modal onClose={onClose} className="project-dialog release-dialog" ariaLabel={release ? `Edit ${release.name}` : "Create release"}>
    <form onSubmit={(event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); void onSubmit({ ...values, confirmOpenTasks: values.confirmOpenTasks === "on" }); }}>
      <DialogHeader title={release ? "Edit release" : "Create release"} icon={<Rocket size={17} />} onClose={onClose} />
      <div className="form-stack project-form-stack">
        <label><span>Release name / version</span><input name="name" required autoFocus placeholder="v1.0" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="project-form-grid"><label><span>Project</span><select name="projectId" required disabled={Boolean(release)} defaultValue={release?.projectId ?? initialProjectId ?? ""}><option value="" disabled>Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label><span>Status</span><select name="status" value={status} onChange={(event) => setStatus(event.target.value as ReleaseStatus)}>{releaseStatusOptions.map((value) => <option key={value} value={value}>{projectStatusLabel(value)}</option>)}</select></label><label><span>Target date</span><input name="targetDate" type="date" defaultValue={release?.targetDate ?? ""} /></label></div>
        <label><span>Markdown description</span><textarea name="description" rows={6} defaultValue={release?.description ?? ""} placeholder="Release outcome and scope…" /></label>
        <label><span>Release notes</span><textarea name="releaseNotes" rows={7} defaultValue={release?.releaseNotes ?? ""} placeholder="Published changes, migration notes, and known limitations…" /></label>
        {terminalWarning && <label className="project-terminal-warning"><input name="confirmOpenTasks" type="checkbox" required /><span>This Release has {openTaskCount} open Task{openTaskCount === 1 ? "" : "s"}. Confirm publishing without changing their statuses.</span></label>}
        {reopenWarning && <p className="release-transition-note">Leaving Released clears the server release timestamp; Tasks remain unchanged.</p>}
      </div>
      {!projects.length && <p className="inline-note">Create a project before adding a release.</p>}
      <div className="project-dialog-footer">
        {release && onDelete ? <button className="button ghost danger" type="button" disabled={busy} onClick={onDelete}><Trash2 size={14} />Delete release…</button> : <span />}
        <div><button className="button ghost" type="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !name.trim() || !projects.length}>{busy ? "Saving…" : release ? "Save changes" : "Create release"}</button></div>
      </div>
    </form>
  </Modal>;
}
export function viewDialogDraftQuery(
  editing: boolean,
  view: SavedViewRecord | undefined,
  query: ViewQuery,
) {
  return canonicalViewQuery(editing ? view?.query : query);
}

type ViewDialogDraft = {
  name: string;
  scopeProjectId: string | null;
  query: ViewQuery;
  display: ViewDisplay;
};

function comparableViewDialogDraft(draft: ViewDialogDraft) {
  return JSON.stringify({
    name: draft.name.trim(),
    scopeProjectId: draft.scopeProjectId || null,
    query: canonicalViewQuery(draft.query),
    display: {
      ...draft.display,
      labelGroupId: draft.display.labelGroupId ?? null,
      visibleFields: [...draft.display.visibleFields],
    },
  });
}

export function viewDialogDraftIsDirty(initial: ViewDialogDraft, current: ViewDialogDraft) {
  return comparableViewDialogDraft(initial) !== comparableViewDialogDraft(current);
}

function ViewDisplayEditor({ display, data, scopeProjectId, onDisplay }: {
  display: ViewDisplay;
  data: AppSnapshot;
  scopeProjectId: string | null;
  onDisplay: (changes: Partial<ViewDisplay>) => void;
}) {
  const dependencies = viewDisplayDependencies(display);
  const labelGroups = filterCatalogOptions("label_group", data, scopeProjectId);
  return <div className="view-display-editor">
    <div className="display-option"><span>Layout</span><div className="segmented wide"><button type="button" className={display.layout === "list" ? "active" : ""} onClick={() => onDisplay({ layout: "list" })}><LayoutList size={13} />List</button><button type="button" className={display.layout === "board" ? "active" : ""} onClick={() => onDisplay({ layout: "board" })}><Columns3 size={13} />Board</button></div></div>
    <label className="popover-field"><span>Group by</span><select value={display.groupBy} onChange={(event) => { const groupBy = event.target.value as ViewDisplay["groupBy"]; onDisplay({ groupBy, labelGroupId: groupBy === "label_group" ? display.labelGroupId ?? labelGroups[0]?.value ?? null : null }); }}>{groupByOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    {display.groupBy === "label_group" && <label className="popover-field"><span>Label group</span><select value={display.labelGroupId ?? ""} onChange={(event) => onDisplay({ labelGroupId: event.target.value || null })}>{labelGroups.map((group) => <option key={group.value} value={group.value}>{group.label}</option>)}</select></label>}
    <label className="popover-field"><span>Order by</span><select value={display.orderBy} onChange={(event) => onDisplay({ orderBy: event.target.value as ViewDisplay["orderBy"] })}>{viewOrderOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    <label className="popover-field"><span>Direction</span><select value={display.direction} disabled={dependencies.directionDisabled} aria-describedby={dependencies.directionReason ? "view-direction-help" : undefined} onChange={(event) => onDisplay({ direction: event.target.value as ViewDisplay["direction"] })}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
    {dependencies.directionReason && <small id="view-direction-help" className="display-dependency-hint">{dependencies.directionReason}</small>}
    <fieldset className="display-properties"><legend>Properties</legend>{viewFieldOptions.map((option) => <label key={option.value}><input type="checkbox" checked={display.visibleFields.includes(option.value)} onChange={() => onDisplay({ visibleFields: toggleViewField(display.visibleFields, option.value) })} />{option.label}</label>)}</fieldset>
    <label className="display-checkbox"><input type="checkbox" checked={display.showEmptyGroups} disabled={dependencies.emptyGroupsDisabled} aria-describedby={dependencies.emptyGroupsReason ? "view-empty-groups-help" : undefined} onChange={(event) => onDisplay({ showEmptyGroups: event.target.checked })} /><span>Show empty groups</span></label>
    {dependencies.emptyGroupsReason && <small id="view-empty-groups-help" className="display-dependency-hint">{dependencies.emptyGroupsReason}</small>}
  </div>;
}

export function ViewDialog({ view, editing, query, display, data, initialScopeProjectId, temporaryFilterCount = 0, submissionError = "", onClose, onSubmit, busy }: { view?: SavedViewRecord; editing: boolean; query: ViewQuery; display: ViewDisplay; data: AppSnapshot; initialScopeProjectId: string | null; temporaryFilterCount?: number; submissionError?: string; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<boolean | void>; busy: boolean }) {
  const [initialDraft] = useState<ViewDialogDraft>(() => ({
    name: editing ? view?.name ?? "" : view ? `${view.name} copy` : "",
    scopeProjectId: initialScopeProjectId || null,
    query: viewDialogDraftQuery(editing, view, query),
    display: { ...display, visibleFields: [...display.visibleFields] },
  }));
  const [name, setName] = useState(initialDraft.name);
  const [scopeProjectId, setScopeProjectId] = useState(initialDraft.scopeProjectId ?? "");
  const [savedQueryDraft, setSavedQueryDraft] = useState<ViewQuery>(initialDraft.query);
  const [displayDraft, setDisplayDraft] = useState<ViewDisplay>(initialDraft.display);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [localError, setLocalError] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const canMoveScope = !editing || view?.accessRole === "owner";
  const projects = data.projects.filter((project) => !project.archivedAt && canEditContent(project.accessRole));
  const currentDraft = { name, scopeProjectId: scopeProjectId || null, query: savedQueryDraft, display: displayDraft };
  const dirty = viewDialogDraftIsDirty(initialDraft, currentDraft);
  const unavailableReferences = unavailableFilterReferences(savedQueryDraft, data, scopeProjectId || null);
  const invalid = !name.trim() || unavailableReferences.length > 0;
  const canSubmit = !invalid && (!editing || dirty) && !busy && !submitting;
  const dependencies = viewDisplayDependencies(displayDraft);
  const changeDisplayDraft = (changes: Partial<ViewDisplay>) => setDisplayDraft((current) => ({ ...current, ...changes }));
  const requestClose = () => {
    if (submitting || busy) return;
    if (confirmDiscard) {
      setConfirmDiscard(false);
      return;
    }
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setLocalError("");
    try {
      const result = await onSubmit({ name: name.trim(), query: canonicalViewQuery(savedQueryDraft), display: displayDraft, scopeProjectId: scopeProjectId || null });
      if (result === false) setLocalError("The view could not be saved. Your draft is still here.");
    } catch (requestError) {
      setLocalError(requestError instanceof Error ? requestError.message : "The view could not be saved. Your draft is still here.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  return <Modal onClose={requestClose} className="project-dialog view-dialog" ariaLabel={editing ? `Edit ${view?.name ?? "Saved View"}` : "Save as view"}>
    <form onSubmit={submit}>
      <DialogHeader className="view-dialog-header" title={editing ? "Edit view" : "Save as view"} icon={<Zap size={17} />} onClose={requestClose} />
      <div className="view-dialog-body form-stack project-form-stack">
        <div className="view-dialog-general"><label><span>View name</span><input ref={nameInputRef} name="name" required autoFocus placeholder="e.g. Upcoming launch" value={name} onChange={(event) => setName(event.target.value)} /></label><label><span>Scope</span><select name="scopeProjectId" value={scopeProjectId} disabled={!canMoveScope} onChange={(event) => setScopeProjectId(event.target.value)}><option value="">Workspace (global)</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.taskCode} · {project.name}</option>)}</select></label></div>
        {editing && temporaryFilterCount > 0 && <p className="view-temporary-warning" role="note"><ListFilter size={14} /><span><b>{temporaryFilterCount} temporary filter{temporaryFilterCount === 1 ? " is" : "s are"} not part of this Saved View.</b> Saving keeps {temporaryFilterCount === 1 ? "it" : "them"} active only in the current URL until you choose Clear temporary.</span></p>}
        <section className="view-dialog-section" aria-labelledby="saved-view-filter-heading"><header><h3 id="saved-view-filter-heading">Saved filters</h3><span>{queryFilterCount(savedQueryDraft)} active</span></header><FilterConditionEditor data={data} query={savedQueryDraft} scopeProjectId={scopeProjectId || null} onQuery={setSavedQueryDraft} clearLabel="Clear saved filters" /></section>
        <section className="view-dialog-section" aria-labelledby="saved-view-display-heading"><header><h3 id="saved-view-display-heading">Display</h3></header><ViewDisplayEditor display={displayDraft} data={data} scopeProjectId={scopeProjectId || null} onDisplay={changeDisplayDraft} /></section>
        {scopeProjectId ? <p className="dialog-copy">This view is limited to the selected Project and inherits its access.</p> : <p className="dialog-copy">A global view only returns Tasks the reader can already access.</p>}
        {unavailableReferences.length > 0 && <p className="dialog-warning" role="alert">Choose an available value for {unavailableReferences.length} filter reference{unavailableReferences.length === 1 ? "" : "s"} before saving. Stored references were not replaced.</p>}
        {(localError || submissionError) && <p className="error-banner" role="alert">{localError || submissionError}</p>}
      </div>
      <div className="view-dialog-footer project-dialog-footer"><span>{editing && !dirty ? "No changes" : dependencies.directionReason ?? ""}</span><div><button className="button ghost" type="button" disabled={busy || submitting} onClick={requestClose}>Cancel</button><button className="button primary" disabled={!canSubmit}>{busy || submitting ? "Saving…" : editing ? "Save changes" : "Save view"}</button></div></div>
      {confirmDiscard && <div className="view-discard-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="discard-view-title"><h3 id="discard-view-title">Discard changes?</h3><p>Your unsaved view changes will be lost.</p><div><button autoFocus className="button ghost" type="button" onClick={() => { setConfirmDiscard(false); window.requestAnimationFrame(() => nameInputRef.current?.focus()); }}>Keep editing</button><button className="button danger" type="button" onClick={onClose}>Discard</button></div></div>}
    </form>
  </Modal>;
}

function TeamsSurface({ currentUser }: { currentUser: AppSnapshot["user"] }) {
  const [teams, setTeams] = useState<TeamRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void teamRequest<TeamCatalog>("/api/teams", { signal: controller.signal })
      .then((catalog) => {
        setTeams(catalog.teams);
        setSelectedId((current) => current && catalog.teams.some((team) => team.id === current)
          ? current
          : catalog.teams[0]?.id ?? null);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError(requestError instanceof Error ? requestError.message : "Teams could not be loaded");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const selected = teams.find((team) => team.id === selectedId) ?? null;
  const visibleTeams = teams.filter((team) => team.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const replaceTeam = (team: TeamRecord) => {
    setTeams((current) => current.map((item) => item.id === team.id ? team : item));
    setSelectedId(team.id);
  };
  const mutateTeam = async (
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    input: Record<string, unknown>,
  ) => {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      const result = await teamRequest<{ team: TeamRecord }>(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      replaceTeam(result.team);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Team could not be changed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return <section className="teams-surface" aria-label="Teams catalog">
    <div className="teams-catalog-pane">
      <div className="teams-catalog-controls">
        <label className="search-control"><Search size={13} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Teams…" aria-label="Search Teams" />{search && <button type="button" aria-label="Clear Team search" onClick={() => setSearch("")}><X size={12} /></button>}</label>
        <form onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          const form = event.currentTarget;
          const values = new FormData(form);
          setBusy(true);
          setError("");
          try {
            const result = await teamRequest<{ team: TeamRecord }>("/api/teams", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: String(values.get("name") ?? "") }),
            });
            setTeams((current) => [...current, result.team].sort((left, right) => left.name.localeCompare(right.name)));
            setSelectedId(result.team.id);
            form.reset();
          } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : "Team could not be created");
          } finally {
            setBusy(false);
          }
        }} className="team-create-form"><input name="name" required maxLength={100} placeholder="New Team name" aria-label="New Team name" /><button className="button primary compact" disabled={busy}><Plus size={13} />Create</button></form>
      </div>
      {loading ? <div className="teams-empty" role="status">Loading Teams…</div> : visibleTeams.length === 0 ? <div className="teams-empty"><b>{teams.length ? "No matching Teams" : "No Teams yet"}</b><span>Create a Team to share work with a stable group.</span></div> : <div className="team-card-list">{visibleTeams.map((team) => <button type="button" key={team.id} className={`team-card ${selectedId === team.id ? "active" : ""}`} onClick={() => setSelectedId(team.id)}><span className="team-avatar"><UsersRound size={16} /></span><span><b>{team.name}</b><small>{team.activeMemberCount} active member{team.activeMemberCount === 1 ? "" : "s"}</small></span><span className="role-badge">{team.currentMembership.role === "owner" ? "Owner" : "Member"}</span></button>)}</div>}
    </div>
    <div className="team-detail-pane">
      {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss Team error" onClick={() => setError("")}><X size={14} /></button></div>}
      {!selected ? <div className="teams-empty"><UsersRound size={24} /><b>Select a Team</b><span>Its active membership and management controls appear here.</span></div> : <>
        <header className="team-detail-header"><span className="team-avatar large"><UsersRound size={19} /></span><span><h2>{selected.name}</h2><p>{selected.canManageMembers ? "You own this Team and can manage membership." : `You are an active ${selected.currentMembership.role}.`}</p></span><span className="status-badge">{selected.activeMemberCount} active</span></header>
        {selected.canManageMembers && <form className="team-member-form" onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = new FormData(form);
          const ok = await mutateTeam(`/api/teams/${encodeURIComponent(selected.id)}/members`, "POST", { email: String(values.get("email") ?? "") });
          if (ok) form.reset();
        }}><input name="email" type="email" required placeholder="Registered user email" aria-label="Registered user email" /><button className="button primary" disabled={busy}>Add member</button></form>}
        <div className="team-member-list" role="list">{selected.members.map((member) => <div className={`team-member-row ${member.status === "inactive" ? "inactive" : ""}`} role="listitem" key={member.id}><span className="avatar">{initials(member.displayName)}</span><span><b>{member.displayName}{member.userId === currentUser.id ? " (you)" : ""}</b><small>{member.email}</small></span><span className="role-badge">{member.role === "owner" ? "Owner" : member.status === "active" ? "Active" : "Inactive"}</span>{selected.canManageMembers && member.role !== "owner" ? <div className="team-member-actions"><button className="button ghost compact" type="button" disabled={busy} onClick={() => void mutateTeam(`/api/teams/${encodeURIComponent(selected.id)}/members/${encodeURIComponent(member.id)}`, "PATCH", { version: member.version, status: member.status === "active" ? "inactive" : "active" })}>{member.status === "active" ? "Deactivate" : "Reactivate"}</button><button className="button ghost compact danger-text" type="button" disabled={busy} onClick={() => { if (window.confirm(`Remove ${member.displayName} from ${selected.name}?`)) void mutateTeam(`/api/teams/${encodeURIComponent(selected.id)}/members/${encodeURIComponent(member.id)}`, "DELETE", { version: member.version }); }}>Remove</button></div> : <span />}</div>)}</div>
      </>}
    </div>
  </section>;
}

async function teamRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const value = await response.json() as T & { error?: string };
  if (!response.ok || value.error) throw new Error(value.error ?? "Request failed");
  return value;
}

function ShareDialog({ target, currentUser, users, collaborators, onClose, onShare, onRoleChange, onRevoke, onTransfer, busy }: { target: ShareTarget | null; currentUser: AppSnapshot["user"]; users: AppSnapshot["users"]; collaborators: AppSnapshot["collaborators"]; onClose: () => void; onShare: (input: Record<string, unknown>) => Promise<boolean>; onRoleChange: (grantId: string, permission: "manager" | "editor" | "viewer") => Promise<boolean>; onRevoke: (grantId: string) => Promise<boolean>; onTransfer: (projectId: string, targetUserId: string) => Promise<boolean>; busy: boolean }) {
  const [tab, setTab] = useState<"people" | "teams">("people");
  const [teamScope, setTeamScope] = useState<"project" | "task">("project");
  const [teams, setTeams] = useState<TeamRecord[]>([]);
  const [teamGrants, setTeamGrants] = useState<TeamGrantRecord[]>([]);
  const [teamSearch, setTeamSearch] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamError, setTeamError] = useState("");
  const teamTarget = target?.directTeamTask && teamScope === "task"
    ? {
        resourceType: "task" as const,
        resourceId: target.directTeamTask.resourceId,
        label: target.directTeamTask.label,
        accessRole: target.directTeamTask.accessRole,
        inherited: false,
      }
    : target
      ? {
          resourceType: target.resourceType,
          resourceId: target.resourceId,
          label: target.label,
          accessRole: target.accessRole,
          inherited: target.inherited,
        }
      : null;
  const teamTargetResourceType = teamTarget?.resourceType;
  const teamTargetResourceId = teamTarget?.resourceId;

  useEffect(() => {
    const controller = new AbortController();
    void teamRequest<TeamCatalog>("/api/teams", { signal: controller.signal })
      .then((catalog) => {
        setTeams(catalog.teams);
        setSelectedTeamId((current) => current && catalog.teams.some((team) => team.id === current)
          ? current
          : catalog.teams[0]?.id ?? "");
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setTeamError(requestError instanceof Error ? requestError.message : "Teams could not be loaded");
      })
      .finally(() => setTeamLoading(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!teamTargetResourceType || !teamTargetResourceId) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setTeamLoading(true);
        setTeamError("");
      }
    });
    const query = new URLSearchParams({
      resourceType: teamTargetResourceType,
      resourceId: teamTargetResourceId,
    });
    void teamRequest<{ teamGrants: TeamGrantRecord[] }>(`/api/team-grants?${query}`, { signal: controller.signal })
      .then((result) => setTeamGrants(result.teamGrants))
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setTeamError(requestError instanceof Error ? requestError.message : "Team access could not be loaded");
      })
      .finally(() => setTeamLoading(false));
    return () => controller.abort();
  }, [teamTargetResourceId, teamTargetResourceType]);

  if (!target || !teamTarget) return null;
  const grants = collaborators.filter((grant) => grant.resourceType === target.resourceType && grant.resourceId === target.resourceId);
  const assignableRoles = (["manager", "editor", "viewer"] as const).filter((role) => canAssignRole(target.accessRole, target.resourceType, role));
  const assignableTeamRoles = (["manager", "editor", "viewer"] as const).filter((role) => canAssignRole(teamTarget.accessRole, teamTarget.resourceType, role));
  const owner = target.ownerUserId === currentUser.id
    ? currentUser
    : users.find((user) => user.id === target.ownerUserId);
  const ownerName = owner?.displayName ?? "Project owner";
  const inheritanceCopy = target.inherited
    ? "Access applies to every task, release, and project-scoped saved view."
    : target.resourceType === "task"
      ? "Access applies only to this standalone task."
      : "A shared view still shows only tasks the person can already access.";
  const visibleTeams = teams.filter((team) => team.name.toLocaleLowerCase().includes(teamSearch.trim().toLocaleLowerCase()));
  const commitTeamResult = (result: { teamGrants: TeamGrantRecord[] }) => {
    setTeamGrants(result.teamGrants);
    setTeamError("");
  };
  const mutateTeamGrant = async (
    method: "POST" | "PATCH" | "DELETE",
    input: Record<string, unknown>,
  ) => {
    if (teamBusy) return false;
    setTeamBusy(true);
    setTeamError("");
    try {
      commitTeamResult(await teamRequest<{ teamGrants: TeamGrantRecord[] }>("/api/team-grants", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }));
      return true;
    } catch (requestError) {
      setTeamError(requestError instanceof Error ? requestError.message : "Team access could not be changed");
      return false;
    } finally {
      setTeamBusy(false);
    }
  };

  return <Modal onClose={onClose} className="share-dialog"><div>
    <DialogHeader title={`People & Teams · ${target.label}`} icon={<UsersRound size={17} />} onClose={onClose} />
    <div className="share-tabs" role="tablist" aria-label="Access principal type"><button type="button" role="tab" aria-selected={tab === "people"} className={tab === "people" ? "active" : ""} onClick={() => setTab("people")}><UserRound size={14} />People</button><button type="button" role="tab" aria-selected={tab === "teams"} className={tab === "teams" ? "active" : ""} onClick={() => setTab("teams")}><UsersRound size={14} />Teams</button></div>
    {tab === "people" ? <form onSubmit={async (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      const ok = await onShare({
        resourceType: target.resourceType,
        resourceId: target.resourceId,
        email: String(values.get("email") ?? ""),
        permission: String(values.get("permission") ?? "viewer"),
      });
      if (ok) event.currentTarget.reset();
    }}><p className="dialog-copy">Add a registered person by verified email. They must have signed in once; no email is sent. {inheritanceCopy}</p><div className="role-guide">{target.resourceType === "project" && <><span><b>Owner</b> has full control and can transfer ownership.</span><span><b>Manager</b> edits work and manages Editors/Viewers.</span></>}<span><b>Editor</b> creates, changes, moves, archives, and restores work.</span><span><b>Viewer</b> can only read.</span></div><div className="share-input"><input name="email" type="email" required placeholder="name@example.com" autoFocus /><select name="permission" defaultValue={assignableRoles.includes("editor") ? "editor" : assignableRoles[0]} aria-label="Person role">{assignableRoles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select><button className="button primary" disabled={busy || assignableRoles.length === 0}>{busy ? "Adding…" : "Add person"}</button></div><div className="access-list"><div className="access-row"><span className="avatar">{initials(ownerName)}</span><span><b>{ownerName}</b><small>{owner?.email ?? "Current project owner"}</small></span><em>Owner</em></div>{grants.map((grant) => {
      const manageable = canManageGrant(target.accessRole, target.resourceType, grant.permission);
      const roles = (["manager", "editor", "viewer"] as const).filter((role) => canAssignRole(target.accessRole, target.resourceType, role));
      return <div className="access-row" key={grant.grantId}><span className="avatar">{initials(grant.displayName)}</span><span><b>{grant.displayName}</b><small>{grant.email}</small></span><select aria-label={`Role for ${grant.displayName}`} value={grant.permission} disabled={busy || !manageable} onChange={(event) => void onRoleChange(grant.grantId, event.target.value as "manager" | "editor" | "viewer")}><option value={grant.permission}>{roleLabel(grant.permission)}</option>{roles.filter((role) => role !== grant.permission).map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select><div className="access-actions">{target.resourceType === "project" && target.accessRole === "owner" && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Transfer ownership of ${target.label} to ${grant.displayName}? You will become Manager.`)) void onTransfer(target.resourceId, grant.userId); }}>Make owner</button>}{manageable && <button type="button" disabled={busy} onClick={() => void onRevoke(grant.grantId)}>Remove</button>}</div></div>;
    })}</div></form> : <div className="team-share-panel">
      {target.directTeamTask && <div className="team-scope-picker" role="group" aria-label="Team access scope"><button type="button" className={teamScope === "project" ? "active" : ""} aria-pressed={teamScope === "project"} onClick={() => setTeamScope("project")}><b>{target.label}</b><small>Inherited by all Project work</small></button><button type="button" className={teamScope === "task" ? "active" : ""} aria-pressed={teamScope === "task"} onClick={() => setTeamScope("task")}><b>{target.directTeamTask.label}</b><small>Direct access to this Task only</small></button></div>}
      <p className="dialog-copy">{teamTarget.inherited ? "A Team grant on this Project is inherited by its Tasks, Releases, and project-scoped Saved Views." : teamTarget.resourceType === "task" ? "This direct Team route opens only the selected Task; it does not open the Project or sibling Tasks." : "This Team route is direct. Global Saved Views still return only work each member can already access."}</p>
      {teamError && <p className="dialog-error" role="alert">{teamError}</p>}
      <form className="team-grant-form" onSubmit={async (event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        await mutateTeamGrant("POST", {
          teamId: String(values.get("teamId") ?? ""),
          resourceType: teamTarget.resourceType,
          resourceId: teamTarget.resourceId,
          permission: String(values.get("permission") ?? "viewer"),
        });
      }}><label><span>Find Team</span><input value={teamSearch} onChange={(event) => setTeamSearch(event.target.value)} placeholder="Search by Team name" aria-label="Search Teams to grant" /></label><label><span>Team</span><select name="teamId" required value={selectedTeamId} onChange={(event) => setSelectedTeamId(event.target.value)} aria-label="Team">{visibleTeams.map((team) => <option key={team.id} value={team.id}>{team.name} · {team.activeMemberCount} active</option>)}</select></label><label><span>Role</span><select name="permission" defaultValue={assignableTeamRoles.includes("editor") ? "editor" : assignableTeamRoles[0]} aria-label="Team role">{assignableTeamRoles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></label><button className="button primary" disabled={teamBusy || teamLoading || !selectedTeamId || assignableTeamRoles.length === 0}>{teamBusy ? "Granting…" : "Grant Team access"}</button></form>
      {teams.length === 0 && !teamLoading && <p className="team-share-empty">No selectable Teams. <a href="/teams">Create a Team first</a>.</p>}
      <div className="access-list team-access-list">{teamLoading && <div className="teams-empty" role="status">Loading Team access…</div>}{!teamLoading && teamGrants.length === 0 && <div className="teams-empty"><b>No Team access yet</b><span>Direct person grants remain unchanged.</span></div>}{teamGrants.map((grant) => {
        const manageable = canManageGrant(teamTarget.accessRole, teamTarget.resourceType, grant.permission);
        const roles = (["manager", "editor", "viewer"] as const).filter((role) => canAssignRole(teamTarget.accessRole, teamTarget.resourceType, role));
        return <div className="access-row" key={grant.id}><span className="team-avatar small"><UsersRound size={13} /></span><span><b>{grant.teamName}</b><small>{teamTarget.inherited ? "via Team · inherited from Project" : "via Team · direct"}</small></span><select aria-label={`Role for Team ${grant.teamName}`} value={grant.permission} disabled={teamBusy || !manageable} onChange={(event) => void mutateTeamGrant("PATCH", { grantId: grant.id, version: grant.version, permission: event.target.value })}><option value={grant.permission}>{roleLabel(grant.permission)}</option>{roles.filter((role) => role !== grant.permission).map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}</select>{manageable ? <button type="button" disabled={teamBusy} onClick={() => void mutateTeamGrant("DELETE", { grantId: grant.id, version: grant.version })}>Remove</button> : <span />}</div>;
      })}</div>
    </div>}
  </div></Modal>;
}

function roleLabel(role: "owner" | "manager" | "editor" | "viewer") {
  return role === "owner" ? "Owner" : role === "manager" ? "Manager" : role === "editor" ? "Editor" : "Viewer";
}

function browserSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function backupPhaseLabel(phase: string) {
  const labels: Record<string, string> = {
    freezing_d1: "Фиксация D1",
    inventory_r2: "Инвентаризация файлов",
    hash_objects: "Проверка файлов",
    build_rows: "Упаковка таблиц",
    build_object_parts: "Упаковка файлов",
    state_digest_rows: "Контрольная сумма D1",
    state_digest_objects: "Контрольная сумма R2",
    finalize_export: "Завершение экспорта",
    uploading: "Загрузка частей",
    validating_parts: "Проверка частей",
    validating_objects: "Проверка файлов",
    preflight: "Полная проверка состояния",
    revalidate_r2: "Повторная проверка R2",
    apply_revalidate_rows: "Проверка D1 перед заменой",
    apply_revalidate_objects: "Проверка R2 перед заменой",
    prepare_rollback: "Подготовка страховочного снимка",
    waiting_rollback: "Ожидание страховочного снимка",
    materializing: "Подготовка новых объектов",
    d1_cutover: "Атомарная замена D1",
    verifying_d1: "Проверка восстановленной D1",
    verification_failed: "D1 заменена, проверка не пройдена",
    verifying_objects: "Проверка восстановленного R2",
    cleanup: "Очистка прежних объектов",
    ready: "Готово",
    applied: "Восстановлено",
    failed: "Остановлено",
    expired: "Срок задания истёк",
  };
  return labels[phase] ?? "Обработка";
}

function backupByteSize(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** index);
  return `${amount.toLocaleString("ru-RU", { maximumFractionDigits: index === 0 ? 0 : 1 })} ${units[index]}`;
}

function backupOriginLabel(origin: string) {
  try {
    return new URL(origin).host;
  } catch {
    return "текущий Site";
  }
}

function rememberBackupStatus(
  key: string,
  status: SystemBackupJobStatus,
  extra: Pick<SystemBackupCheckpoint, "file" | "relatedJobId"> = {},
) {
  const storage = browserSessionStorage();
  if (!storage) return;
  writeBackupCheckpoint(
    storage,
    key,
    retainBackupCheckpoint(status)
      ? { jobId: status.jobId, kind: status.kind, ...extra }
      : null,
  );
}

function clearBackupStatus(key: string) {
  const storage = browserSessionStorage();
  if (storage) writeBackupCheckpoint(storage, key, null);
}

export function SystemBackupProgress({ status }: { status: SystemBackupJobStatus }) {
  return <div className="system-backup-progress" role="status" aria-live="polite">
    <span className={`system-backup-state ${status.status}`}>{backupPhaseLabel(status.phase)}</span>
    <dl>
      <div><dt>Строки</dt><dd>{status.progress.rows.toLocaleString("ru-RU")}</dd></div>
      <div><dt>Данные</dt><dd>{backupByteSize(status.progress.bytes)}</dd></div>
      <div><dt>Части</dt><dd>{status.progress.parts.toLocaleString("ru-RU")}</dd></div>
      <div><dt>Контрольная точка</dt><dd>{longDateTime(status.updatedAt)}</dd></div>
    </dl>
  </div>;
}

export function SystemBackupPreview({ status }: { status: SystemBackupJobStatus }) {
  const counts = Object.entries(status.counts).sort(([left], [right]) => left.localeCompare(right));
  const namespaces = Object.entries(status.r2.namespaces).sort(([left], [right]) => left.localeCompare(right));
  const policies = [
    ["Точно сохраняются", status.policies.exact],
    ["Перестраиваются", status.policies.rebuild],
    ["Сбрасываются", status.policies.reset],
    ["Отзываются", status.policies.revoke],
    ["Не входят", status.policies.excluded],
  ] as const;
  return <div className="system-backup-preview">
    <div className="system-import-valid"><Check size={15} /><span><b>Полная проверка пройдена</b><small>{status.exportedAt ? `Снимок от ${longDateTime(status.exportedAt)}` : "Дата снимка уточняется"}</small></span></div>
    <dl className="system-backup-metadata">
      <div><dt>Формат</dt><dd>{status.format.name} v{status.format.version}</dd></div>
      <div><dt>Схема</dt><dd>{status.schemaVersion}</dd></div>
      <div><dt>Site</dt><dd>{backupOriginLabel(status.siteOrigin)}</dd></div>
      <div><dt>Среда</dt><dd>{status.environmentScope}</dd></div>
      <div className="wide"><dt>Fingerprint схемы</dt><dd><code>{status.schemaFingerprint}</code></dd></div>
      <div className="wide"><dt>Root SHA-256</dt><dd><code>{status.rootSha256 ?? "—"}</code></dd></div>
      <div className="wide"><dt>State SHA-256</dt><dd><code>{status.stateSha256 ?? "—"}</code></dd></div>
    </dl>
    <details className="system-backup-details" open>
      <summary>Все таблицы · {counts.length}</summary>
      <dl className="system-import-counts">
        {counts.map(([name, count]) => <div key={name}><dt>{name}</dt><dd>{count.toLocaleString("ru-RU")}</dd></div>)}
      </dl>
    </details>
    <details className="system-backup-details" open>
      <summary>Файлы R2</summary>
      <dl className="system-backup-r2">
        <div><dt>Объекты</dt><dd>{status.r2.objects.toLocaleString("ru-RU")}</dd></div>
        <div><dt>Объём</dt><dd>{backupByteSize(status.r2.bytes)}</dd></div>
        <div><dt>Связанные</dt><dd>{status.r2.bound.toLocaleString("ru-RU")}</dd></div>
        <div><dt>Несвязанные</dt><dd>{status.r2.unbound.toLocaleString("ru-RU")}</dd></div>
        <div><dt>Сироты</dt><dd>{status.r2.orphan.toLocaleString("ru-RU")}</dd></div>
      </dl>
      {namespaces.length > 0 && <dl className="system-backup-namespaces">{namespaces.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value.objects.toLocaleString("ru-RU")} · {backupByteSize(value.bytes)}</dd></div>)}</dl>}
    </details>
    <details className="system-backup-details">
      <summary>Политики восстановления</summary>
      <dl className="system-backup-policies">{policies.map(([label, values]) => <div key={label}><dt>{label}</dt><dd>{values.length > 0 ? values.join(", ") : "—"}</dd></div>)}</dl>
    </details>
    {(status.rollbackJobId || status.cleanupPending || status.error) && <dl className="system-backup-operational">
      {status.rollbackJobId && <div><dt>Страховочный job</dt><dd>{status.rollbackJobId}</dd></div>}
      {status.cleanupPending && <div><dt>Очистка</dt><dd>Замена завершена; очистка прежних объектов ещё идёт.</dd></div>}
      {status.error && <div><dt>Состояние ошибки</dt><dd>{safeBackupMessage(status.error)}</dd></div>}
    </dl>}
    {status.warnings.length > 0 && <div className="system-backup-messages warning" role="status"><b>Предупреждения</b><ul>{status.warnings.map((warning, index) => <li key={`${warning}:${index}`}>{safeBackupMessage(warning)}</li>)}</ul></div>}
    {status.validationErrors.length > 0 && <div className="system-backup-messages error" role="alert"><b>Ошибки проверки</b><ul>{status.validationErrors.map((error, index) => <li key={`${error}:${index}`}>{safeBackupMessage(error)}</li>)}</ul></div>}
  </div>;
}

export function SystemBackupExportDialog({
  status,
  busy,
  waitingForNetwork,
  error,
  onClose,
  onStart,
  onResume,
}: {
  status: SystemBackupJobStatus | null;
  busy: boolean;
  waitingForNetwork: boolean;
  error: string;
  onClose: () => void;
  onStart: (fresh?: boolean) => void;
  onResume: () => void;
}) {
  const [downloadStartedForJobId, setDownloadStartedForJobId] = useState<string | null>(null);
  const downloadStarted = downloadStartedForJobId === status?.jobId;
  const downloadUrl = safeSystemBackupDownloadUrl(status?.downloadUrl ?? null);
  const terminalFailure = status?.status === "failed" || status?.status === "expired";
  const resumable = Boolean(status && !backupJobIsTerminal(status) && !busy);
  const stateLabel = status?.status === "ready"
    ? "Экспорт готов"
    : terminalFailure
      ? "Экспорт остановлен"
      : waitingForNetwork
        ? "Ожидается сеть — можно возобновить"
        : busy
          ? "Экспорт выполняется"
          : resumable
            ? "Экспорт можно возобновить"
            : "Подготовка экспорта";
  return <Modal onClose={onClose} className="system-import-modal system-export-modal">
    <DialogHeader title="Экспорт полного состояния" icon={<Download size={17} />} onClose={onClose} />
    <div className="system-import-body">
      <p>Снимок включает состояние всех пользователей, проектов, задач, представлений и оригиналы файлов. Он содержит чувствительные данные — храните его как секрет.</p>
      <div className={`system-export-runtime ${waitingForNetwork ? "waiting" : status?.status ?? "idle"}`} role="status" aria-live="polite">
        <b>{stateLabel}</b>
        <span>Пока Task Manager открыт, экспорт продолжает работу независимо от этого окна. При полностью закрытой вкладке он безопасно приостановится и продолжится после следующего открытия Administration.</span>
      </div>
      {status && <SystemBackupProgress status={status} />}
      {status?.status === "ready" && <SystemBackupPreview status={status} />}
      {error && <p className="system-import-error" role="alert">{error}</p>}
    </div>
    <div className="dialog-footer system-backup-footer">
      <span>{downloadStarted ? "Загрузка передана браузеру" : status?.status === "ready" ? "Файл готов и не кэшируется" : "Состояние задания хранится на сервере"}</span>
      <div>
        <button className="button ghost" type="button" onClick={onClose}>Закрыть окно</button>
        {!status && !busy && <button className="button primary" type="button" onClick={() => onStart()}><Download size={14} />Начать экспорт</button>}
        {terminalFailure && <button className="button ghost" type="button" disabled={busy} onClick={() => onStart()}><RotateCw size={14} />Начать заново</button>}
        {resumable && <button className="button primary" type="button" onClick={onResume}><RotateCw size={14} />Продолжить</button>}
        {status?.status === "ready" && <button className="button ghost" type="button" onClick={() => onStart(true)}><RotateCw size={14} />Новый экспорт</button>}
        {downloadUrl && <a className="button primary" href={downloadUrl} download onClick={() => setDownloadStartedForJobId(status?.jobId ?? null)}><Download size={14} />Скачать .tmbak</a>}
      </div>
    </div>
  </Modal>;
}

export function SystemImportDialog({
  onClose,
  onBusyChange,
  onApplied,
}: {
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onApplied: (result: SystemBackupJobStatus) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<SystemBackupJobStatus | null>(null);
  const [safetyStatus, setSafetyStatus] = useState<SystemBackupJobStatus | null>(null);
  const [safetyDownloaded, setSafetyDownloaded] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const booted = useRef(false);
  const safetyBootedFor = useRef<string | null>(null);

  const setImportBusy = useCallback((value: boolean) => {
    setBusy(value);
    onBusyChange(value);
  }, [onBusyChange]);

  const updateImportStatus = useCallback((next: SystemBackupJobStatus, selectedFile?: File | null) => {
    setStatus(next);
    const source = selectedFile ?? file;
    rememberBackupStatus(systemBackupImportCheckpointKey, next, source ? {
      file: { name: source.name, size: source.size, lastModified: source.lastModified },
    } : {});
  }, [file]);

  const finishResumedImport = useCallback(async (initial: SystemBackupJobStatus) => {
    setImportBusy(true);
    setError("");
    try {
      const result = await runSystemBackupJob(initial, { onProgress: updateImportStatus, stepDelayMs: 0 });
      updateImportStatus(result);
      if (result.status === "applied") {
        clearBackupStatus(systemBackupImportCheckpointKey);
        clearBackupStatus(systemBackupSafetyExportCheckpointKey);
        onApplied(result);
      } else if (result.phase === "verification_failed") {
        setError("D1 уже заменена, но post-restore проверка не прошла. Не запускайте замену повторно вслепую.");
      } else if (result.status === "failed" || result.status === "expired") {
        setError("Сервер остановил операцию до подтверждённого восстановления.");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось продолжить операцию.");
    } finally {
      setImportBusy(false);
    }
  }, [onApplied, setImportBusy, updateImportStatus]);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const storage = browserSessionStorage();
    const checkpoint = storage ? readBackupCheckpoint(storage, systemBackupImportCheckpointKey) : null;
    if (!checkpoint) return;
    void getBackupJobStatus(checkpoint.jobId).then((current) => {
      setStatus(current);
      if (current.status === "uploading") return;
      if (current.status !== "ready" && current.status !== "failed" && current.status !== "expired" && current.status !== "applied") {
        void finishResumedImport(current);
      } else if (current.status === "applied") {
        clearBackupStatus(systemBackupImportCheckpointKey);
        onApplied(current);
      }
    }).catch((requestError: unknown) => {
      clearBackupStatus(systemBackupImportCheckpointKey);
      setError(requestError instanceof Error ? requestError.message : "Сохранённый импорт недоступен.");
    });
  }, [finishResumedImport, onApplied]);

  useEffect(() => {
    if (!status || !backupImportIsFullyValidated(status) || safetyBootedFor.current === status.jobId) return;
    const importJobId = status.jobId;
    safetyBootedFor.current = importJobId;
    const storage = browserSessionStorage();
    const checkpoint = storage ? readBackupCheckpoint(storage, systemBackupSafetyExportCheckpointKey) : null;
    if (!checkpoint || checkpoint.relatedJobId !== importJobId) {
      if (checkpoint) clearBackupStatus(systemBackupSafetyExportCheckpointKey);
      return;
    }
    void getBackupJobStatus(checkpoint.jobId).then((current) => {
      setSafetyStatus(current);
      if (current.status !== "ready" && current.status !== "failed" && current.status !== "expired") {
        setImportBusy(true);
        void runSystemBackupJob(current, {
          onProgress: (next) => {
            setSafetyStatus(next);
            rememberBackupStatus(systemBackupSafetyExportCheckpointKey, next, { relatedJobId: importJobId });
          },
          stepDelayMs: 0,
        }).finally(() => setImportBusy(false));
      }
    }).catch(() => clearBackupStatus(systemBackupSafetyExportCheckpointKey));
  }, [setImportBusy, status]);

  async function validateFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setImportBusy(true);
    setError("");
    setSafetyDownloaded(false);
    setSafetyStatus(null);
    setConfirmation("");
    clearBackupStatus(systemBackupSafetyExportCheckpointKey);
    const storage = browserSessionStorage();
    const checkpoint = storage ? readBackupCheckpoint(storage, systemBackupImportCheckpointKey) : null;
    try {
      const result = await uploadSystemBackupPackage(file, {
        checkpoint,
        onCheckpoint: (next) => {
          if (storage) writeBackupCheckpoint(storage, systemBackupImportCheckpointKey, next);
        },
        onProgress: (next) => updateImportStatus(next, file),
      });
      updateImportStatus(result, file);
      if (result.status === "failed" || result.status === "expired") {
        setError("Backup не прошёл проверку. Рабочие данные не менялись.");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось проверить backup-файл.");
    } finally {
      setImportBusy(false);
    }
  }

  async function createSafetyBackup() {
    if (!status || !backupImportIsFullyValidated(status)) return;
    setImportBusy(true);
    setError("");
    setSafetyDownloaded(false);
    try {
      const created = await createSystemBackupExport(fetch, { fresh: true });
      setSafetyStatus(created);
      rememberBackupStatus(systemBackupSafetyExportCheckpointKey, created, { relatedJobId: status.jobId });
      const result = await runSystemBackupJob(created, {
        onProgress: (next) => {
          setSafetyStatus(next);
          rememberBackupStatus(systemBackupSafetyExportCheckpointKey, next, { relatedJobId: status.jobId });
        },
        stepDelayMs: 0,
      });
      setSafetyStatus(result);
      rememberBackupStatus(systemBackupSafetyExportCheckpointKey, result, { relatedJobId: status.jobId });
      if (result.status !== "ready") setError("Не удалось подготовить текущий страховочный снимок.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось подготовить текущий backup.");
    } finally {
      setImportBusy(false);
    }
  }

  async function applyImport() {
    if (!status || !canApplySystemBackupImport(status, safetyDownloaded, confirmation)) return;
    setImportBusy(true);
    setError("");
    try {
      const applying = await applySystemBackupImport(status);
      updateImportStatus(applying);
      const result = await runSystemBackupJob(applying, { onProgress: updateImportStatus, stepDelayMs: 0 });
      updateImportStatus(result);
      if (result.status !== "applied") {
        setError(result.phase === "verification_failed"
          ? "D1 уже заменена, но post-restore проверка не прошла. Не запускайте замену повторно вслепую."
          : "Восстановление не подтверждено сервером как завершённое.");
        return;
      }
      clearBackupStatus(systemBackupImportCheckpointKey);
      clearBackupStatus(systemBackupSafetyExportCheckpointKey);
      onApplied(result);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось завершить восстановление.");
    } finally {
      setImportBusy(false);
    }
  }

  function chooseAnotherFile() {
    clearBackupStatus(systemBackupImportCheckpointKey);
    clearBackupStatus(systemBackupSafetyExportCheckpointKey);
    setStatus(null);
    setSafetyStatus(null);
    setSafetyDownloaded(false);
    setConfirmation("");
    setFile(null);
    setError("");
  }

  const validated = backupImportIsFullyValidated(status);
  const committedVerificationFailure = status?.phase === "verification_failed";
  const safetyUrl = safeSystemBackupDownloadUrl(safetyStatus?.downloadUrl ?? null);
  return <Modal onClose={() => !busy && onClose()} className="system-import-modal">
    <DialogHeader title="Импорт полного состояния" icon={<Upload size={17} />} onClose={() => !busy && onClose()} />
    {!validated ? <form onSubmit={validateFile}>
      <div className="system-import-body">
        <p>{committedVerificationFailure
          ? "Атомарная замена D1 уже выполнена, но post-restore проверка обнаружила расхождение. Повторный apply не выполняйте до разбора причины."
          : "Импорт полностью заменит состояние всех пользователей. До завершения проверки сервер не меняет рабочие таблицы и файлы."}</p>
        {status && <SystemBackupProgress status={status} />}
        {status?.status === "uploading" && !file && <div className="system-backup-resume"><RotateCw size={14} /><span>Незавершённая загрузка найдена. Выберите тот же файл — уже принятые части повторно не отправятся.</span></div>}
        {!committedVerificationFailure && <label className="system-import-file">
          <span>Файл полного backup</span>
          <input
            type="file"
            accept={`.tmbak,${systemBackupMediaType}`}
            required
            disabled={busy}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setError("");
            }}
          />
          <small>Файл читается построчно; общий размер не ограничен 10 МБ.</small>
        </label>}
        {status && (status.validationErrors.length > 0 || status.warnings.length > 0 || status.error) && <SystemBackupPreview status={status} />}
        {error && <p className="system-import-error" role="alert">{error}</p>}
      </div>
      <div className="dialog-footer system-backup-footer">
        <span>{committedVerificationFailure
          ? "D1 replace уже committed; сохраните diagnostics ошибки проверки"
          : "Повреждённый или неполный файл не меняет live state"}</span>
        <div>
          {committedVerificationFailure
            ? <button className="button primary" type="button" onClick={onClose}>Закрыть</button>
            : <>
                {status && (status.status === "uploading" || status.status === "failed" || status.status === "expired") && <button className="button ghost" type="button" disabled={busy} onClick={chooseAnotherFile}>Сбросить загрузку</button>}
                <button className="button primary" disabled={!file || busy}>{busy ? "Проверяем…" : status?.status === "uploading" ? "Продолжить проверку" : "Загрузить и проверить"}</button>
              </>}
        </div>
      </div>
    </form> : <div>
      <div className="system-import-body">
        {status && <SystemBackupPreview status={status} />}
        <div className="system-import-warning">
          <b>Следующий шаг заменит всё рабочее состояние.</b>
          <span>Сначала создайте и скачайте новый снимок текущего Site. Замена выполняется целиком; частичного восстановления нет.</span>
        </div>
        {!safetyStatus && <button className="button secondary system-import-download" type="button" disabled={busy} onClick={() => void createSafetyBackup()}><Database size={14} />Создать текущий backup</button>}
        {safetyStatus && <SystemBackupProgress status={safetyStatus} />}
        {safetyUrl && <a className={`button secondary system-import-download ${safetyDownloaded ? "confirmed" : ""}`} href={safetyUrl} download onClick={() => setSafetyDownloaded(true)}>{safetyDownloaded ? <Check size={14} /> : <Download size={14} />}{safetyDownloaded ? "Скачивание текущего backup запущено" : "Скачать текущий backup"}</a>}
        <label className="system-import-confirmation">
          <span>Введите <b>RESTORE</b>, чтобы заменить состояние</span>
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} disabled={busy} />
        </label>
        {error && <p className="system-import-error" role="alert">{error}</p>}
      </div>
      <div className="dialog-footer system-backup-footer">
        <button className="button ghost" type="button" disabled={busy} onClick={chooseAnotherFile}>Другой файл</button>
        <button className="button primary system-import-apply" type="button" disabled={busy || !canApplySystemBackupImport(status, safetyDownloaded, confirmation)} onClick={() => void applyImport()}>{busy ? "Восстанавливаем…" : "Заменить всё состояние"}</button>
      </div>
    </div>}
  </Modal>;
}

export function CodexSetupDialog({ onClose, initialMode = "desktop", embedded = false }: { onClose: () => void; initialMode?: CodexSetupMode; embedded?: boolean }) {
  const [mode, setMode] = useState<CodexSetupMode>(initialMode);
  const [copied, setCopied] = useState<"marketplace" | "commands" | "diagnostic" | null>(null);

  function selectCodexSetupMode(nextMode: CodexSetupMode) {
    setMode((currentMode) => nextCodexSetupMode(currentMode, { type: "select", mode: nextMode }));
    setCopied(null);
  }

  function openCodexCliFallback() {
    setMode((currentMode) => nextCodexSetupMode(currentMode, { type: "open_cli_fallback" }));
    setCopied(null);
  }

  async function copySetup(value: string, target: "marketplace" | "commands" | "diagnostic") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
    } catch {
      setCopied(null);
    }
  }

  const body = <>
      {!embedded && <DialogHeader title="Connect Task Manager to Codex" icon={<CircleHelp size={17} />} onClose={onClose} />}
      <div className="codex-setup-body">
        <aside className="codex-mobile-handoff">
          <b>Installing from a phone?</b>
          <span>Continue on ChatGPT/Codex Desktop or with Codex CLI. Mobile ChatGPT can use Task Manager after the plugin is installed on the same account.</span>
        </aside>
        <p className="codex-setup-intro">
          Adding the marketplace, installing the plugin, and connecting your Task Manager account are separate checkpoints. Complete each success check before continuing.
        </p>
        <div className="codex-setup-tabs" role="tablist" aria-label="Codex client">
          <button
            id="codex-setup-tab-desktop"
            type="button"
            role="tab"
            aria-selected={mode === "desktop"}
            aria-controls="codex-setup-desktop"
            className={mode === "desktop" ? "active" : ""}
            onClick={() => selectCodexSetupMode("desktop")}
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
            onClick={() => selectCodexSetupMode("cli")}
          >
            Codex CLI
          </button>
        </div>

        {mode === "desktop" ? (
          <section id="codex-setup-desktop" role="tabpanel" aria-labelledby="codex-setup-tab-desktop">
            <ol className="codex-setup-steps">
              <SetupStep
                number={1}
                title="Add Srez Marketplace"
                location="Codex Desktop · Plugins"
                success="Srez Marketplace is visible under Personal."
              >
                Open <b>Plugins → Add → Add a marketplace</b>, then paste this address into <b>Source</b>:
                <SetupCopyBlock
                  value={TASK_MANAGER_MARKETPLACE_URL}
                  label="Copy marketplace address"
                  copied={copied === "marketplace"}
                  onCopy={() => void copySetup(TASK_MANAGER_MARKETPLACE_URL, "marketplace")}
                />
                Leave <b>Git ref</b> and <b>Sparse paths</b> empty, then choose <b>Add marketplace</b>.
              </SetupStep>
              <SetupStep
                number={2}
                title="Install Task Manager plugin"
                location="Codex Desktop · Plugins → Personal"
                success="Task Manager appears under Installed."
              >
                <b>Personal</b> contains personal marketplaces. Open <b>Srez Marketplace → Task Manager</b>, then choose <b>Install</b> once.
              </SetupStep>
              <SetupStep
                number={3}
                title="Authenticate / Connect Task Manager account"
                location="Codex Desktop + browser"
                success="Task Manager consent completes; return to Codex for the Installed check."
              >
                Choose <b>Authenticate</b> or <b>Connect</b>. In the browser, confirm you are signed in to the same ChatGPT account and workspace as Desktop. On the Task Manager consent page, check the account and choose <b>Connect</b>.
              </SetupStep>
              <SetupStep
                number={4}
                title="Return to Codex and open Installed"
                location="Codex Desktop · Plugins → Installed"
                success="Installed shows Task Manager present and enabled."
              >
                Return to Desktop yourself if the browser remains open. <b>Installed</b> is where already installed plugins are checked; confirm <b>Task Manager</b> is present and enabled there.
              </SetupStep>
              <SetupStep
                number={5}
                title="Start a new task and run smoke"
                location="Codex Desktop · New task"
                success="Codex returns your Task Manager task summaries without making a write."
              >
                Start a <b>New task</b> so Codex loads the new plugin snapshot, then ask: <q>Show my tasks in Task Manager.</q> A successful response proves the account connection. Do not start a bulk migration or write flow before this read check passes.
              </SetupStep>
            </ol>

            <details className="codex-setup-troubleshooting">
              <summary>Redirected to web ChatGPT, but Task Manager is not installed?</summary>
              <div>
                <p><b>Stop after one failed Install attempt.</b> Repeated clicks do not add diagnostic information.</p>
                <ol>
                  <li>Confirm the browser and Desktop use the same ChatGPT account and workspace.</li>
                  <li>Back in Desktop, check <b>Plugins → Personal</b> for Srez Marketplace and <b>Plugins → Installed</b> for Task Manager.</li>
                  <li>Restart Desktop once, then check <b>Personal</b> and <b>Installed</b> again.</li>
                  <li>Use the Codex CLI fallback below if the plugin is still missing.</li>
                </ol>
                <button className="button secondary codex-cli-fallback" type="button" onClick={openCodexCliFallback}>
                  Open CLI fallback
                </button>
                <p>If it still fails, give an agent this bounded diagnostic prompt:</p>
                <SetupCopyBlock
                  value={TASK_MANAGER_DIAGNOSTIC_PROMPT}
                  label="Copy diagnostic prompt"
                  copied={copied === "diagnostic"}
                  multiline
                  onCopy={() => void copySetup(TASK_MANAGER_DIAGNOSTIC_PROMPT, "diagnostic")}
                />
                <p className="codex-install-bug-boundary">These checks do not fix the platform install redirect bug. They identify the failed stage and produce a reproducible report without exposing credentials.</p>
              </div>
            </details>
          </section>
        ) : (
          <section id="codex-setup-cli" role="tabpanel" aria-labelledby="codex-setup-tab-cli">
            <p className="codex-cli-copy-intro">Copy the complete fallback sequence, then verify each stage below:</p>
            <SetupCopyBlock
              value={TASK_MANAGER_CLI_SETUP}
              label="Copy CLI commands"
              copied={copied === "commands"}
              multiline
              onCopy={() => void copySetup(TASK_MANAGER_CLI_SETUP, "commands")}
            />
            <ol className="codex-setup-steps">
              <SetupStep
                number={1}
                title="Add Srez Marketplace"
                location="Terminal"
                success="codex plugin marketplace list includes Srez Marketplace."
              >
                Run <code>codex plugin marketplace add xxsrez/marketplace</code>.
              </SetupStep>
              <SetupStep
                number={2}
                title="Install Task Manager plugin"
                location="Terminal"
                success="codex plugin list includes task-manager@srez-marketplace."
              >
                Run <code>codex plugin add task-manager@srez-marketplace</code>.
              </SetupStep>
              <SetupStep
                number={3}
                title="Authenticate / Connect Task Manager account"
                location="Codex CLI + browser"
                success="Task Manager no longer shows an Authenticate action."
              >
                Run <code>codex</code>, then open <code>/plugins → Task Manager → Authenticate</code>. In the browser, use the same ChatGPT account/workspace, check the Task Manager consent, and choose <b>Connect</b>.
              </SetupStep>
              <SetupStep
                number={4}
                title="Return to Codex and start a new task"
                location="Codex CLI"
                success="A fresh task opens with the installed plugin snapshot."
              >
                Return to Codex and enter <code>/new</code>.
              </SetupStep>
              <SetupStep
                number={5}
                title="Run the read smoke"
                location="Fresh Codex task"
                success="Codex returns Task Manager task summaries without making a write."
              >
                Ask: <q>Show my tasks in Task Manager.</q> Only after this passes should you consider creating one test Task; do not begin with a bulk migration.
              </SetupStep>
            </ol>
          </section>
        )}

        <p className="codex-setup-note">
          Developer mode, a manual MCP URL, client ID, secret, and personal API token are not required for normal setup.
        </p>
      </div>
    </>;
  return embedded
    ? <section className="settings-integration" aria-label="Connect Task Manager to Codex">{body}</section>
    : <Modal onClose={onClose} className="codex-setup-modal" ariaLabel="Connect Task Manager to Codex">{body}</Modal>;
}

function SetupStep({ number, title, location, success, children }: { number: number; title: string; location: string; success: string; children: React.ReactNode }) {
  return <li data-setup-stage={number}><span className="codex-step-number">{number}</span><div><strong>{title}</strong><span className="codex-step-location">{location}</span><div className="codex-step-content">{children}</div><p className="codex-step-success"><Check size={13} aria-hidden="true" /> <span><b>Success:</b> {success}</span></p></div></li>;
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

function DialogHeader({ title, icon, onClose, className = "" }: { title: string; icon: React.ReactNode; onClose: () => void; className?: string }) { return <div className={`dialog-header ${className}`}><div>{icon}<h2>{title}</h2></div><button type="button" className="icon-button" aria-label={`Close ${title}`} onClick={onClose}><X size={15} /></button></div>; }
function DialogFooter({ busy, label, disabled }: { busy: boolean; label: string; disabled?: boolean }) { return <div className="dialog-footer"><span>Press Esc to close</span><button className="button primary" disabled={busy || disabled}>{busy ? "Saving…" : label}</button></div>; }
const FOCUSABLE_SELECTOR = "button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])";
function trapFocus(event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">, container: HTMLElement | null) {
  if (event.key !== "Tab" || !container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
function Modal({ onClose, children, className = "", ariaLabel }: { onClose: () => void; children: React.ReactNode; className?: string; ariaLabel?: string }) {
  const modalRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const handleKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    trapFocus(event, modalRef.current);
  };
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const modal = modalRef.current;
    const frame = window.requestAnimationFrame(() => {
      if (!modal || modal.contains(document.activeElement)) return;
      modal.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  // The focus-trapped dialog intentionally owns Escape after nested controls have handled it.
  // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div ref={modalRef} className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={ariaLabel} tabIndex={-1} onKeyDown={handleKey}>{children}</div></div>;
}

const globalSearchSections: Array<{
  key: keyof GlobalSearchResponse["groups"];
  type: GlobalSearchEntityType;
  label: string;
}> = [
  { key: "tasks", type: "task", label: "Tasks" },
  { key: "projects", type: "project", label: "Projects" },
  { key: "releases", type: "release", label: "Releases" },
  { key: "views", type: "view", label: "Views" },
];

function GlobalSearchResultIcon({ type }: { type: GlobalSearchEntityType }) {
  if (type === "task") return <CircleDot size={15} />;
  if (type === "project") return <FolderKanban size={15} />;
  if (type === "release") return <Rocket size={15} />;
  return <Zap size={15} />;
}

export function resolveGlobalSearchNavigation(
  result: GlobalSearchResult,
  data: Pick<AppSnapshot, "projects" | "releases" | "views">,
  current: ResolvedNavigation,
): ResolvedNavigation | null {
  if (result.type === "task") {
    return { ...current, taskId: result.id };
  }
  if (result.type === "project") {
    return data.projects.some((project) => project.id === result.id)
      ? { surface: `project:${result.id}`, layout: "list", taskId: null }
      : null;
  }
  if (result.type === "release") {
    return data.releases.some((release) => release.id === result.id)
      ? { surface: `release:${result.id}`, layout: "list", taskId: null }
      : null;
  }
  const view = data.views.find((item) => item.id === result.id && !item.archivedAt);
  return view
    ? { surface: `view:${view.id}`, layout: view.display.layout, taskId: null }
    : null;
}

export function GlobalSearchContinuationWarning({
  busy,
  onRetry,
}: {
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="global-search-partial continuation" role="alert">
      <span>Couldn’t load more results. Loaded matches are still available.</span>
      <button className="button ghost" type="button" disabled={busy} onClick={onRetry}>
        {busy ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

export function GlobalSearchOverlay({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: (result: GlobalSearchResult) => void;
}) {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<GlobalSearchResponse>(() => emptyGlobalSearchResponse());
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [loadingMore, setLoadingMore] = useState(false);
  const [continuationError, setContinuationError] = useState<{
    query: string;
    cursor: string;
  } | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef("");
  const results = flattenGlobalSearchResults(response);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      // A blank overlay is a prompt, not a request for an unbounded suggestion set.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResponse(emptyGlobalSearchResponse());
      setStatus("idle");
      setContinuationError(null);
      setHighlighted(0);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setStatus("loading");
      void fetch(`/api/search?query=${encodeURIComponent(trimmed)}&limit=8`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(async (searchResponse) => {
        const value = await searchResponse.json() as GlobalSearchResponse | { error?: string };
        if (!searchResponse.ok || !("groups" in value)) {
          throw new Error("Workspace search is temporarily unavailable");
        }
        setResponse(value);
        setStatus(value.partialErrors.length === globalSearchSections.length ? "error" : "ready");
        setContinuationError(null);
        setHighlighted(0);
      }).catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setResponse(emptyGlobalSearchResponse(trimmed));
        setStatus("error");
        setContinuationError(null);
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  async function loadMore(cursor = response.nextCursor) {
    if (!cursor || loadingMore) return;
    const requestedQuery = response.query;
    const requestedCursor = cursor;
    setContinuationError(null);
    setLoadingMore(true);
    try {
      const next = await fetch(
        `/api/search?query=${encodeURIComponent(requestedQuery)}&limit=8&cursor=${encodeURIComponent(requestedCursor)}`,
        { cache: "no-store" },
      );
      const value = await next.json() as GlobalSearchResponse | { error?: string };
      if (!next.ok || !("groups" in value)) throw new Error("Search continuation failed");
      if (queryRef.current === requestedQuery) {
        setResponse((current) => current.query === requestedQuery
          ? mergeGlobalSearchResponses(current, value)
          : current);
        setContinuationError(null);
      }
    } catch {
      if (queryRef.current === requestedQuery) {
        setContinuationError({ query: requestedQuery, cursor: requestedCursor });
      }
    } finally {
      setLoadingMore(false);
    }
  }

  function handleKey(event: ReactKeyboardEvent<HTMLDialogElement>) {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((current) => nextGlobalSearchHighlight(current, "next", results.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((current) => nextGlobalSearchHighlight(current, "previous", results.length));
      return;
    }
    if (event.key === "Enter" && results[highlighted]) {
      event.preventDefault();
      onOpen(results[highlighted]);
      return;
    }
    if (event.key === "Tab") {
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'input, a[href], button:not([disabled])',
      ) ?? [])];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  let resultIndex = -1;
  return (
    <div className="global-search-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <dialog ref={dialogRef} className="global-search-dialog" aria-modal="true" aria-label="Global search" open onKeyDown={handleKey}>
        <header className="global-search-input-row">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              setQuery(nextQuery);
              queryRef.current = nextQuery.trim().toLowerCase();
              setResponse(emptyGlobalSearchResponse(queryRef.current));
              setStatus(nextQuery.trim() ? "loading" : "idle");
              setContinuationError(null);
              setHighlighted(0);
            }}
            placeholder="Search tasks, projects, releases, and views…"
            aria-label="Global search query"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="global-search-results"
            aria-activedescendant={results[highlighted] ? `global-search-result-${results[highlighted].type}-${results[highlighted].id}` : undefined}
            autoComplete="off"
          />
          {query && <button className="icon-button" type="button" aria-label="Clear global search" onClick={() => setQuery("")}><X size={15} /></button>}
          <kbd>Esc</kbd>
        </header>
        <div className="global-search-results" id="global-search-results" role="listbox" aria-label="Global search results">
          {status === "idle" && <div className="global-search-state"><Search size={22} /><b>Search your workspace</b><span>Tasks, Projects, Releases, and Views</span></div>}
          {status === "loading" && <div className="global-search-state" aria-live="polite"><span className="global-search-spinner" /><b>Searching…</b></div>}
          {status === "error" && <div className="global-search-state" role="alert"><CircleHelp size={22} /><b>Search is temporarily unavailable</b><span>Try again without changing your current view.</span></div>}
          {status === "ready" && results.length === 0 && <div className="global-search-state"><Search size={22} /><b>No accessible results</b><span>Try another title or Task identifier.</span></div>}
          {status === "ready" && response.partialErrors.length > 0 && <p className="global-search-partial" role="status">Some results could not be loaded. Available matches are shown below.</p>}
          {status === "ready" && continuationError?.query === response.query && (
            <GlobalSearchContinuationWarning
              busy={loadingMore}
              onRetry={() => void loadMore(continuationError.cursor)}
            />
          )}
          {status === "ready" && globalSearchSections.map((section) => {
            const items = response.groups[section.key] as GlobalSearchResult[];
            if (!items.length) return null;
            return (
              <section className="global-search-group" role="group" aria-label={section.label} key={section.key}>
                <h2>{section.label}</h2>
                {items.map((item) => {
                  resultIndex += 1;
                  const index = resultIndex;
                  return (
                    <a
                      id={`global-search-result-${item.type}-${item.id}`}
                      key={`${item.type}:${item.id}`}
                      className={`global-search-result ${index === highlighted ? "highlighted" : ""}`}
                      href={item.href}
                      role="option"
                      aria-selected={index === highlighted}
                      onMouseEnter={() => setHighlighted(index)}
                      onClick={(event) => handleLocalLink(event, () => onOpen(item))}
                    >
                      <span className="global-search-result-icon"><GlobalSearchResultIcon type={item.type} /></span>
                      <span className="global-search-result-copy">
                        <b>{item.type === "task" ? <><code>{item.identifier}</code><span>{item.title}</span></> : item.title}</b>
                        <small>{item.context}</small>
                      </span>
                      <kbd>↵</kbd>
                    </a>
                  );
                })}
              </section>
            );
          })}
        </div>
        <footer className="global-search-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          {response.nextCursor && <button className="button ghost" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</button>}
          <span><kbd>↵</kbd> Open</span>
        </footer>
      </dialog>
    </div>
  );
}

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
  const activeCount = data.workspaceMetrics?.taskCounts.active ?? openTasks.filter((task) => {
    const category = statusMap.get(task.statusId)?.category;
    return category === "unstarted" || category === "started";
  }).length;
  const backlogCount = data.workspaceMetrics?.taskCounts.backlog ?? openTasks.filter(
    (task) => statusMap.get(task.statusId)?.category === "backlog",
  ).length;
  const recentTasks = [...openTasks]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 5);
  const recentProjects = selectRecentNavigation(
    data.navigationCollections?.projects.items ?? data.projects,
  );
  const recentReleases = selectRecentNavigation(
    data.navigationCollections?.releases.items ?? data.releases,
  );
  const recentViews = selectRecentNavigation(
    data.navigationCollections?.views.items ?? data.views,
  );
  const { projects: sharedProjects, views: sharedViews } = sharedWithMeRoots(data);
  const sharedCount = sharedProjects.length + sharedViews.length;
  const isEmpty =
    openTasks.length === 0 &&
    (data.navigationCollections?.projects.total ?? data.projects.length) === 0 &&
    (data.navigationCollections?.releases.total ?? data.releases.length) === 0 &&
    (data.navigationCollections?.views.total ?? data.views.length) === 0;
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
          label="My tasks"
          onOpen={() => onOpen("mine")}
        />
        <div className="workspace-metrics">
          <WorkspaceMetric href="/issues/active" label="Active" value={activeCount} icon={<Zap size={16} />} onOpen={() => onOpen("active")} />
          <WorkspaceMetric href="/issues/backlog" label="Backlog" value={backlogCount} icon={<Inbox size={16} />} onOpen={() => onOpen("backlog")} />
          <WorkspaceMetric href="/projects" label="Projects" value={data.navigationCollections?.projects.total ?? data.projects.length} icon={<FolderKanban size={16} />} onOpen={() => onOpen("projects")} />
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
              <WorkspaceSharedCount label="Tasks" value={0} />
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

function SharedWithMeSurface({ data, tasks, statuses, users, onOpenProject, onOpenView, onProjectContextActions }: {
  data: AppSnapshot;
  tasks: TaskRecord[];
  statuses: WorkflowStatusRecord[];
  users: Map<string, UserRecord>;
  onOpenProject: (id: string) => void;
  onOpenView: (view: SavedViewRecord) => void;
  onProjectContextActions: (project: ProjectRecord, x: number, y: number, restoreFocus: HTMLElement | null) => void;
}) {
  const roots = sharedWithMeRoots(data);
  if (!roots.projects.length && !roots.views.length) {
    return <div className="empty-state"><UsersRound size={22} /><h2>Nothing shared yet</h2><p>Projects and global Saved Views granted directly to you will appear here.</p></div>;
  }
  return (
    <div className="shared-roots-surface">
      {roots.projects.length > 0 && (
        <section aria-labelledby="shared-project-roots">
          <header className="shared-roots-heading"><h2 id="shared-project-roots">Projects</h2><p>Project grants include their Tasks, Releases, and project views.</p></header>
          <ProjectsSurface
            projects={roots.projects}
            tasks={tasks}
            statuses={statuses}
            users={users}
            onOpen={onOpenProject}
            onContextActions={onProjectContextActions}
            onCreate={() => undefined}
          />
        </section>
      )}
      {roots.views.length > 0 && (
        <section aria-labelledby="shared-view-roots">
          <header className="shared-roots-heading"><h2 id="shared-view-roots">Global Saved Views</h2><p>Direct view grants never expand access to underlying Tasks.</p></header>
          <div className="entity-grid shared-view-grid">
            {roots.views.map((view) => (
              <a
                className="entity-card"
                key={view.id}
                href={navigationPath({ surface: `view:${view.id}`, layout: view.display.layout, taskId: null }, data)}
                onClick={(event) => handleLocalLink(event, () => onOpenView(view))}
              >
                <div className="entity-icon"><Zap size={18} /></div>
                <div className="entity-card-copy">
                  <div><h2>{view.name}</h2><span className="status-badge">{view.accessRole}</span></div>
                  <p>Global view · {view.display.layout}</p>
                </div>
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ViewsSurface({ data, statusMap, onOpen, onContextActions, onRestore, busy }: { data: AppSnapshot; statusMap: Map<string, WorkflowStatusRecord>; onOpen: (surface: string, layout: Layout) => void; onContextActions: (view: SavedViewRecord, x: number, y: number, restoreFocus: HTMLElement | null) => void; onRestore: (view: SavedViewRecord) => Promise<boolean>; busy: boolean }) {
  const activeViews = data.views.filter((view) => !view.archivedAt);
  const archivedViews = data.views.filter((view) => Boolean(view.archivedAt));
  return <div className="views-collection">
    <div className="entity-grid">
      {builtInViews.map((view) => <a className="entity-card" key={view.id} href={navigationPath({ surface: view.id, layout: "list", taskId: null }, data)} onClick={(event) => handleLocalLink(event, () => onOpen(view.id, "list"))}><div className="entity-icon"><Inbox size={18} /></div><div className="entity-card-copy"><div><h2>{view.label}</h2><span className="status-badge">Built-in</span></div><p>Workspace issue view</p><div className="progress-meta"><span>{taskCountForView(view.id, data, statusMap)} issues</span><span>List or board</span></div></div></a>)}
      {activeViews.map((view) => {
        const editable = canEditContent(view.accessRole);
        return <div className="entity-card-shell" key={view.id}>
          <a
            className="entity-card"
            data-context-entity-kind="saved_view"
            data-context-entity-id={view.id}
            href={navigationPath({ surface: `view:${view.id}`, layout: view.display.layout, taskId: null }, data)}
            onContextMenu={editable ? (event) => { event.preventDefault(); onContextActions(view, event.clientX, event.clientY, event.currentTarget); } : undefined}
            onClick={(event) => handleLocalLink(event, () => onOpen(`view:${view.id}`, view.display.layout))}
          ><div className="entity-icon"><Zap size={18} /></div><div className="entity-card-copy"><div><h2>{view.name}</h2><span className="status-badge">Saved</span></div><p>{view.scopeProjectId ? "Project-scoped query" : "Workspace query"}</p><div className="progress-meta"><span>{view.display.layout}</span><span>Grouped by {view.display.groupBy}</span></div></div></a>
          {editable && <button className="entity-card-action" type="button" aria-label={`Open actions for ${view.name}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onContextActions(view, rect.right, rect.bottom, event.currentTarget); }}><MoreHorizontal size={16} /></button>}
        </div>;
      })}
    </div>
    {archivedViews.length > 0 && <section className="archived-view-section"><h2>Archived views</h2><div className="entity-grid">{archivedViews.map((view) => <article className="entity-card archived" key={view.id}><div className="entity-icon"><Archive size={18} /></div><div className="entity-card-copy"><div><h2>{view.name}</h2><span className="status-badge">Archived</span></div><p>Unavailable in navigation and direct routes.</p><div className="progress-meta"><span>{view.display.layout}</span>{canEditContent(view.accessRole) && <button className="button ghost compact" type="button" disabled={busy} onClick={() => void onRestore(view)}><ArchiveRestore size={13} />Restore legacy archived view</button>}</div></div></article>)}</div></section>}
  </div>;
}
const projectStatusOptions: ProjectStatus[] = ["planned", "active", "paused", "completed", "canceled"];

function projectStatusLabel(status: ProjectStatus | ReleaseStatus) {
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

function releasedCompositionNeedsConfirmation(
  currentReleaseId: string | null,
  nextReleaseId: string | null,
  releases: ReleaseRecord[],
) {
  if (currentReleaseId === nextReleaseId) return false;
  return releases.some(
    (release) =>
      (release.id === currentReleaseId || release.id === nextReleaseId)
      && release.status === "released",
  );
}

function confirmReleasedCompositionChange() {
  return window.confirm(
    "This changes the Task composition of a released Release. Continue?",
  );
}

function ProjectIcon({ project, size = 18 }: { project?: Pick<ProjectRecord, "icon" | "color">; size?: number }) {
  if (project?.icon === "rocket") return <Rocket size={size} />;
  if (project?.icon === "target") return <CircleDot size={size} />;
  if (project?.icon === "folder") return <FolderKanban size={size} />;
  return <Boxes size={size} />;
}

function openProjectTaskCount(projectId: string, tasks: TaskRecord[], statuses: Map<string, WorkflowStatusRecord>) {
  return tasks.filter((task) => {
    if (task.projectId !== projectId || task.archivedAt) return false;
    const category = statuses.get(task.statusId)?.category;
    return category !== "completed" && category !== "canceled";
  }).length;
}

function openReleaseTaskCount(releaseId: string, tasks: TaskRecord[], statuses: Map<string, WorkflowStatusRecord>) {
  return tasks.filter((task) => {
    if (task.releaseId !== releaseId || task.archivedAt) return false;
    const category = statuses.get(task.statusId)?.category;
    return category !== "completed" && category !== "canceled";
  }).length;
}

function projectMemberOptions(data: AppSnapshot, project: ProjectRecord): UserRecord[] {
  const ids = new Set<string>([project.ownerUserId]);
  for (const collaborator of data.collaborators) {
    if (collaborator.resourceType === "project" && collaborator.resourceId === project.id) {
      ids.add(collaborator.userId);
    }
  }
  return data.users.filter((user) => ids.has(user.id));
}

export function ProjectOverview({ project, lead, tasks, statuses, onEdit }: { project: ProjectRecord; lead?: UserRecord; tasks: TaskRecord[]; statuses: Map<string, WorkflowStatusRecord>; onEdit?: () => void }) {
  const progress = completion(tasks, [...statuses.values()]);
  const openTasks = openProjectTaskCount(project.id, tasks, statuses);
  return <section className={`project-overview ${project.archivedAt ? "archived" : ""}`} aria-label={`${project.name} project summary`}><div className="project-overview-heading"><span className="project-overview-icon" style={{ background: `${project.color}20`, color: project.color }}><ProjectIcon project={project} size={20} /></span><div><span className="project-code">{project.taskCode}</span><h2>{project.name}</h2><p>{project.summary || "No summary yet"}</p></div><div className="project-overview-actions"><span className={`status-badge project-${project.status}`}>{projectStatusLabel(project.status)}</span>{project.archivedAt && <span className="status-badge">Archived</span>}{onEdit && <button className="button ghost compact" onClick={onEdit}>Edit</button>}</div></div><div className="project-overview-metadata"><span><b>{tasks.length}</b> Tasks</span><span><b>{openTasks}</b> open</span><span><b>{progress}%</b> complete</span><span><b>{lead?.displayName ?? "No lead"}</b> lead</span>{project.startDate && <span>Starts <b>{shortDate(project.startDate)}</b></span>}{project.targetDate && <span>Target <b>{shortDate(project.targetDate)}</b></span>}</div>{project.description && <MarkdownBody body={project.description} className="project-description-markdown" />}</section>;
}

export function ReleaseOverview({ release, project, tasks, statuses, onEdit }: { release: ReleaseRecord; project?: ProjectRecord; tasks: TaskRecord[]; statuses: Map<string, WorkflowStatusRecord>; onEdit?: () => void }) {
  const progress = completion(tasks, [...statuses.values()]);
  const openTasks = openReleaseTaskCount(release.id, tasks, statuses);
  const fullName = formatReleaseName(project?.name, release.name);
  return <section className="project-overview release-overview" aria-label={`${fullName} release summary`}><div className="project-overview-heading"><span className="project-overview-icon release-overview-icon"><Rocket size={20} /></span><div><span className="project-code">Release</span><h2>{fullName}</h2><p>{release.description ? "Native release scope" : "No description yet"}</p></div><div className="project-overview-actions"><span className={`status-badge release-${release.status}`}>{projectStatusLabel(release.status)}</span>{onEdit && <button className="button ghost compact" onClick={onEdit}>Edit</button>}</div></div><div className="project-overview-metadata"><span><b>{tasks.length}</b> Tasks</span><span><b>{openTasks}</b> open</span><span><b>{progress}%</b> complete</span>{release.targetDate && <span>Target <b>{shortDate(release.targetDate)}</b></span>}{release.releasedAt && <span>Released <b>{shortDate(release.releasedAt.slice(0, 10))}</b></span>}</div>{release.description && <MarkdownBody body={release.description} className="project-description-markdown" />}{release.releaseNotes && <section className="release-notes"><h3>Release notes</h3><MarkdownBody body={release.releaseNotes} className="project-description-markdown" /></section>}</section>;
}

function ProjectsSurface({ projects, tasks, statuses, users, onOpen, onContextActions, onCreate }: { projects: ProjectRecord[]; tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; users: Map<string, UserRecord>; onOpen: (id: string) => void; onContextActions: (project: ProjectRecord, x: number, y: number, restoreFocus: HTMLElement | null) => void; onCreate: () => void }) {
  if (!projects.length) return <EmptyState entity="project" onCreate={onCreate} />;
  return <div className="entity-grid">{projects.map((project) => {
    const scoped = tasks.filter((task) => task.projectId === project.id && !task.archivedAt);
    const progress = completion(scoped, statuses);
    const lead = project.leadUserId ? users.get(project.leadUserId) : undefined;
    const editable = canEditContent(project.accessRole);
    return <div className="entity-card-shell" key={project.id}>
      <a
        className={`entity-card ${project.archivedAt ? "archived" : ""}`}
        data-context-entity-kind="project"
        data-context-entity-id={project.id}
        href={`/projects/${encodeURIComponent(project.publicId)}`}
        onContextMenu={editable ? (event) => { event.preventDefault(); onContextActions(project, event.clientX, event.clientY, event.currentTarget); } : undefined}
        onClick={(event) => handleLocalLink(event, () => onOpen(project.id))}
      ><div className="entity-icon" style={{ background: `${project.color}20`, color: project.color }}><ProjectIcon project={project} /></div><div className="entity-card-copy"><div><h2>{project.name}</h2><span className="status-badge">{project.archivedAt ? "archived" : project.status}</span></div><p>{project.summary || "No summary yet"}</p><div className="project-card-meta"><span>{lead ? `${lead.displayName} · Lead` : "No lead"}</span><span>{project.startDate ? `Start ${shortDate(project.startDate)}` : "No start"}</span><span>{project.targetDate ? `Target ${shortDate(project.targetDate)}` : "No target"}</span></div><div className="progress-meta"><span>{scoped.length} tasks</span><span>{progress}% complete</span></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div></div></a>
      {editable && <button className="entity-card-action" type="button" aria-label={`Open actions for ${project.name}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onContextActions(project, rect.right, rect.bottom, event.currentTarget); }}><MoreHorizontal size={16} /></button>}
    </div>;
  })}</div>;
}

function ReleasesSurface({ releases, projects, tasks, statuses, onOpen, onContextActions, onCreate }: { releases: ReleaseRecord[]; projects: Map<string, ProjectRecord>; tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; onOpen: (id: string) => void; onContextActions: (release: ReleaseRecord, x: number, y: number, restoreFocus: HTMLElement | null) => void; onCreate: () => void }) {
  if (!releases.length) return <EmptyState entity="release" onCreate={onCreate} />;
  return <div className="release-list">{releases.map((release) => {
    const scoped = tasks.filter((task) => task.releaseId === release.id && !task.archivedAt);
    const progress = completion(scoped, statuses);
    const project = projects.get(release.projectId);
    const releaseName = formatReleaseName(project?.name, release.name);
    const editable = canEditContent(release.accessRole);
    return <div className="release-row-shell" key={release.id}>
      <a
        className="release-row"
        data-context-entity-kind="release"
        data-context-entity-id={release.id}
        aria-label={releaseName}
        title={releaseName}
        href={project ? `/projects/${encodeURIComponent(project.publicId)}/releases/${encodeURIComponent(release.publicId)}` : "/releases"}
        onContextMenu={editable ? (event) => { event.preventDefault(); onContextActions(release, event.clientX, event.clientY, event.currentTarget); } : undefined}
        onClick={(event) => handleLocalLink(event, () => onOpen(release.id))}
      ><span className="release-icon"><Rocket size={16} /></span><span className="release-main"><b>{releaseName}</b><small>{scoped.length} Task{scoped.length === 1 ? "" : "s"}</small></span><span className={`status-badge release-${release.status}`}>{release.status}</span><span className="release-progress"><i><em style={{ width: `${progress}%` }} /></i><small>{progress}%</small></span><span className="release-date">{release.releasedAt ? `Released ${shortDate(release.releasedAt.slice(0, 10))}` : release.targetDate ? `Target ${shortDate(release.targetDate)}` : "No date"}</span></a>
      {editable && <button className="release-row-action" type="button" aria-label={`Open actions for ${releaseName}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onContextActions(release, rect.right, rect.bottom, event.currentTarget); }}><MoreHorizontal size={16} /></button>}
    </div>;
  })}</div>;
}
function AdminSurface({ overview, timeZone, backupBusy, exportActive, onExport, onImport }: {
  overview: AdminOverview;
  timeZone: string;
  backupBusy: boolean;
  exportActive: boolean;
  onExport: () => void;
  onImport: () => void;
}) {
  return (
    <div className="admin-surface">
      <section className="admin-metrics" aria-label="System overview">
        <AdminMetric label="Registered users" value={overview.registeredUserCount} note="All accounts" icon={<UsersRound size={16} />} />
        <AdminMetric label="Active users" value={overview.activeUserCount} note="Last 7 days" icon={<Zap size={16} />} />
        <AdminMetric label="Tasks" value={overview.taskCount} note={`${overview.projectCount} projects`} icon={<Inbox size={16} />} />
        <AdminMetric label="Saved views" value={overview.viewCount} note={`${overview.releaseCount} releases`} icon={<Boxes size={16} />} />
        <AdminMetric label="Attachment objects" value={overview.attachmentObjectCount} note={`${formatAttachmentBytes(overview.attachmentObjectBytes)} · ${overview.orphanAttachmentObjectCount === null ? "orphan scan bounded" : `${overview.orphanAttachmentObjectCount} orphan`} · ${overview.stagingAttachmentObjectCount} staged · ${overview.pendingAttachmentCount} pending · ${overview.failedAttachmentCount} failed`} icon={<Paperclip size={16} />} />
      </section>
      <section className="admin-panel admin-backup-panel" aria-labelledby="admin-backup-heading">
        <header>
          <div>
            <h2 id="admin-backup-heading">Резервное копирование и восстановление</h2>
            <p>Полная резервная копия содержит данные всех пользователей, идентификаторы и права доступа. Храните файл <code>.tmbak</code> как секрет; восстановление полностью заменяет текущее состояние.</p>
          </div>
          <span className="status-badge admin-badge">Только администратор</span>
        </header>
        <div className="admin-backup-actions">
          <article>
            <span className="admin-backup-icon"><Download size={17} /></span>
            <div>
              <h3>Экспорт</h3>
              <p>Создать переносимый снимок D1 и R2 в возобновляемом формате <code>.tmbak</code>.</p>
            </div>
            <button className="button ghost" type="button" disabled={backupBusy && !exportActive} onClick={onExport}><Download size={14} />{exportActive ? "Открыть экспорт" : "Экспорт"}</button>
          </article>
          <article className="destructive">
            <span className="admin-backup-icon"><Upload size={17} /></span>
            <div>
              <h3>Полное восстановление</h3>
              <p>Проверить резервную копию и заменить все данные после отдельного подтверждения.</p>
            </div>
            <button className="button danger" type="button" disabled={backupBusy} onClick={onImport}><Upload size={14} />Импорт</button>
          </article>
        </div>
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
function TaskQueryPagination({ busy, onMore }: { busy: boolean; onMore: () => void }) { return <div className="task-query-pagination" role="status"><span>More matching tasks are available.</span><button className="button ghost" type="button" disabled={busy} onClick={onMore}>{busy ? "Loading…" : "Load more"}</button></div>; }
function CatalogPagination({ busy, onMore }: { busy: boolean; onMore: () => void }) { return <div className="task-query-pagination" role="status"><span>More records are available.</span><button className="button ghost" type="button" disabled={busy} onClick={onMore}>{busy ? "Loading…" : "Load more"}</button></div>; }
type TaskHierarchySummary = {
  parent?: TaskRecord;
  subtaskCount: number;
};
const EMPTY_TASK_HIERARCHY_SUMMARY: TaskHierarchySummary = { subtaskCount: 0 };

function wouldCreateHierarchyCycle(
  taskId: string,
  candidateParentId: string,
  tasks: ReadonlyMap<string, TaskRecord>,
): boolean {
  const visited = new Set<string>();
  let current: string | null = candidateParentId;
  while (current) {
    if (current === taskId) return true;
    if (visited.has(current)) return true;
    visited.add(current);
    current = tasks.get(current)?.parentTaskId ?? null;
  }
  return false;
}

function taskHierarchySummary(
  task: TaskRecord,
  tasks: readonly TaskRecord[],
): TaskHierarchySummary {
  return buildTaskHierarchySummaries(tasks).get(task.id)
    ?? EMPTY_TASK_HIERARCHY_SUMMARY;
}

function buildTaskHierarchySummaries(
  tasks: readonly TaskRecord[],
): Map<string, TaskHierarchySummary> {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const subtaskCounts = new Map<string, number>();
  for (const task of tasks) {
    if (!task.parentTaskId) continue;
    subtaskCounts.set(
      task.parentTaskId,
      (subtaskCounts.get(task.parentTaskId) ?? 0) + 1,
    );
  }
  return new Map(tasks.map((task) => [task.id, {
    parent: task.parentTaskId ? tasksById.get(task.parentTaskId) : undefined,
    subtaskCount: subtaskCounts.get(task.id) ?? 0,
  }]));
}

function TaskHierarchyChip({ hierarchy }: { hierarchy: TaskHierarchySummary }) {
  if (hierarchy.parent) {
    return <span className="metadata-chip hierarchy-chip" title={`Subtask of ${hierarchy.parent.identifier} · ${hierarchy.parent.title}`}><Boxes size={12} />{hierarchy.parent.identifier}</span>;
  }
  if (hierarchy.subtaskCount > 0) {
    return <span className="metadata-chip hierarchy-chip" title={`${hierarchy.subtaskCount} direct subtask${hierarchy.subtaskCount === 1 ? "" : "s"}`}><Boxes size={12} />{hierarchy.subtaskCount}</span>;
  }
  return null;
}

function Peek({ task, status, project, labels, hierarchy, onClose, onOpen }: { task: TaskRecord; status?: WorkflowStatusRecord; project?: ProjectRecord; labels: LabelRecord[]; hierarchy: TaskHierarchySummary; onClose: () => void; onOpen: () => void }) { return <div className="peek" role="dialog" aria-label={`Preview ${task.identifier}`}><header><span>{task.identifier}</span><div><a href={taskPath(task.publicId)} onClick={(event) => handleLocalLink(event, onOpen)}>Open</a><button onClick={onClose}><X size={13} /></button></div></header><h2>{task.title}</h2><p>{task.description === null ? "Loading preview…" : task.description || "No description"}</p>{labels.length > 0 && <div className="card-labels">{labels.map((label) => <LabelChip key={label.id} label={label} />)}</div>}{(hierarchy.parent || hierarchy.subtaskCount > 0) && <div className="peek-hierarchy"><TaskHierarchyChip hierarchy={hierarchy} /></div>}<footer>{status && <span><StatusIcon status={status} />{status.name}</span>}{project && <span><span className="project-dot" style={{ background: project.color }} />{project.name}</span>}<span><MessageSquare size={12} />{task.commentCount}</span></footer></div>; }

export function BulkProjectDialog({ data, tasks, busy, onClose, onSubmit, initialTargetProjectId = "" }: { data: AppSnapshot; tasks: TaskRecord[]; busy: boolean; onClose: () => void; onSubmit: (input: { targetProjectId: string; clearRelease: boolean; clearAssignee: boolean; confirmReleasedComposition: boolean }) => Promise<unknown>; initialTargetProjectId?: string }) {
  const [targetProjectId, setTargetProjectId] = useState(initialTargetProjectId);
  const [clearRelease, setClearRelease] = useState(false);
  const [clearAssignee, setClearAssignee] = useState(false);
  const [confirmReleasedComposition, setConfirmReleasedComposition] = useState(false);
  const target = data.projects.find((project) => project.id === targetProjectId);
  const moving = target ? tasks.filter((task) => task.projectId !== target.id) : [];
  const movingIds = new Set(moving.map((task) => task.id));
  const releaseChanges = moving.filter((task) => task.releaseId !== null);
  const releasedChanges = releaseChanges.filter((task) => data.releases.find((release) => release.id === task.releaseId)?.status === "released");
  const hierarchyBlocks = moving.filter((task) => task.parentTaskId || data.tasks.some((child) => child.parentTaskId === task.id));
  const archivedBlocks = moving.filter((task) => Boolean(task.archivedAt));
  const targetMembers = new Set<string>();
  if (target) {
    targetMembers.add(target.ownerUserId);
    for (const collaborator of data.collaborators) {
      if (collaborator.resourceType === "project" && collaborator.resourceId === target.id) {
        targetMembers.add(collaborator.userId);
      }
    }
  }
  const assigneeChanges = moving.filter((task) => task.assigneeUserId && !targetMembers.has(task.assigneeUserId));
  const expectedStart = target ? target.taskSequence + 1 : 0;
  const eligibleProjects = data.projects.filter((project) =>
    !project.archivedAt && project.status !== "canceled" && canEditContent(project.accessRole)
  );
  const canSubmit = Boolean(target && movingIds.size > 0 && !hierarchyBlocks.length && !archivedBlocks.length) &&
    (!releaseChanges.length || clearRelease) &&
    (!assigneeChanges.length || clearAssignee) &&
    (!releasedChanges.length || confirmReleasedComposition);
  return <Modal onClose={onClose} className="project-dialog bulk-move-dialog" ariaLabel="Move selected tasks"><form onSubmit={(event) => { event.preventDefault(); if (target && canSubmit) void onSubmit({ targetProjectId: target.id, clearRelease, clearAssignee, confirmReleasedComposition }); }}><DialogHeader title="Move selected tasks" icon={<FolderKanban size={17} />} onClose={onClose} /><div className="form-stack project-form-stack"><label><span>Target Project</span><select required autoFocus value={targetProjectId} onChange={(event) => { setTargetProjectId(event.target.value); setClearRelease(false); setClearAssignee(false); setConfirmReleasedComposition(false); }}><option value="" disabled>Select Project…</option>{eligibleProjects.map((project) => <option key={project.id} value={project.id}>{project.taskCode} · {project.name}</option>)}</select></label>{target && <div className="bulk-preview" role="status"><h3>Commit preview</h3><p><b>{moving.length}</b> Task{moving.length === 1 ? "" : "s"} will move to <b>{target.name}</b>; {tasks.length - moving.length} same-Project selection{tasks.length - moving.length === 1 ? " is" : "s are"} no-op.</p>{moving.length > 0 && <p>Expected identifiers: <b>{target.taskCode}-{expectedStart}</b>{moving.length > 1 ? ` … ${target.taskCode}-${expectedStart + moving.length - 1}` : ""}. Final sequences are reserved only by the atomic commit.</p>}{releaseChanges.length > 0 && <label className="check-row"><input type="checkbox" checked={clearRelease} onChange={(event) => setClearRelease(event.target.checked)} />Clear {releaseChanges.length} incompatible Release assignment{releaseChanges.length === 1 ? "" : "s"}</label>}{assigneeChanges.length > 0 && <label className="check-row"><input type="checkbox" checked={clearAssignee} onChange={(event) => setClearAssignee(event.target.checked)} />Clear {assigneeChanges.length} assignee{assigneeChanges.length === 1 ? "" : "s"} without target access</label>}{releasedChanges.length > 0 && <label className="check-row"><input type="checkbox" checked={confirmReleasedComposition} onChange={(event) => setConfirmReleasedComposition(event.target.checked)} />Confirm changing {releasedChanges.length} released Release composition{releasedChanges.length === 1 ? "" : "s"}</label>}{hierarchyBlocks.length > 0 && <p className="dialog-warning">Blocked: detach or reparent {hierarchyBlocks.length} selected Task hierarchy{hierarchyBlocks.length === 1 ? "" : "ies"} first.</p>}{archivedBlocks.length > 0 && <p className="dialog-warning">Blocked: restore {archivedBlocks.length} archived Task{archivedBlocks.length === 1 ? "" : "s"} first.</p>}</div>}</div><div className="project-dialog-footer"><span /><div><button className="button ghost" type="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !canSubmit}>{busy ? "Moving…" : "Move tasks"}</button></div></div></form></Modal>;
}

export function BulkReleaseDialog({ data, tasks, busy, onClose, onSubmit, initialChoice = "" }: { data: AppSnapshot; tasks: TaskRecord[]; busy: boolean; onClose: () => void; onSubmit: (input: { releaseId: string | null; confirmReleasedComposition: boolean }) => Promise<unknown>; initialChoice?: string }) {
  const [choice, setChoice] = useState(initialChoice);
  const [confirmReleasedComposition, setConfirmReleasedComposition] = useState(false);
  const projectIds = new Set(tasks.map((task) => task.projectId));
  const compatibleProjectId = projectIds.size === 1 ? tasks[0]?.projectId ?? null : null;
  const releases = compatibleProjectId
    ? data.releases.filter((release) => release.projectId === compatibleProjectId)
    : [];
  const releaseId = choice === "__clear__" ? null : choice || null;
  const selectedRelease = releaseId ? data.releases.find((release) => release.id === releaseId) : null;
  const changed = choice
    ? tasks.filter((task) => task.releaseId !== releaseId)
    : [];
  const touchesReleased = changed.some((task) =>
    data.releases.find((release) => release.id === task.releaseId)?.status === "released"
  ) || selectedRelease?.status === "released";
  const canSubmit = Boolean(choice && changed.length) && (!touchesReleased || confirmReleasedComposition);
  return <Modal onClose={onClose} className="project-dialog bulk-move-dialog" ariaLabel="Change selected releases"><form onSubmit={(event) => { event.preventDefault(); if (canSubmit) void onSubmit({ releaseId, confirmReleasedComposition }); }}><DialogHeader title="Change selected releases" icon={<Rocket size={17} />} onClose={onClose} /><div className="form-stack project-form-stack"><label><span>Release</span><select required autoFocus value={choice} onChange={(event) => { setChoice(event.target.value); setConfirmReleasedComposition(false); }}><option value="" disabled>Select Release…</option><option value="__clear__">No Release</option>{releases.map((release) => <option key={release.id} value={release.id}>{formatReleaseName(data.projects.find((project) => project.id === release.projectId)?.name, release.name)}</option>)}</select></label>{projectIds.size > 1 && <p className="dialog-warning">The selected Tasks span multiple Projects. Only clearing Release is compatible; choosing a Release never moves a Task between Projects.</p>}{choice && <div className="bulk-preview" role="status"><h3>Commit preview</h3><p><b>{changed.length}</b> Task{changed.length === 1 ? "" : "s"} will use {selectedRelease ? <b>{selectedRelease.name}</b> : <b>No Release</b>}; {tasks.length - changed.length} selection{tasks.length - changed.length === 1 ? " is" : "s are"} no-op.</p>{touchesReleased && <label className="check-row"><input type="checkbox" checked={confirmReleasedComposition} onChange={(event) => setConfirmReleasedComposition(event.target.checked)} />Confirm changing released Release composition</label>}</div>}</div><div className="project-dialog-footer"><span /><div><button className="button ghost" type="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !canSubmit}>{busy ? "Saving…" : "Apply Release"}</button></div></div></form></Modal>;
}

function labelsForTask(
  context: Pick<AppSnapshot, "labels" | "taskLabels">,
  taskId: string,
) {
  const ids = new Set(context.taskLabels
    .filter((assignment) => assignment.taskId === taskId)
    .map((assignment) => assignment.labelId));
  return context.labels.filter((label) => ids.has(label.id));
}
function BulkBar({ data, tasks, statuses, archiveAction, onStatus, onPriority, onAssignee, onProject, onRelease, onLabel, onArchive, onClose }: { data: AppSnapshot; tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; archiveAction: ReturnType<typeof resolveArchiveBulkAction>; onStatus: (value: string) => void; onPriority: (value: Priority) => void; onAssignee: (value: string | null) => void; onProject: () => void; onRelease: () => void; onLabel: (labelId: string, active: boolean) => void; onArchive: () => void; onClose: () => void }) {
  const [labels, setLabels] = useState<LabelRecord[]>([]);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const oneCatalog = new Set(tasks.map((task) => task.ownerUserId)).size === 1;
  const catalogProjectId = tasks[0]?.projectId ?? null;
  const assigneeOptions = bulkAssigneeOptions(data, tasks).filter((user) => {
    const needle = assigneeSearch.trim().toLowerCase();
    return !needle || user.displayName.toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle);
  });
  useEffect(() => {
    if (!oneCatalog || !catalogProjectId) return;
    const controller = new AbortController();
    void fetch(`/api/labels?projectId=${encodeURIComponent(catalogProjectId)}&includeArchived=true`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const value = await response.json() as { labels?: LabelRecord[] };
        if (response.ok && value.labels) setLabels(value.labels);
      }).catch(() => undefined);
    return () => controller.abort();
  }, [catalogProjectId, oneCatalog]);
  return <div className="bulk-bar"><b>{tasks.length} selected</b><select defaultValue="" onChange={(event) => event.target.value && onStatus(event.target.value)}><option value="" disabled>Status…</option>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select><select defaultValue="" onChange={(event) => event.target.value && onPriority(event.target.value as Priority)}><option value="" disabled>Priority…</option>{Object.entries(priorityMeta).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select><div className="bulk-assignee"><input type="search" aria-label="Search bulk assignees" placeholder="Find assignee…" value={assigneeSearch} onChange={(event) => setAssigneeSearch(event.target.value)} /><select aria-label="Bulk assignee" defaultValue="" title={assigneeOptions.length ? "Assign every selected task" : "No user has access to every selected task; Unassigned remains available"} onChange={(event) => { if (!event.target.value) return; onAssignee(event.target.value === "__unassigned__" ? null : event.target.value); event.target.value = ""; }}><option value="" disabled>Assignee…</option><option value="__unassigned__">Unassigned</option>{assigneeOptions.map((user) => <option key={user.id} value={user.id}>{user.displayName}</option>)}</select></div><button type="button" onClick={onProject}><FolderKanban size={14} />Project…</button><button type="button" onClick={onRelease}><Rocket size={14} />Release…</button>{oneCatalog && <><select aria-label="Bulk add Label" defaultValue="" onChange={(event) => { if (event.target.value) onLabel(event.target.value, true); event.target.value = ""; }}><option value="" disabled>Add label…</option>{labels.filter((label) => !label.archivedAt).map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select><select aria-label="Bulk remove Label" defaultValue="" onChange={(event) => { if (event.target.value) onLabel(event.target.value, false); event.target.value = ""; }}><option value="" disabled>Remove label…</option>{labels.map((label) => <option key={label.id} value={label.id}>{label.name}{label.archivedAt ? " (archived)" : ""}</option>)}</select></>}<button onClick={onArchive}>{archiveAction.archived ? <Archive size={14} /> : <ArchiveRestore size={14} />}{archiveAction.label}</button><button onClick={onClose}><X size={14} /></button></div>;
}

export function bulkAssigneeOptions(data: AppSnapshot, tasks: TaskRecord[]): UserRecord[] {
  if (!tasks.length) return [];
  let intersection: Set<string> | null = null;
  for (const task of tasks) {
    const candidateIds = new Set<string>();
    if (task.projectId) {
      const project = data.projects.find((item) => item.id === task.projectId);
      if (project) candidateIds.add(project.ownerUserId);
      for (const collaborator of data.collaborators) {
        if (collaborator.resourceType === "project" && collaborator.resourceId === task.projectId) {
          candidateIds.add(collaborator.userId);
        }
      }
    } else {
      candidateIds.add(task.ownerUserId);
      for (const collaborator of data.collaborators) {
        if (collaborator.resourceType === "task" && collaborator.resourceId === task.id) {
          candidateIds.add(collaborator.userId);
        }
      }
    }
    const currentIntersection: Set<string> | null = intersection;
    intersection = currentIntersection === null
      ? candidateIds
      : new Set<string>(
          [...currentIntersection].filter((id: string) => candidateIds.has(id)),
        );
  }
  const users = new Map([data.user, ...data.users].map((user) => [user.id, user]));
  return [...(intersection ?? [])]
    .map((id) => users.get(id))
    .filter((user): user is UserRecord => Boolean(user))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

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
  return data.views.find(
    (view) => view.id === surface.slice(5) && !view.archivedAt,
  )?.display.layout ?? "list";
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
  if (surface.startsWith("settings:")) {
    const section = surface.slice("settings:".length) as SettingsSection;
    const label = settingsNavigation.flatMap((group) => group.items)
      .find((item) => item.section === section)?.label ?? "Profile";
    return [workspace, ancestor("Settings", "settings:profile"), current(label)];
  }
  if (surface === "views") return [workspace, current("Views")];
  if (surface === "projects") return [workspace, current("Projects")];
  if (surface === "releases") return [workspace, current("Releases")];
  if (surface === "teams") return [workspace, current("Teams")];
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
function isCollectionSurface(surface: string) { return surface === "workspace" || surface === "shared" || surface === "teams" || surface === "admin" || surface === "views" || surface === "projects" || surface === "releases" || surface.startsWith("project-releases:") || surface.startsWith("settings:"); }
function taskContextualEntity(task: TaskRecord): ContextualActionEntity {
  return { kind: "task", id: task.id, label: task.identifier, accessRole: task.accessRole, archivedAt: task.archivedAt, version: taskMutationVersion(task) };
}
function projectContextualEntity(project: ProjectRecord): ContextualActionEntity {
  return { kind: "project", id: project.id, label: project.name, accessRole: project.accessRole, archivedAt: project.archivedAt ?? null, version: project.version };
}
function releaseContextualEntity(release: ReleaseRecord): ContextualActionEntity {
  return { kind: "release", id: release.id, label: release.name, accessRole: release.accessRole, archivedAt: null, version: release.version };
}
function viewContextualEntity(view: SavedViewRecord): ContextualActionEntity {
  return { kind: "saved_view", id: view.id, label: view.name, accessRole: view.accessRole, archivedAt: view.archivedAt ?? null, version: view.version };
}
export function shareTarget(surface: string, activeTask: TaskRecord | null, data: AppSnapshot): ShareTarget | null {
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
      const target = projectTarget(data.projects.find((item) => item.id === activeTask.projectId));
      return target
        ? {
            ...target,
            directTeamTask: {
              resourceId: activeTask.id,
              label: activeTask.identifier,
              accessRole: activeTask.accessRole,
            },
          }
        : null;
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
export function sortTasks(tasks: TaskRecord[], display?: ViewDisplay) {
  const orderBy = display?.orderBy ?? "priority";
  const direction = orderBy !== "manual" && display?.direction === "desc" ? -1 : 1;
  const priorityOrder: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  return [...tasks].sort((a, b) => {
    let comparison = 0;
    if (orderBy === "priority") comparison = priorityOrder[a.priority] - priorityOrder[b.priority];
    else if (orderBy === "created") comparison = a.createdAt.localeCompare(b.createdAt);
    else if (orderBy === "updated") comparison = a.updatedAt.localeCompare(b.updatedAt);
    else if (orderBy === "due") comparison = (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31");
    else if (orderBy === "title") comparison = a.title.toLocaleLowerCase().localeCompare(b.title.toLocaleLowerCase());
    else comparison = a.rank - b.rank;
    return comparison * direction || a.rank - b.rank || a.publicId.localeCompare(b.publicId);
  });
}
function displayLabel(value: string) {
  const labels: Record<string, string> = {
    none: "No grouping",
    due: "Due date",
    dueDate: "Due date",
  };
  return labels[value] ?? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
function taskCountForView(id: string, data: AppSnapshot, statusMap: Map<string, WorkflowStatusRecord>) { const exact = data.workspaceMetrics?.taskCounts; if (id === "mine") return exact?.mine ?? data.tasks.filter((task) => !task.archivedAt && task.assigneeUserId === data.user.id).length; if (id === "archived") return exact?.archived ?? data.tasks.filter((task) => task.archivedAt).length; if (id === "backlog") return exact?.backlog ?? data.tasks.filter((task) => !task.archivedAt && statusMap.get(task.statusId)?.category === "backlog").length; if (id === "active") return exact?.active ?? data.tasks.filter((task) => !task.archivedAt && ["unstarted", "started"].includes(statusMap.get(task.statusId)?.category ?? "")).length; return exact?.all ?? data.tasks.filter((task) => !task.archivedAt).length; }
function completion(tasks: TaskRecord[], statuses: WorkflowStatusRecord[]) { const statusMap = new Map(statuses.map((status) => [status.id, status])); const eligible = tasks.filter((task) => statusMap.get(task.statusId)?.category !== "canceled"); if (!eligible.length) return 0; return Math.round((eligible.filter((task) => statusMap.get(task.statusId)?.category === "completed").length / eligible.length) * 100); }
function toggleSet(current: Set<string>, value: string) { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; }
function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>) { return left.size === right.size && [...left].every((value) => right.has(value)); }
function initials(value: string) { return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
function shortDate(value: string) { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00`)); }
function longDate(value: string, timeZone: string) { try { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone }).format(new Date(value)); } catch { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(value)); } }
function longDateTime(value: string) { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function zonedDateTime(value: string, timeZone: string) { try { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(value)); } catch { return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(value)); } }
function isOverdue(value: string, category: string) { return new Date(`${value}T23:59:59`) < new Date() && category !== "completed" && category !== "canceled"; }
