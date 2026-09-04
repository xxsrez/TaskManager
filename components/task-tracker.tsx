"use client";
/* eslint-disable @next/next/no-html-link-for-pages */

import {
  ArrowDown,
  ArrowUp,
  Boxes,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Columns3,
  Copy,
  Download,
  FolderKanban,
  Inbox,
  LayoutList,
  Link2,
  ListFilter,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelsTopLeft,
  Plus,
  Rocket,
  Search,
  Share2,
  ShieldCheck,
  Settings2,
  SlidersHorizontal,
  UsersRound,
  X,
  Zap,
} from "lucide-react";
import {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  canEditContent,
} from "@/lib/access";
import {
  buildTaskGroups,
  canMoveTaskToGroup,
  projectTaskGroupMove,
  rankBetweenNeighbors,
  rollbackTaskGroupMove,
  shouldShowEmptyTaskGroups,
  taskGroupCreateDefaults,
  taskGroupValue,
  tasksInGroupOrder,
  type TaskGroup,
} from "@/lib/task-groups";
import {
  navigationPath,
  navigationPathWithTemporaryFilter,
  parseNavigationPath,
  projectReleasesPath,
  resolveNavigationHistoryState,
  resolveNavigationTarget,
  type Layout,
  type ResolvedNavigation,
} from "@/lib/navigation";
import {
  type GlobalSearchResult,
} from "@/lib/global-search";
import {
  formatReleaseName,
} from "@/lib/release-presentation";
import {
  selectRecentNavigation,
} from "@/lib/recent-navigation";
import {
  defaultViewDisplay,
  emptyViewQuery,
} from "@/lib/view-contract";
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
  resolveWorkspaceScopeMembership,
  sharedWithMeRoots,
} from "@/lib/workspace-scope";
import {
  mergeLoadedTask,
  mergeSearchTaskSummaries,
  mergeTaskDetailContext,
  reconcileTaskDetailAfterReset,
  reconcileTaskDetailFromSync,
  taskMutationVersion,
  taskNeedsDetailRefresh,
} from "@/lib/task-detail-reconciliation";
import {
  useWorkspaceSyncCoordinator,
  type WorkspaceSyncCheckpoint,
} from "@/components/workspace-sync-coordinator";
import { useSystemExportController } from "@/components/task-tracker-system-export";
import { useTeamsController } from "@/components/task-tracker-teams-controller";
import { useWorkspaceCatalogController } from "@/components/task-tracker-catalog-controller";
import {
  useRecoverableDeletionController,
  type RecoverableDeletionState,
} from "@/components/task-tracker-deletion-controller";
import { useTaskTrackerMutationController } from "@/components/task-tracker-mutation-controller";
import { useTaskTrackerKeyboardController } from "@/components/task-tracker-keyboard-controller";
import { useTaskTrackerContextualActions } from "@/components/task-tracker-contextual-actions";
import {
  ContextualActionMenu,
} from "@/components/contextual-action-menu";
import {
  DeletionUndoToast,
  RecoverableDeleteDialog,
} from "@/components/deletion-dialogs";
import {
  DeletionConvergenceAlert,
} from "@/components/recently-deleted-manager";
import {
  pruneDeletedEntityFromSnapshot,
  workspaceSyncAffectsRecentlyDeleted,
} from "@/lib/deletion-client";
import {
  selectTaskRange,
  toggleTaskSelection,
} from "@/lib/task-keyboard";
import {
  resolveContextualActions,
} from "@/lib/contextual-actions";
import {
  createUserPreferenceSaveQueue,
  type UserPreferenceChanges,
} from "@/lib/user-preference-save";
import type {
  AppSnapshot,
  ProjectRecord,
  TaskRecord,
  TaskDetailRecord,
  UserRecord,
  UserProfile,
  ViewDisplay,
  ViewQuery,
  WorkspaceCatalogKind,
  WorkspaceSyncResponse,
} from "@/lib/types";

import {
  ProfileRequestError,
  builtInViews,
  fetchTaskSnapshot,
  fetchUserProfile,
  groupByOptions,
  mergeDeferredSnapshot,
  mergeUnique,
  navigationStateForWorkspaceScope,
  patchUserPreferences,
  projectGroupMovePreview,
  reconcileTaskSearch,
  resolveArchiveBulkAction,
  runSingleFlight,
  snapshotProvesCollectionAbsence,
  taskDetailUiApiPath,
  taskMatchesSearch,
  toggleViewField,
  type Dialog,
  type PendingProjectGroupMove,
  type TaskCreateDefaults,
  type TaskSearchState,
  viewDisplayDependencies,
  viewFieldOptions,
  viewOrderOptions,
  workspaceScopeFromHistory,
  workspaceScopeStorageKey,
} from "@/components/task-tracker-state";

import {
  AdminSurface,
  BulkBar,
  BulkProjectDialog,
  BulkReleaseDialog,
  CatalogPagination,
  CodexSetupDialog,
  DisplayPopover,
  FilterChips,
  FilterPopover,
  GlobalSearchOverlay,
  LabelGroupSettingsDialog,
  LabelSettingsDialog,
  NavItem,
  Peek,
  ProjectDialog,
  ProjectOverview,
  ProjectsSurface,
  ReleaseDialog,
  ReleaseOverview,
  ReleasesSurface,
  SavedFilterChips,
  SavedViewFilterLayers,
  SettingsSurface,
  ShareDialog,
  SharedWithMeSurface,
  SidebarSavedViewItem,
  SidebarSection,
  SystemBackupExportDialog,
  SystemImportDialog,
  TaskBoard,
  TaskComposer,
  TaskDetails,
  TaskDetailsLoading,
  TaskList,
  TaskMoveDialog,
  TaskQueryPagination,
  TaskSearchNotice,
  TeamDetailSurface,
  TeamMemberDeleteDialog,
  TeamMemberDialog,
  TeamNameDialog,
  TeamsSurface,
  ViewDialog,
  ViewsSurface,
  WorkflowSettingsDialog,
  WorkspaceOverviewSurface,
  confirmReleasedCompositionChange,
  defaultLayoutForSurface,
  handleLocalLink,
  initials,
  isCollectionSurface,
  labelsForTask,
  openProjectTaskCount,
  openReleaseTaskCount,
  projectContextualEntity,
  projectMemberOptions,
  queryFilterCount,
  releaseContextualEntity,
  releasedCompositionNeedsConfirmation,
  resolveGlobalSearchNavigation,
  resolveShareContext,
  sortTasks,
  statusGroupsForTasks,
  surfaceBreadcrumbs,
  taskAssigneeOptions,
  taskContextualEntity,
  taskCountForView,
  taskHierarchySummary,
  toggleSet,
  viewContextualEntity,
} from "@/components/task-tracker-view";

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

export {
  PULL_REFRESH_THRESHOLD,
  PriorityIcon,
  TASK_MANAGER_CLI_SETUP,
  TASK_MANAGER_DIAGNOSTIC_PROMPT,
  TASK_MANAGER_MARKETPLACE_URL,
  canStartPullRefresh,
  commentDraftStorageKey,
  fetchCompleteWorkspaceCatalog,
  fetchTaskSnapshot,
  filterShareTeamOptions,
  filterTeamList,
  mergeDeferredSnapshot,
  mergeWorkspaceCatalogPage,
  navigationStateForWorkspaceScope,
  navigationStateWithWorkspaceScope,
  nextCodexSetupMode,
  projectGroupMovePreview,
  pullRefreshDistance,
  reconcileTaskSearch,
  relationCandidateProjectLabel,
  resolveArchiveBulkAction,
  runSingleFlight,
  shouldTriggerPullRefresh,
  snapshotProvesCollectionAbsence,
  taskDetailUiApiPath,
  taskMatchesSearch,
  taskRelationPresentations,
  taskRelationSearchUiApiPath,
  taskRowReorderDirection,
  teamConflictReadbackMessage,
  teamGrantConflictReadbackMessage,
  teamGrantResponseMatchesRoute,
  teamRequestIsCurrent,
  teamShareRequestIsCurrent,
  teamShareRouteIdentity,
  type AsyncValue,
  type CodexSetupMode,
  type CodexSetupModeAction,
  type PendingProjectGroupMove,
  type ShareContext,
  type TaskRelationPresentation,
  type TaskSearchState,
  type TeamShareRoute,
  viewDisplayDependencies,
  workspaceScopeFromHistory,
  workspaceScopeStorageKey,
} from "@/components/task-tracker-state";
export {
  applyMutationResult,
  scopedUiApiPath,
} from "@/components/task-tracker-state";
export {
  CodexSetupDialog,
  FilterConditionEditor,
  FilterPopover,
  ProjectDialog,
  ReleaseDialog,
  SavedViewFilterLayers,
  SettingsSurface,
  ShareDialog,
  SystemBackupExportDialog,
  SystemBackupPreview,
  SystemBackupProgress,
  SystemImportDialog,
  TeamGrantAccessRow,
  ViewDialog,
  canManageTeamRouteGrant,
  handleFilterPickerEscape,
  normalizedTeamSharePermission,
  teamRouteRoles,
  viewDialogDraftIsDirty,
  viewDialogDraftQuery,
} from "@/components/task-tracker-dialogs";
export {
  StatusIcon,
  TaskMoveDialog,
  relationCandidateAllowedForKind,
  relationSelectionAfterKindChange,
  statusIconVariant,
  toggleLabelSelection,
} from "@/components/task-tracker-tasks";
export {
  BulkProjectDialog,
  BulkReleaseDialog,
  GlobalSearchContinuationWarning,
  GlobalSearchOverlay,
  ProjectOverview,
  ReleaseOverview,
  TeamDetailSurface,
  TeamMemberDeleteDialog,
  TeamMemberDialog,
  TeamNameDialog,
  TeamsSurface,
  bulkAssigneeOptions,
  resolveGlobalSearchNavigation,
  resolveShareContext,
  sortTasks,
} from "@/components/task-tracker-view";

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
  initialWorkspaceData = null,
  initialNavigation,
  signOutPath,
}: {
  initialData: AppSnapshot;
  initialWorkspaceData?: AppSnapshot | null;
  initialNavigation: ResolvedNavigation;
  signOutPath: string;
}) {
  const [data, setData] = useState(initialData);
  const dataRef = useRef(data);
  const workspaceScopeToken = ALL_ACCESSIBLE_WORKSPACE_SCOPE;
  const workspaceScopeTokenRef = useRef(ALL_ACCESSIBLE_WORKSPACE_SCOPE);
  const initialWorkspaceProjection = initialWorkspaceData ?? initialData;
  const initialWorkspaceFocusToken = initialWorkspaceData?.workspaceScope?.selectedToken ??
    initialData.workspaceScope?.options.find((option) => option.current)?.token ??
    ALL_ACCESSIBLE_WORKSPACE_SCOPE;
  const [workspaceData, setWorkspaceData] = useState(initialWorkspaceProjection);
  const workspaceDataRef = useRef(initialWorkspaceProjection);
  const [workspaceFocusToken, setWorkspaceFocusToken] = useState(initialWorkspaceFocusToken);
  const workspaceFocusTokenRef = useRef(initialWorkspaceFocusToken);
  const workspaceSyncRefreshReadyRef = useRef(false);
  const [workspaceScopeLoading, setWorkspaceScopeLoading] = useState(false);
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
  const [auxiliaryBackupBusy, setAuxiliaryBackupBusy] = useState(false);
  const [error, setError] = useState("");
  const [recentlyDeletedEpoch, setRecentlyDeletedEpoch] = useState(0);
  const {
    pages: catalogPages,
    loading: catalogLoading,
    order: catalogOrder,
    direction: catalogDirection,
    setOrder: setCatalogOrder,
    setDirection: setCatalogDirection,
    ensureComplete: ensureCompleteCatalogs,
    invalidate: invalidateCatalogs,
    loadMore: loadMoreCatalog,
  } = useWorkspaceCatalogController({
    dataRef,
    setData,
    surface,
    search,
    workspaceScopeToken,
    onError: setError,
  });
  const {
    pending: recoverableDeletion,
    undo: deletionUndo,
    busy: deletionBusy,
    convergenceError: deletionConvergenceError,
    open: openRecoverableDelete,
    confirm: deleteRecoverably,
    undoDelete: undoRecoverableDelete,
    retryConvergence: retryDeletionConvergence,
    closePending: closeRecoverableDeletion,
    dismissUndo: dismissDeletionUndo,
  } = useRecoverableDeletionController({
    dataRef,
    workspaceScopeTokenRef,
    onError: setError,
    onDismissDialog: () => setDialog(null),
    onDeleted: (target) => {
      navigateAfterRecoverableDelete(target);
      applyImmediateDeletionPrune(target);
    },
    refreshAfterMutation: refreshAfterDeletionMutation,
  });
  const [theme, setTheme] = useState<"system" | "light" | "dark">(
    initialData.user.theme ?? "system",
  );
  const preferenceSaveQueueRef = useRef<ReturnType<typeof createUserPreferenceSaveQueue> | null>(null);
  const activeTeamPublicId = surface.startsWith("team:")
    ? surface.slice("team:".length)
    : null;
  const {
    listState: teamListState,
    detailState: teamDetailState,
    mutation: teamMutation,
    alert: teamAlert,
    memberForDelete: teamMemberForDelete,
    activeDetail: activeTeamDetail,
    clearAlert: clearTeamAlert,
    setMemberForDelete: setTeamMemberForDelete,
    loadList: loadTeamList,
    loadDetail: loadTeamDetail,
    createTeam,
    renameTeam,
    addMember: addTeamMember,
    changeMembership: changeTeamMembership,
    deleteMembership: deleteTeamMembership,
  } = useTeamsController({
    activeTeamPublicId,
    listVisible: surface === "teams",
    onCreated: (teamPublicId) => {
      setDialog(null);
      applyNavigation({
        surface: `team:${teamPublicId}`,
        layout: "list",
        taskId: null,
      });
    },
    onConflict: () => {
      if (dialog === "teamRename" || dialog === "teamMemberAdd" || dialog === "teamMemberDelete") {
        setDialog(null);
      }
    },
  });

  const systemExport = useSystemExportController({
    enabled: surface === "admin" && Boolean(data.admin),
    onOpenDialog: () => setDialog("systemExport"),
  });
  const {
    busy,
    mutate,
    createTask: createTaskForComposer,
    updateClientTask,
    refreshTaskDetail,
    refreshSavedViewsAfterConflict,
  } = useTaskTrackerMutationController({
    snapshot: {
      dataRef,
      setCurrent: (value) => {
        dataRef.current = value;
      },
      setData,
    },
    workspace: {
      surface,
      scopeTokenRef: workspaceScopeTokenRef,
      focusTokenRef: workspaceFocusTokenRef,
      dataRef: workspaceDataRef,
      setCurrent: (value) => {
        workspaceDataRef.current = value;
      },
      setData: setWorkspaceData,
      reloadFocus: (token) => loadWorkspaceScopeSnapshot(token, "none", false),
    },
    tasks: {
      setDetail: setTaskDetail,
      setSearch: setTaskSearch,
      reconcileMutation: reconcileSuccessfulTaskMutation,
    },
    onError: setError,
  });
  const {
    menu: contextualMenu,
    open: openContextualActions,
    openForTask: openTaskContextualActions,
    close: closeContextualActions,
    focusedEntity: focusedContextualActionEntity,
    execute: executeContextualAction,
  } = useTaskTrackerContextualActions({
    data,
    selected,
    setSelected,
    surface,
    setDialog,
    mutate,
    openTask,
    navigateSurface,
    openRecoverableDelete,
    onError: setError,
  });
  const systemBackupBusy = auxiliaryBackupBusy || systemExport.running;
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
  const openDialogWithCatalog = useCallback(async (
    nextDialog: Exclude<Dialog, null>,
    kinds: readonly WorkspaceCatalogKind[],
  ) => {
    setError("");
    try {
      await ensureCompleteCatalogs(kinds, true);
      setDialog(nextDialog);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Catalog could not be loaded");
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
      navigationStateForWorkspaceScope(
        { surface: "workspace", layout: "list", taskId: null },
        workspaceFocusTokenRef.current,
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
      invalidateCatalogs();
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
  }, [activeTaskId, invalidateCatalogs, returnToWorkspaceAfterRemoval, surface]);
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
  }, [activeTaskId, invalidateCatalogs, returnToWorkspaceAfterRemoval, surface]);

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
    workspaceDataRef.current = workspaceData;
  }, [workspaceData]);

  useEffect(() => {
    workspaceFocusTokenRef.current = workspaceFocusToken;
  }, [workspaceFocusToken]);

  useEffect(() => {
    if (initialNavigation.surface !== "workspace" || !initialWorkspaceProjection.workspaceScope) {
      return;
    }
    const persisted = window.localStorage.getItem(
      workspaceScopeStorageKey(initialData.user.id),
    );
    const membership = resolveWorkspaceScopeMembership(
      persisted,
      initialWorkspaceProjection.workspaceScope.options,
      initialWorkspaceProjection.workspaceScope.options.find((option) => option.current)?.token ??
        initialWorkspaceProjection.workspaceScope.selectedToken,
    );
    if (!persisted || membership.fallback || membership.token === workspaceFocusTokenRef.current) {
      return;
    }
    void loadWorkspaceScopeSnapshot(membership.token, "replace", false);
    // Initial hydration intentionally uses the server-projected option set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (surface !== "workspace") return;
    if (!workspaceSyncRefreshReadyRef.current) {
      workspaceSyncRefreshReadyRef.current = true;
      return;
    }
    if (workspaceFocusTokenRef.current === ALL_ACCESSIBLE_WORKSPACE_SCOPE) {
      workspaceDataRef.current = data;
      setWorkspaceData(data);
      return;
    }
    void loadWorkspaceScopeSnapshot(workspaceFocusTokenRef.current, "none", false);
    // A global sync/mutation changes the ACL-complete source; refresh the local focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.syncCursor, surface]);

  useEffect(() => {
    taskSearchRef.current = taskSearch;
  }, [taskSearch]);

  useEffect(() => () => taskQueryRefreshCoordinatorRef.current?.cancel(), []);

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
      navigationStateForWorkspaceScope(
        initialNavigation,
        workspaceFocusTokenRef.current,
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
    invalidateCatalogs(true);
    setRecentlyDeletedEpoch((current) => current + 1);
    const incoming = await refreshTaskList();
    return incoming;
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
    invalidateCatalogs(true);
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

  const breadcrumbs = surfaceBreadcrumbs(
    surface,
    data,
    activeSavedView,
    activeTeamDetail?.team.name,
  );
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
    : surface === "teams"
      ? teamListState.value?.teams.length ?? ""
    : activeTeamPublicId
      ? activeTeamDetail?.members.filter((membership) => membership.status === "active").length ?? ""
    : surface === "admin" && data.admin
      ? data.admin.registeredUserCount
    : surface === "shared"
      ? sharedWithMeRoots(data).projects.length + sharedWithMeRoots(data).views.length
    : surface.startsWith("settings:")
      ? ""
    : projectReleaseSurfaceId
      ? scopedReleases.length
      : visibleTasks.length;
  const contextProjectRecord = contextProject
    ? data.projects.find((project) => project.id === contextProject)
    : undefined;
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
  const currentShareContext = resolveShareContext(surface, activeTask, data);
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
      : surface === "teams"
        ? "Search teams"
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

  async function downloadProjectBackup(project: ProjectRecord) {
    setAuxiliaryBackupBusy(true);
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
      setAuxiliaryBackupBusy(false);
    }
  }

  async function loadWorkspaceScopeSnapshot(
    requestedToken: string,
    historyMode: "push" | "replace" | "none" = "push",
    goToWorkspace = true,
  ) {
    const scope = workspaceDataRef.current.workspaceScope ?? dataRef.current.workspaceScope;
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
      workspaceFocusTokenRef.current = selectedToken;
      setWorkspaceFocusToken(selectedToken);
      workspaceDataRef.current = incoming;
      setWorkspaceData(incoming);
      window.localStorage.setItem(
        workspaceScopeStorageKey(incoming.user.id),
        selectedToken,
      );
      const next: ResolvedNavigation = goToWorkspace
        ? { surface: "workspace", layout: "list", taskId: null }
        : { surface: "workspace", layout: "list", taskId: null };
      if (goToWorkspace) {
        setSurface(next.surface);
        setLayout(next.layout);
        setActiveTaskId(null);
        taskReturnPath.current = "/workspace";
      }
      if (historyMode !== "none") {
        window.history[historyMode === "push" ? "pushState" : "replaceState"](
          navigationStateForWorkspaceScope(next, selectedToken),
          "",
          goToWorkspace ? "/workspace" : window.location.href,
        );
      }
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error
        ? requestError.message
        : "Workspace focus could not be loaded");
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
        navigationStateForWorkspaceScope(next, workspaceFocusTokenRef.current),
        "",
        nextPath,
      );
    } else if (historyMode === "replace") {
      window.history.replaceState(
        navigationStateForWorkspaceScope(next, workspaceFocusTokenRef.current),
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
    if (nextSurface === "workspace" && surface !== "workspace") {
      const scope = workspaceDataRef.current.workspaceScope ?? dataRef.current.workspaceScope;
      const currentToken = scope?.options.find((option) => option.current)?.token;
      const persisted = window.localStorage.getItem(workspaceScopeStorageKey(data.user.id));
      const requested = scope && currentToken
        ? resolveWorkspaceScopeMembership(
            persisted ?? workspaceFocusTokenRef.current,
            scope.options,
            currentToken,
          ).token
        : ALL_ACCESSIBLE_WORKSPACE_SCOPE;
      void loadWorkspaceScopeSnapshot(requested);
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
        ? navigationStateForWorkspaceScope(next, workspaceFocusTokenRef.current)
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
    setError("");
    try {
      await ensureCompleteCatalogs(["projects", "releases"], true);
      setFilterOpen(true);
      if (focusEditor) {
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>(".filter-popover input")?.focus();
        });
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Catalog could not be loaded");
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
    setError("");
    try {
      await ensureCompleteCatalogs(["projects", "releases"], true);
      setMobileActionsOpen(true);
      if (focusMobileSearch) {
        window.requestAnimationFrame(() => mobileSearchRef.current?.focus());
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Catalog could not be loaded");
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

  useEffect(() => {
    function handlePopState(event: PopStateEvent) {
      void (async () => {
        const currentData = dataRef.current;
        const target = parseNavigationPath(window.location.pathname);
        const resolved =
          resolveNavigationHistoryState(
            event.state,
            window.location.pathname,
            currentData,
          ) ?? (target ? resolveNavigationTarget(target, currentData) : null);
        if (resolved) {
          const historyScope = resolved.surface === "workspace"
            ? workspaceScopeFromHistory(event.state)
            : null;
          if (historyScope && historyScope !== workspaceFocusTokenRef.current) {
            await loadWorkspaceScopeSnapshot(historyScope, "none", false);
          }
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
  }, [data]);

  useTaskTrackerKeyboardController({
    context: {
      surface,
      data,
      activeTaskId,
      canCreateTask,
    },
    layers: {
      globalSearchOpen,
      mobileActionsOpen,
      mobileSidebarOpen,
      accountMenuOpen,
      pendingProjectMove,
      dialog,
      peekTaskId,
      filterOpen,
      displayOpen,
      contextualMenuOpen: Boolean(contextualMenu),
      recoverableDeletion,
      busy,
      systemBackupBusy,
    },
    selection: {
      highlightedTaskId,
      keyboardTaskIds,
      keyboardTaskIdsKey,
      selectableTaskIds,
      selectableTaskIdsKey,
      selected,
      surfaceContextualEntity,
      getAnchor: () => selectionAnchorRef.current,
      setAnchor: (value) => {
        selectionAnchorRef.current = value;
      },
      getPreviousTaskIds: () => previousKeyboardTaskIdsRef.current,
      setPreviousTaskIds: (value) => {
        previousKeyboardTaskIdsRef.current = value;
      },
    },
    controls: {
      setHighlightedTaskId,
      setSelected,
      setPendingProjectMove,
      setDialog,
      setPeekTaskId,
      setDisplayOpen,
      setFilterOpen,
      setMobileActionsOpen,
      setAccountMenuOpen,
      displayTriggerRef,
      filterTriggerRef,
      accountTriggerRef,
    },
    actions: {
      focusLocalSearch,
      closeContextualActions,
      closeGlobalSearch,
      closeTask,
      closeMobileSidebar,
      openGlobalSearch,
      openCreate: () => openCreate(),
      focusedContextualActionEntity,
      openContextualActions,
      toggleFilters,
      toggleSelection,
      openTask,
      toggleLayout: () => {
        const nextLayout = layout === "list" ? "board" : "list";
        const next: ResolvedNavigation = { surface, layout: nextLayout, taskId: null };
        setLayout(nextLayout);
        setActiveTaskId(null);
        taskReturnPath.current = navigationPath(next, data);
        window.history.pushState(
          navigationStateForWorkspaceScope(next, workspaceFocusTokenRef.current),
          "",
          navigationPath(next, data),
        );
      },
    },
    resetKeys: {
      search,
      temporaryQuery,
    },
  });

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
          <NavItem compact={sidebarCompact} icon={<UsersRound size={15} />} label="Teams" active={surface === "teams" || surface.startsWith("team:")} href="/teams" onNavigate={() => navigateSurface("teams", "list")} />
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
            <div className="title-actions">
              {surface === "teams" && <button className="button primary" type="button" disabled={Boolean(teamMutation)} aria-busy={teamMutation?.kind === "create" || undefined} onClick={() => { clearTeamAlert(); setDialog("teamCreate"); }}><Plus size={14} />New Team</button>}
              {activeTeamDetail?.currentMembership.role === "owner" && <button className="button ghost" type="button" disabled={Boolean(teamMutation) || teamDetailState.status !== "ready"} onClick={() => { clearTeamAlert(); setDialog("teamRename"); }}><UsersRound size={14} />Rename Team</button>}
              {activeTeamDetail?.currentMembership.role === "owner" && <button className="button primary" type="button" disabled={Boolean(teamMutation) || teamDetailState.status !== "ready"} onClick={() => { clearTeamAlert(); setDialog("teamMemberAdd"); }}><Plus size={14} />Add member</button>}
              {surface.startsWith("project:") && contextProjectRecord && <a className="button ghost" href={projectReleasesPath(contextProjectRecord.publicId)} onClick={(event) => handleLocalLink(event, () => navigateSurface(`project-releases:${contextProjectRecord.id}`, "list"))}><Rocket size={14} />Releases</a>}
              {surface.startsWith("project:") && contextProjectRecord && canEditContent(contextProjectRecord.accessRole) && <button className="button ghost" onClick={() => setDialog("projectEdit")}><FolderKanban size={14} />Edit project</button>}
              {surface.startsWith("release:") && contextReleaseRecord && canEditContent(contextReleaseRecord.accessRole) && <button className="button ghost" onClick={() => setDialog("releaseEdit")}><Rocket size={14} />Edit release</button>}
              {activeSavedView && canEditContent(activeSavedView.accessRole) && <button className="button ghost" onClick={() => void openDialogWithCatalog("viewEdit", ["projects", "releases"])}><Zap size={14} />Edit view</button>}
              {surface.startsWith("project:") && contextProjectRecord?.accessRole === "owner" && <button className="button ghost" disabled={systemBackupBusy} onClick={() => void downloadProjectBackup(contextProjectRecord)}><Download size={14} />{systemBackupBusy ? "Exporting…" : "Backup"}</button>}
              {currentShareContext && <button className="button ghost" onClick={() => setDialog("share")}><Share2 size={14} />Members &amp; access</button>}
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

        {surface === "teams" && (
          <div className="toolbar-row catalog-toolbar teams-toolbar" aria-label="Teams catalog controls">
            <div className="toolbar-left">
              <div className="search-control">
                <Search size={13} />
                <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search teams…" aria-label="Search teams" />
                {search && <button type="button" aria-label="Clear Team search" onClick={() => setSearch("")}><X size={12} /></button>}
              </div>
            </div>
          </div>
        )}

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
        {surface === "teams" ? (
          <TeamsSurface
            state={teamListState}
            query={search}
            onRetry={() => void loadTeamList()}
            onCreate={() => { clearTeamAlert(); setDialog("teamCreate"); }}
            onOpen={(publicId) => navigateSurface(`team:${publicId}`, "list")}
          />
        ) : activeTeamPublicId ? (
          <TeamDetailSurface
            state={teamDetailState}
            alert={teamAlert}
            mutation={teamMutation}
            onRetry={() => void loadTeamDetail(activeTeamPublicId)}
            onMembershipAction={(membership, action) => void changeTeamMembership(membership, action)}
            onDelete={(membership) => {
              setTeamMemberForDelete(membership);
              setDialog("teamMemberDelete");
            }}
          />
        ) : surface.startsWith("settings:") ? (
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
            focusedData={workspaceData}
            statusMap={statusMap}
            projectMap={projectMap}
            workspaceScopeToken={workspaceFocusToken}
            workspaceScopeLoading={workspaceScopeLoading}
            onWorkspaceScopeChange={(token) => void loadWorkspaceScopeSnapshot(token)}
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
        ) : surface === "admin" && data.admin ? (
          <AdminSurface
            overview={data.admin}
            timeZone={data.user.timezone}
            backupBusy={systemBackupBusy}
            exportActive={systemExport.active}
            onExport={systemExport.open}
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
        onClose={closeRecoverableDeletion}
      />}
      {deletionUndo && <DeletionUndoToast
        label={deletionUndo.label}
        busy={deletionBusy}
        onUndo={() => void undoRecoverableDelete()}
        onDismiss={dismissDeletionUndo}
      />}

      {activeTask && <div className={currentShareContext ? undefined : "details-no-share"}>{activeTask.description === null ? <TaskDetailsLoading task={activeTask} onClose={closeTask} /> : <TaskDetails key={activeTask.id} task={activeTask} data={activeDetailsData} catalogReady={taskPropertyCatalogReady} onClose={closeTask} onOpenTask={openTask} onContextActions={(x, y, focus) => openContextualActions({ entities: [taskContextualEntity(activeTask)] }, x, y, focus)} onSave={async (changes) => { const nextReleaseId = Object.hasOwn(changes, "releaseId") ? changes.releaseId as string | null : activeTask.releaseId; const confirmReleasedComposition = releasedCompositionNeedsConfirmation(activeTask.releaseId, nextReleaseId, data.releases); if (confirmReleasedComposition && !confirmReleasedCompositionChange()) return false; return mutate(`/api/tasks/${activeTask.id}`, "PATCH", { version: taskMutationVersion(activeTask), ...changes, ...(confirmReleasedComposition ? { confirmReleasedComposition: true } : {}) }); }} onMove={async (changes) => { const nextReleaseId = Object.hasOwn(changes, "releaseId") ? changes.releaseId as string | null : null; const confirmReleasedComposition = releasedCompositionNeedsConfirmation(activeTask.releaseId, nextReleaseId, data.releases); if (confirmReleasedComposition && !confirmReleasedCompositionChange()) return false; return mutate(`/api/tasks/${activeTask.id}/move`, "POST", { version: taskMutationVersion(activeTask), ...changes, ...(confirmReleasedComposition ? { confirmReleasedComposition: true } : {}) }); }} onSetParent={(parentTaskId) => mutate(`/api/tasks/${activeTask.id}/parent`, "PATCH", { version: taskMutationVersion(activeTask), parentTaskId })} onCreateSubtask={(title) => mutate(`/api/tasks/${activeTask.id}/subtasks`, "POST", { version: taskMutationVersion(activeTask), title })} onSetLabel={(labelId, active) => mutate(`/api/tasks/${activeTask.id}/labels`, "POST", { labelId, active })} onRebase={refreshTaskDetail} onRelationMutation={(tasks, dependencies) => reconcileSuccessfulTaskMutation(tasks, dataRef.current, dataRef.current, dependencies)} onShare={() => setDialog("share")} busy={busy} />}</div>}
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
      {dialog === "project" && <ProjectDialog currentUser={data.user} leadOptions={[data.user]} openTaskCount={0} onClose={() => setDialog(null)} onSubmit={async (input) => { const before = new Set(dataRef.current.projects.map((project) => project.id)); const ok = await mutate("/api/projects", "POST", input); if (!ok) return; const created = dataRef.current.projects.find((project) => !before.has(project.id)); setDialog(null); if (created) { const next = { surface: `project:${created.id}`, layout: "list" as const, taskId: null }; setSurface(next.surface); setLayout(next.layout); setActiveTaskId(null); const path = `/projects/${encodeURIComponent(created.publicId)}`; taskReturnPath.current = path; window.history.pushState(navigationStateForWorkspaceScope(next, workspaceFocusTokenRef.current), "", path); } }} busy={busy} />}
      {dialog === "projectEdit" && contextProjectRecord && <ProjectDialog project={contextProjectRecord} currentUser={data.user} leadOptions={projectMemberOptions(data, contextProjectRecord)} openTaskCount={openProjectTaskCount(contextProjectRecord.id, data.tasks, statusMap)} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate(`/api/projects/${contextProjectRecord.id}`, "PATCH", { version: contextProjectRecord.version, ...input }); if (ok) setDialog(null); }} onArchive={async () => { const ok = await mutate(`/api/projects/${contextProjectRecord.id}`, "PATCH", { version: contextProjectRecord.version, archived: !contextProjectRecord.archivedAt }); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "release" && <ReleaseDialog projects={data.projects.filter((project) => !project.archivedAt && canEditContent(project.accessRole))} initialProjectId={contextProject} openTaskCount={0} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/releases", "POST", input); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "releaseEdit" && contextReleaseRecord && <ReleaseDialog release={contextReleaseRecord} projects={data.projects.filter((project) => project.id === contextReleaseRecord.projectId)} initialProjectId={contextReleaseRecord.projectId} openTaskCount={openReleaseTaskCount(contextReleaseRecord.id, data.tasks, statusMap)} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate(`/api/releases/${contextReleaseRecord.id}`, "PATCH", { version: contextReleaseRecord.version, ...input }); if (ok) setDialog(null); }} onDelete={() => void openRecoverableDelete(releaseContextualEntity(contextReleaseRecord))} busy={busy} />}
      {dialog === "view" && canSaveView && <ViewDialog view={activeSavedView} editing={false} query={currentViewQuery} display={currentDisplay} data={data} initialScopeProjectId={activeSavedView?.scopeProjectId ?? contextProject} temporaryFilterCount={0} submissionError={error} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/views", "POST", input); if (ok) setDialog(null); return ok; }} busy={busy} />}
      {dialog === "viewEdit" && activeSavedView && canSaveView && <ViewDialog key={activeSavedView.id} view={activeSavedView} editing query={activeSavedView.query} display={activeSavedView.display} data={data} initialScopeProjectId={activeSavedView.scopeProjectId} temporaryFilterCount={queryFilterCount(temporaryViewQuery)} submissionError={error} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate(`/api/views/${activeSavedView.id}`, "PATCH", { version: activeSavedView.version, ...input }, { onConflict: refreshSavedViewsAfterConflict, conflictMessage: "This Saved View changed in another session. The latest saved version was reloaded; review it and try again." }); if (ok) { setDialog(null); setDisplayOverrides((current) => { const next = { ...current }; delete next[surface]; return next; }); const savedDisplay = input.display as ViewDisplay; if (savedDisplay.layout !== layout) changeLayout(savedDisplay.layout); } return ok; }} busy={busy} />}
      {dialog === "share" && currentShareContext && <ShareDialog key={currentShareContext.key} context={currentShareContext} currentUser={data.user} users={data.users} collaborators={data.collaborators} onClose={() => setDialog(null)} onShare={(input) => mutate("/api/shares", "POST", input)} onRoleChange={(grantId, permission) => mutate("/api/shares", "PATCH", { grantId, permission })} onRevoke={(grantId) => mutate("/api/shares", "DELETE", { grantId })} onTransfer={(projectId, targetUserId) => mutate("/api/shares/transfer", "POST", { projectId, targetUserId })} busy={busy} />}
      {dialog === "systemExport" && <SystemBackupExportDialog
        status={systemExport.status}
        busy={systemExport.running}
        waitingForNetwork={systemExport.waitingForNetwork}
        error={systemExport.error}
        onClose={() => setDialog(null)}
        onStart={(fresh) => void systemExport.start(fresh)}
        onResume={systemExport.resume}
      />}
      {dialog === "systemImport" && <SystemImportDialog onClose={() => setDialog(null)} onBusyChange={setAuxiliaryBackupBusy} onApplied={() => window.location.assign("/admin")} />}
      {dialog === "codexSetup" && <CodexSetupDialog onClose={() => setDialog(null)} />}
      {dialog === "workflowSettings" && <WorkflowSettingsDialog initialStatuses={data.statuses.filter((status) => status.ownerUserId === data.user.id)} onClose={() => setDialog(null)} onStatuses={(statuses) => setData((current) => ({ ...current, statuses: [...current.statuses.filter((status) => status.ownerUserId !== current.user.id), ...statuses] }))} />}
      {dialog === "labelSettings" && <LabelSettingsDialog onClose={() => setDialog(null)} onLabels={(labels) => setData((current) => ({ ...current, labels: [...current.labels.filter((label) => label.ownerUserId !== current.user.id), ...labels] }))} onGroups={(labelGroups) => setData((current) => ({ ...current, labelGroups: [...(current.labelGroups ?? []).filter((group) => group.ownerUserId !== current.user.id), ...labelGroups] }))} />}
      {dialog === "labelGroupSettings" && <LabelGroupSettingsDialog initialGroups={(data.labelGroups ?? []).filter((group) => group.ownerUserId === data.user.id)} initialLabels={data.labels.filter((label) => label.ownerUserId === data.user.id)} onClose={() => setDialog(null)} onGroups={(labelGroups) => setData((current) => ({ ...current, labelGroups: [...(current.labelGroups ?? []).filter((group) => group.ownerUserId !== current.user.id), ...labelGroups] }))} onLabels={(labels) => setData((current) => ({ ...current, labels: [...current.labels.filter((label) => label.ownerUserId !== current.user.id), ...labels] }))} />}
      {dialog === "bulkProject" && selectedTasks.length > 0 && <BulkProjectDialog data={data} tasks={selectedTasks} busy={busy} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/tasks/bulk", "POST", { ids: [...selected], versions: selectedTaskVersions, field: "projectId", value: input.targetProjectId, clearRelease: input.clearRelease, clearAssignee: input.clearAssignee, confirmReleasedComposition: input.confirmReleasedComposition }); if (ok) { setDialog(null); setSelected(new Set()); } }} />}
      {dialog === "bulkRelease" && selectedTasks.length > 0 && <BulkReleaseDialog data={data} tasks={selectedTasks} busy={busy} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/tasks/bulk", "POST", { ids: [...selected], versions: selectedTaskVersions, field: "releaseId", value: input.releaseId, confirmReleasedComposition: input.confirmReleasedComposition }); if (ok) { setDialog(null); setSelected(new Set()); } }} />}
      {dialog === "teamCreate" && <TeamNameDialog title="Create Team" submitLabel="Create Team" error={teamAlert} busy={teamMutation?.kind === "create"} onClose={() => setDialog(null)} onSubmit={createTeam} />}
      {dialog === "teamRename" && activeTeamDetail?.currentMembership.role === "owner" && <TeamNameDialog title="Rename Team" submitLabel="Save name" initialName={activeTeamDetail.team.name} error={teamAlert} busy={teamMutation?.kind === "rename"} onClose={() => setDialog(null)} onSubmit={async (name) => { const ok = await renameTeam(name); if (ok) setDialog(null); return ok; }} />}
      {dialog === "teamMemberAdd" && activeTeamDetail?.currentMembership.role === "owner" && <TeamMemberDialog error={teamAlert} busy={teamMutation?.kind === "add"} onClose={() => setDialog(null)} onSubmit={async (email) => { const ok = await addTeamMember(email); if (ok) setDialog(null); return ok; }} />}
      {dialog === "teamMemberDelete" && activeTeamDetail?.currentMembership.role === "owner" && teamMemberForDelete && <TeamMemberDeleteDialog membership={teamMemberForDelete} error={teamAlert} busy={teamMutation?.kind === "delete" && teamMutation.key === teamMemberForDelete.id} onClose={() => { setDialog(null); setTeamMemberForDelete(null); }} onConfirm={async () => { const ok = await deleteTeamMembership(teamMemberForDelete); if (ok) { setDialog(null); setTeamMemberForDelete(null); } return ok; }} />}
    </main>
  );
}
