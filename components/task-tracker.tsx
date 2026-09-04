"use client";

import {
  useRef,
  useState,
} from "react";
import {
  canEditContent,
} from "@/lib/access";
import type { ResolvedNavigation } from "@/lib/navigation";
import {
  ALL_ACCESSIBLE_WORKSPACE_SCOPE,
} from "@/lib/workspace-scope";
import { useTaskTrackerQueryController } from "@/components/task-tracker-query-controller";
import { useSystemExportController } from "@/components/task-tracker-system-export";
import { useTeamsController } from "@/components/task-tracker-teams-controller";
import { useWorkspaceCatalogController } from "@/components/task-tracker-catalog-controller";
import { useTaskTrackerDeletionIntegrationController } from "@/components/task-tracker-deletion-integration-controller";
import { useTaskTrackerMutationController } from "@/components/task-tracker-mutation-controller";
import { useTaskTrackerKeyboardController } from "@/components/task-tracker-keyboard-controller";
import { useTaskTrackerContextualActions } from "@/components/task-tracker-contextual-actions";
import { useTaskTrackerGroupingController } from "@/components/task-tracker-grouping-controller";
import { useTaskTrackerNavigationController } from "@/components/task-tracker-navigation-controller";
import { TaskTrackerSurfaceRouter } from "@/components/task-tracker-surface-router";
import { TaskTrackerSidebar } from "@/components/task-tracker-sidebar";
import { TaskTrackerHeader } from "@/components/task-tracker-header";
import { TaskTrackerOverlayHost } from "@/components/task-tracker-overlay-host";
import { useTaskTrackerSyncController } from "@/components/task-tracker-sync-controller";
import {
  useTaskTrackerDetailController,
  useTaskTrackerDetailState,
} from "@/components/task-tracker-detail-controller";
import {
  useTaskTrackerShellController,
  useTaskTrackerShellState,
} from "@/components/task-tracker-shell-controller";
import { useTaskTrackerViewModel } from "@/components/task-tracker-view-model";
import {
  selectTaskRange,
  toggleTaskSelection,
} from "@/lib/task-keyboard";
import type {
  AppSnapshot,
  ViewDisplay,
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
export {
  AccountMenu,
  nextAccountMenuFocusIndex,
} from "@/components/task-tracker-sidebar";

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
  const shell = useTaskTrackerShellState(initialData);
  const {
    globalSearchOpen,
    dialog,
    setDialog,
    createDefaults,
    peekTaskId,
    setPeekTaskId,
    sidebarCollapsed,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    mobileActionsOpen,
    setMobileActionsOpen,
    filterOpen,
    setFilterOpen,
    displayOpen,
    setDisplayOpen,
    accountMenuOpen,
    setAccountMenuOpen,
    auxiliaryBackupBusy,
    setAuxiliaryBackupBusy,
    error,
    setError,
    theme,
    searchRef,
    mobileSearchRef,
    accountMenuRef,
    mobileActionsRef,
    accountTriggerRef,
    filterTriggerRef,
    displayTriggerRef,
    mobileMenuRef,
    mobileSidebarCloseRef,
  } = shell;
  const {
    taskDetail,
    setTaskDetail,
    forcedTaskDetailId,
    setForcedTaskDetailId,
  } = useTaskTrackerDetailState();
  const [displayOverrides, setDisplayOverrides] = useState<Partial<Record<string, ViewDisplay>>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [highlightedTaskId, setHighlightedTaskId] = useState<string | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const previousKeyboardTaskIdsRef = useRef<string[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const {
    workspaceData,
    setWorkspaceData,
    workspaceDataRef,
    workspaceFocusToken,
    workspaceFocusTokenRef,
    workspaceScopeLoading,
    surface,
    layout,
    search,
    setSearch,
    temporaryQuery,
    setTemporaryQuery,
    activeTaskId,
    loadWorkspaceScopeSnapshot,
    applyNavigation,
    navigateSurface,
    changeLayout,
    openTask,
    closeTask,
    returnToWorkspaceAfterRemoval,
  } = useTaskTrackerNavigationController({
    initialData,
    initialWorkspaceData,
    initialNavigation,
    data,
    dataRef,
    setTaskDetail,
    setForcedTaskDetailId,
    setPeekTaskId,
    closeSurfaceUi: () => {
      setMobileSidebarOpen(false);
      setMobileActionsOpen(false);
    },
    closeLayoutUi: () => setMobileActionsOpen(false),
    onError: setError,
  });
  const {
    activeSavedView,
    currentDisplay,
    currentGroupBy,
    currentDisplayDependencies,
    canonicalTemporaryQuery,
    temporaryViewQuery,
    currentViewQuery,
    searchNeedle,
    taskQueryKey,
    taskSearch,
    setTaskSearch,
    taskQueryPaging,
    taskWindowLoading,
    pullRefreshing,
    pullRefreshError,
    taskPool,
    visibleTasks,
    taskSearchStatus,
    captureSyncCheckpoint,
    reconcileIncrementalTasks,
    completeTaskWindow,
    invalidateQuery,
    refreshTaskList,
    loadMoreFilteredTasks,
    reconcileSuccessfulTaskMutation,
  } = useTaskTrackerQueryController({
    initialTaskWindowTruncated: Boolean(initialData.taskWindow?.truncated),
    data,
    dataRef,
    setData,
    surface,
    layout,
    search,
    temporaryQuery,
    displayOverrides,
    workspaceScopeToken,
    workspaceScopeTokenRef,
    onError: setError,
  });
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
    recentlyDeletedEpoch,
    setRecentlyDeletedEpoch,
    refreshAfterDeletionMutation,
  } = useTaskTrackerDeletionIntegrationController({
    dataRef,
    setData,
    setSelected,
    setTaskSearch,
    setTaskDetail,
    setForcedTaskDetailId,
    setPeekTaskId,
    invalidateQuery,
    invalidateCatalogs,
    refreshTaskList,
    activeTaskId,
    surface,
    closeTask,
    navigateSurface,
    workspaceScopeTokenRef,
    setDialog,
    onError: setError,
  });
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
  useTaskTrackerSyncController({
    data,
    setData,
    setSelected,
    setPeekTaskId,
    setTaskDetail,
    setForcedTaskDetailId,
    activeTaskId,
    surface,
    workspaceScopeToken,
    captureSyncCheckpoint,
    reconcileIncrementalTasks,
    completeTaskWindow,
    invalidateQuery,
    invalidateCatalogs,
    setRecentlyDeletedEpoch,
    returnToWorkspaceAfterRemoval,
  });
  const {
    activeTask,
    peekTask,
    activeDetailsData,
    taskPropertyCatalogReady,
  } = useTaskTrackerDetailController({
    data,
    dataRef,
    setData,
    taskPool,
    activeTaskId,
    peekTaskId,
    taskDetail,
    setTaskDetail,
    forcedTaskDetailId,
    setForcedTaskDetailId,
    workspaceScopeToken,
    ensureCompleteCatalogs,
    returnToWorkspaceAfterRemoval,
    onError: setError,
  });
  const {
    statusMap,
    projectMap,
    releaseMap,
    userMap,
    sidebarViews,
    sidebarProjects,
    sidebarReleases,
    breadcrumbs,
    selectedTasks,
    selectedTaskVersions,
    archiveAction,
    projectReleaseSurfaceId,
    contextRelease,
    contextReleaseRecord,
    contextProject,
    contextProjectRecord,
    scopedReleases,
    surfaceCount,
    surfaceContextualEntity,
    currentShareContext,
    canCreateTask,
    canSaveView,
    sidebarCompact,
    searchLabel,
    hasTemporaryFilters,
    hasDisplayChanges,
    hasRuntimeViewChanges,
  } = useTaskTrackerViewModel({
    data,
    surface,
    search,
    sidebarCollapsed,
    mobileSidebarOpen,
    activeSavedView,
    activeTeamPublicId,
    activeTeamDetail,
    teamCount: teamListState.value?.teams.length,
    catalogPages,
    visibleTasks,
    activeTask,
    selected,
    currentDisplay,
    canonicalTemporaryQuery,
  });
  const {
    taskGroups,
    keyboardTaskIds,
    selectableTaskIds,
    keyboardTaskIdsKey,
    selectableTaskIdsKey,
    createAssigneeUserIds,
    pendingProjectMove,
    setPendingProjectMove,
    moveTaskToGroup,
  } = useTaskTrackerGroupingController({
    data,
    visibleTasks,
    taskPool,
    userMap,
    contextProject,
    contextProjectRecord,
    display: currentDisplay,
    layout,
    collapsedGroups,
    draggingTaskId,
    mutate,
    updateClientTask,
    onError: setError,
  });

  const {
    applyUserProfile,
    saveUserPreferences,
    openDialogWithCatalog,
    openCreate,
    toggleFilters,
    openGlobalSearch,
    closeGlobalSearch,
    openGlobalSearchResult,
    toggleMobileViewControls,
    focusLocalSearch,
    closeMobileSidebar,
    changeGroupBy,
    changeDisplay,
    clearTemporaryFilters,
    resetDisplayChanges,
    downloadProjectBackup,
    copyCurrentLink,
  } = useTaskTrackerShellController({
    shell,
    data,
    dataRef,
    setData,
    surface,
    layout,
    activeTaskId,
    activeSavedView,
    currentDisplay,
    canCreateTask,
    setDisplayOverrides,
    setCollapsedGroups,
    setSearch,
    setTemporaryQuery,
    setTaskDetail,
    setForcedTaskDetailId,
    ensureCompleteCatalogs,
    applyNavigation,
  });
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
        changeLayout(nextLayout);
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
      {mobileSidebarOpen && (
        <button
          className="mobile-sidebar-backdrop"
          type="button"
          aria-label="Close navigation"
          onMouseDown={(event) => event.preventDefault()}
          onClick={closeMobileSidebar}
        />
      )}
      <TaskTrackerSidebar
        data={data}
        surface={surface}
        compact={sidebarCompact}
        mobileOpen={mobileSidebarOpen}
        mobileCloseRef={mobileSidebarCloseRef}
        accountMenuRef={accountMenuRef}
        accountTriggerRef={accountTriggerRef}
        accountMenuOpen={accountMenuOpen}
        setAccountMenuOpen={setAccountMenuOpen}
        signOutPath={signOutPath}
        sidebarViews={sidebarViews}
        sidebarProjects={sidebarProjects}
        sidebarReleases={sidebarReleases}
        statusMap={statusMap}
        projectMap={projectMap}
        navigateSurface={navigateSurface}
        openCreate={openCreate}
        openGlobalSearch={openGlobalSearch}
        closeMobileSidebar={closeMobileSidebar}
        openDialogWithCatalog={openDialogWithCatalog}
        openProjectDialog={() => setDialog("project")}
        openContextualActions={openContextualActions}
      />

      <section className="main-surface">
        <TaskTrackerHeader
          data={data}
          surface={surface}
          layout={layout}
          breadcrumbs={breadcrumbs}
          surfaceCount={surfaceCount}
          sidebarCollapsed={sidebarCollapsed}
          mobileSidebarOpen={mobileSidebarOpen}
          mobileMenuRef={mobileMenuRef}
          searchRef={searchRef}
          filterTriggerRef={filterTriggerRef}
          displayTriggerRef={displayTriggerRef}
          mobileActionsRef={mobileActionsRef}
          mobileSearchRef={mobileSearchRef}
          search={search}
          setSearch={setSearch}
          searchLabel={searchLabel}
          filterOpen={filterOpen}
          setFilterOpen={setFilterOpen}
          displayOpen={displayOpen}
          setDisplayOpen={setDisplayOpen}
          mobileActionsOpen={mobileActionsOpen}
          setMobileActionsOpen={setMobileActionsOpen}
          catalogLoading={catalogLoading}
          catalogOrder={catalogOrder}
          setCatalogOrder={setCatalogOrder}
          catalogDirection={catalogDirection}
          setCatalogDirection={setCatalogDirection}
          activeSavedView={activeSavedView}
          contextProject={contextProject}
          contextProjectRecord={contextProjectRecord}
          contextReleaseRecord={contextReleaseRecord}
          activeTeamDetail={activeTeamDetail}
          teamDetailState={teamDetailState}
          teamMutation={teamMutation}
          currentDisplay={currentDisplay}
          currentGroupBy={currentGroupBy}
          currentDisplayDependencies={currentDisplayDependencies}
          canonicalTemporaryQuery={canonicalTemporaryQuery}
          currentViewQuery={currentViewQuery}
          hasTemporaryFilters={hasTemporaryFilters}
          hasDisplayChanges={hasDisplayChanges}
          hasRuntimeViewChanges={hasRuntimeViewChanges}
          canCreateTask={canCreateTask}
          canSaveView={canSaveView}
          hasShareContext={Boolean(currentShareContext)}
          surfaceContextualEntity={surfaceContextualEntity}
          systemBackupBusy={systemBackupBusy}
          setDialog={setDialog}
          setMobileSidebarOpen={setMobileSidebarOpen}
          saveUserPreferences={saveUserPreferences}
          closeMobileSidebar={closeMobileSidebar}
          navigateSurface={navigateSurface}
          changeLayout={changeLayout}
          changeGroupBy={changeGroupBy}
          changeDisplay={changeDisplay}
          clearTemporaryFilters={clearTemporaryFilters}
          resetDisplayChanges={resetDisplayChanges}
          toggleFilters={toggleFilters}
          toggleMobileViewControls={toggleMobileViewControls}
          setTemporaryQuery={setTemporaryQuery}
          openCreate={openCreate}
          openDialogWithCatalog={openDialogWithCatalog}
          clearTeamAlert={clearTeamAlert}
          downloadProjectBackup={downloadProjectBackup}
          openContextualActions={openContextualActions}
          copyCurrentLink={copyCurrentLink}
        />
        <TaskTrackerSurfaceRouter
          data={data}
          setData={setData}
          surface={surface}
          layout={layout}
          search={search}
          error={error}
          onClearError={() => setError("")}
          deletionConvergenceError={deletionConvergenceError}
          deletionBusy={deletionBusy}
          retryDeletionConvergence={retryDeletionConvergence}
          taskWindowLoading={taskWindowLoading}
          searchNeedle={searchNeedle}
          busy={busy}
          statusMap={statusMap}
          projectMap={projectMap}
          releaseMap={releaseMap}
          userMap={userMap}
          contextProjectRecord={contextProjectRecord}
          contextReleaseRecord={contextReleaseRecord}
          projectReleaseSurfaceId={projectReleaseSurfaceId}
          scopedReleases={scopedReleases}
          catalog={{ pages: catalogPages, loading: catalogLoading, order: catalogOrder, direction: catalogDirection, setOrder: setCatalogOrder, setDirection: setCatalogDirection, ensureComplete: ensureCompleteCatalogs, invalidate: invalidateCatalogs, loadMore: loadMoreCatalog }}
          teams={{ listState: teamListState, detailState: teamDetailState, mutation: teamMutation, alert: teamAlert, loadList: loadTeamList, loadDetail: loadTeamDetail, changeMembership: changeTeamMembership, setMemberForDelete: setTeamMemberForDelete }}
          activeTeamPublicId={activeTeamPublicId}
          clearTeamAlert={clearTeamAlert}
          theme={theme}
          sidebarCollapsed={sidebarCollapsed}
          signOutPath={signOutPath}
          applyUserProfile={applyUserProfile}
          saveUserPreferences={(changes) => void saveUserPreferences(changes)}
          recentlyDeletedEpoch={recentlyDeletedEpoch}
          refreshAfterDeletionMutation={refreshAfterDeletionMutation}
          workspaceData={workspaceData}
          workspaceFocusToken={workspaceFocusToken}
          workspaceScopeLoading={workspaceScopeLoading}
          loadWorkspaceScopeSnapshot={loadWorkspaceScopeSnapshot}
          navigateSurface={navigateSurface}
          openTask={openTask}
          openCreate={openCreate}
          openDialogWithCatalog={openDialogWithCatalog}
          setDialog={setDialog}
          systemBackupBusy={systemBackupBusy}
          systemExport={systemExport}
          mutate={mutate}
          taskSearchStatus={taskSearchStatus}
          visibleTasks={visibleTasks}
          grouping={{ taskGroups, createAssigneeUserIds, moveTaskToGroup }}
          currentDisplay={currentDisplay}
          selected={selected}
          highlightedTaskId={highlightedTaskId}
          setHighlightedTaskId={setHighlightedTaskId}
          toggleSelection={toggleSelection}
          openTaskContextualActions={openTaskContextualActions}
          openContextualActions={openContextualActions}
          setDraggingTaskId={setDraggingTaskId}
          collapsedGroups={collapsedGroups}
          setCollapsedGroups={setCollapsedGroups}
          taskSearchHasMore={taskSearch?.query === taskQueryKey && Boolean(taskSearch.page?.hasMore)}
          taskQueryPaging={taskQueryPaging}
          loadMoreFilteredTasks={loadMoreFilteredTasks}
          pullRefreshing={pullRefreshing}
          pullRefreshError={pullRefreshError}
          refreshTaskList={refreshTaskList}
        />
      </section>

      <TaskTrackerOverlayHost
        data={data}
        setData={setData}
        dataRef={dataRef}
        surface={surface}
        layout={layout}
        globalSearchOpen={globalSearchOpen}
        closeGlobalSearch={closeGlobalSearch}
        openGlobalSearchResult={openGlobalSearchResult}
        selected={selected}
        setSelected={setSelected}
        selectedTasks={selectedTasks}
        selectedTaskVersions={selectedTaskVersions}
        archiveAction={archiveAction}
        contextual={{ menu: contextualMenu, execute: executeContextualAction, close: closeContextualActions, open: openContextualActions }}
        deletion={{ pending: recoverableDeletion, undo: deletionUndo, busy: deletionBusy, confirm: deleteRecoverably, undoDelete: undoRecoverableDelete, closePending: closeRecoverableDeletion, dismissUndo: dismissDeletionUndo, open: openRecoverableDelete }}
        activeTask={activeTask}
        activeDetailsData={activeDetailsData}
        taskPropertyCatalogReady={taskPropertyCatalogReady}
        pendingMoveTask={pendingMoveTask}
        pendingMoveSourceProject={pendingMoveSourceProject}
        pendingMoveTargetProject={pendingMoveTargetProject}
        pendingMoveParent={pendingMoveParent}
        pendingMoveSubtasks={pendingMoveSubtasks}
        setPendingProjectMove={setPendingProjectMove}
        peekTask={peekTask}
        setPeekTaskId={setPeekTaskId}
        dialog={dialog}
        setDialog={setDialog}
        createDefaults={createDefaults}
        contextProject={contextProject}
        contextRelease={contextRelease}
        contextProjectRecord={contextProjectRecord}
        contextReleaseRecord={contextReleaseRecord}
        activeSavedView={activeSavedView}
        currentShareContext={currentShareContext}
        canCreateTask={canCreateTask}
        canSaveView={canSaveView}
        currentViewQuery={currentViewQuery}
        temporaryViewQuery={temporaryViewQuery}
        currentDisplay={currentDisplay}
        error={error}
        statusMap={statusMap}
        projectMap={projectMap}
        busy={busy}
        systemExport={systemExport}
        setAuxiliaryBackupBusy={setAuxiliaryBackupBusy}
        activeTeamDetail={activeTeamDetail}
        teamMemberForDelete={teamMemberForDelete}
        teamMutation={teamMutation}
        teamAlert={teamAlert}
        setTeamMemberForDelete={setTeamMemberForDelete}
        mutate={mutate}
        createTaskForComposer={createTaskForComposer}
        refreshTaskDetail={refreshTaskDetail}
        refreshSavedViewsAfterConflict={refreshSavedViewsAfterConflict}
        reconcileSuccessfulTaskMutation={reconcileSuccessfulTaskMutation}
        openDialogWithCatalog={openDialogWithCatalog}
        closeTask={closeTask}
        openTask={openTask}
        changeLayout={changeLayout}
        applyNavigation={applyNavigation}
        setDisplayOverrides={setDisplayOverrides}
        createTeam={createTeam}
        renameTeam={renameTeam}
        addTeamMember={addTeamMember}
        deleteTeamMembership={deleteTeamMembership}
      />
    </main>
  );
}
