"use client";
import {
  type TaskGroup,
} from "@/lib/task-groups";
import {
  navigationHistoryState,
  type ResolvedNavigation,
} from "@/lib/navigation";
import {
  mergeTaskSummary,
} from "@/lib/workspace-sync-contract";
import {
  parseWorkspaceScopeToken,
} from "@/lib/workspace-scope";
import {
  nextTaskActivityInvalidationCursor,
} from "@/lib/task-detail-reconciliation";
import {
  type UserPreferenceChanges,
} from "@/lib/user-preference-save";
import type {
  AccessRole,
  AppSnapshot,
  LabelGroupRecord,
  LabelRecord,
  Priority,
  ProjectRecord,
  TeamGrantList,
  TeamGrantResourceType,
  TeamList,
  TaskRecord,
  TaskLabelAssignment,
  TaskRelationRecord,
  UserProfile,
  ViewDisplay,
  WorkflowStatusRecord,
  WorkspaceSyncResponse,
  WorkspaceCatalogKind,
  WorkspaceCatalogPage,
} from "@/lib/types";

export type ShareTarget = {
  resourceType: "project" | "task" | "saved_view";
  resourceId: string;
  label: string;
  accessRole: AccessRole;
  ownerUserId: string;
  inherited: boolean;
};

export type TeamShareRoute = {
  key: string;
  resourceType: TeamGrantResourceType;
  resourceId: string;
  publicId: string;
  label: string;
  explanation: string;
  accessRole: AccessRole;
};

export type ShareContext = {
  key: string;
  label: string;
  directTarget: ShareTarget | null;
  teamRoutes: TeamShareRoute[];
  teamUnavailableCopy: string | null;
};

export type SharePersonOption = {
  kind: "person";
  key: string;
  displayName: string;
  email: string;
};

export type ShareTeamOption = {
  kind: "team";
  key: string;
  entry: TeamList["teams"][number];
};

export type SharePrincipalOption = SharePersonOption | ShareTeamOption;
export type TeamGrantMutationState = { routeKey: string; key: string } | null;
export type TeamGrantAlert = { routeKey: string; routePublicId: string; message: string } | null;

export type Dialog = "task" | "project" | "projectEdit" | "release" | "releaseEdit" | "view" | "viewEdit" | "share" | "systemExport" | "systemImport" | "codexSetup" | "workflowSettings" | "labelSettings" | "labelGroupSettings" | "bulkProject" | "bulkRelease" | "teamCreate" | "teamRename" | "teamMemberAdd" | "teamMemberDelete" | null;
export type AsyncValue<T> =
  | { status: "idle"; value: null; error: "" }
  | { status: "loading"; value: T | null; error: "" }
  | { status: "ready"; value: T; error: "" }
  | { status: "error"; value: T | null; error: string };

export type TeamMutationKind = "create" | "rename" | "add" | "deactivate" | "reactivate" | "delete";
export type TeamMutationState = { kind: TeamMutationKind; key: string } | null;

export function filterTeamList(value: TeamList, query: string): TeamList["teams"] {
  const needle = query.trim().toLocaleLowerCase();
  return value.teams.filter((entry) =>
    !needle || entry.team.name.toLocaleLowerCase().includes(needle));
}

export function filterShareTeamOptions(
  value: TeamList,
  query: string,
): TeamList["teams"] {
  const needle = query.trim().toLocaleLowerCase();
  return value.teams
    .filter(({ team, currentMembership }) =>
      !team.archivedAt &&
      currentMembership.status === "active" &&
      (!needle || team.name.toLocaleLowerCase().includes(needle)))
    .sort((left, right) =>
      Number(right.currentMembership.role === "owner") -
        Number(left.currentMembership.role === "owner") ||
      left.team.name.localeCompare(right.team.name, undefined, { sensitivity: "base" }) ||
      left.team.publicId.localeCompare(right.team.publicId));
}

export function teamShareRequestIsCurrent(
  requestedGeneration: number,
  currentGeneration: number,
  requestedRouteKey: string,
  currentRouteKey: string,
  aborted: boolean,
) {
  return requestedGeneration === currentGeneration &&
    requestedRouteKey === currentRouteKey &&
    !aborted;
}

export function teamGrantResponseMatchesRoute(
  route: TeamShareRoute,
  value: TeamGrantList,
) {
  return value.target.resourceType === route.resourceType &&
    value.target.resourceId === route.resourceId &&
    value.target.publicId === route.publicId;
}

export function teamGrantConflictReadbackMessage(latestLoaded: boolean) {
  return latestLoaded
    ? "Team access changed in another session. The latest routes were loaded; review them and try again."
    : "Team access changed, but the latest routes could not be loaded. Retry.";
}

export function teamShareRouteIdentity(routes: readonly TeamShareRoute[]) {
  return routes.map((route) =>
    `${route.key}:${route.resourceType}:${route.publicId}:${route.accessRole}`).join("|");
}

export function teamRequestIsCurrent(
  requestedGeneration: number,
  currentGeneration: number,
  aborted: boolean,
) {
  return requestedGeneration === currentGeneration && !aborted;
}

export function teamConflictReadbackMessage(
  latestLoaded: boolean,
  unavailable: boolean,
) {
  if (unavailable) return "";
  return latestLoaded
    ? "This Team changed in another session. The latest details were loaded; review them and try again."
    : "This Team changed, but the latest details could not be loaded. Retry.";
}

export class TeamRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function requestTeamApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const value = await response.json() as T | { error: string };
  if (!response.ok || (value && typeof value === "object" && "error" in value)) {
    throw new TeamRequestError(
      value && typeof value === "object" && "error" in value
        ? String(value.error)
        : "Team request failed",
      response.status,
    );
  }
  return value as T;
}
export type CodexSetupMode = "desktop" | "cli";
export type CodexSetupModeAction =
  | { type: "select"; mode: CodexSetupMode }
  | { type: "open_cli_fallback" };
export type TaskCreateDefaults = Partial<{
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

export const workspaceScopeHistoryKey = "taskManagerWorkspaceScope";

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

export function navigationStateForWorkspaceScope(
  navigation: ResolvedNavigation,
  workspaceScope: string,
) {
  return navigation.surface === "workspace"
    ? navigationStateWithWorkspaceScope(navigation, workspaceScope)
    : navigationHistoryState(navigation);
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

export type RelativeRelationKind = "blocks" | "blocked_by" | "related" | "duplicate_of" | "duplicates";

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

export type LabelMutationResult = {
  labelGroups?: LabelGroupRecord[];
  labels: LabelRecord[];
  taskLabels: TaskLabelAssignment[];
  taskIds: string[];
  canWrite?: boolean;
};
export type MutationResult = AppSnapshot | { task: TaskRecord } | { taskUpdates: TaskRecord[] } | LabelMutationResult;

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

export function workspaceMetricsAfterTaskReplacements(
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

export function taskMetricContribution(
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

export function invalidateTaskActivity(
  task: TaskRecord,
  nonce = crypto.randomUUID(),
): TaskRecord {
  return {
    ...task,
    activityInvalidationCursor: `local:${task.version}:${task.updatedAt}:${nonce}`,
  };
}

export function mergeTaskMutation(
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

export function mergeCatalogCoverage(
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

export function mergeDeferredUserState(
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

export class ProfileRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function patchUserPreferences(
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

export async function fetchUserProfile(): Promise<UserProfile> {
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

export function mergeResetCollection<T extends { id: string; version: number }>(
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

export function mergeUnique<T>(incoming: T[], current: T[], key: (item: T) => string): T[] {
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

export const builtInViews = [
  { id: "mine", label: "My tasks" },
  { id: "all", label: "All tasks" },
  { id: "active", label: "Active" },
  { id: "backlog", label: "Backlog" },
  { id: "archived", label: "Archived" },
];
