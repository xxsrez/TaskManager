"use client";

import {
  type ComponentProps,
  type Dispatch,
  type SetStateAction,
} from "react";
import { X } from "lucide-react";
import { canEditContent } from "@/lib/access";
import type { Layout } from "@/lib/navigation";
import { taskMutationVersion } from "@/lib/task-detail-reconciliation";
import type {
  AppSnapshot,
  ProjectRecord,
  ReleaseRecord,
  TaskRecord,
  UserProfile,
  UserRecord,
  ViewDisplay,
  WorkflowStatusRecord,
  WorkspaceCatalogKind,
} from "@/lib/types";
import type { Dialog, TaskCreateDefaults } from "@/components/task-tracker-state";
import type { useTaskTrackerContextualActions } from "@/components/task-tracker-contextual-actions";
import type { useTaskTrackerGroupingController } from "@/components/task-tracker-grouping-controller";
import type { useSystemExportController } from "@/components/task-tracker-system-export";
import type { useTeamsController } from "@/components/task-tracker-teams-controller";
import type { useWorkspaceCatalogController } from "@/components/task-tracker-catalog-controller";
import {
  AdminSurface,
  CatalogPagination,
  ProjectOverview,
  ProjectsSurface,
  ReleaseOverview,
  ReleasesSurface,
  SettingsSurface,
  SharedWithMeSurface,
  TaskBoard,
  TaskList,
  TaskQueryPagination,
  TaskSearchNotice,
  TeamDetailSurface,
  TeamsSurface,
  ViewsSurface,
  WorkspaceOverviewSurface,
  projectContextualEntity,
  releaseContextualEntity,
  toggleSet,
  viewContextualEntity,
} from "@/components/task-tracker-view";
import { DeletionConvergenceAlert } from "@/components/recently-deleted-manager";

type CatalogController = ReturnType<typeof useWorkspaceCatalogController>;
type TeamsController = ReturnType<typeof useTeamsController>;
type GroupingController = ReturnType<typeof useTaskTrackerGroupingController>;
type SystemExportController = ReturnType<typeof useSystemExportController>;
type OpenContextualActions = ReturnType<typeof useTaskTrackerContextualActions>["open"];
type Mutate = (
  path: string,
  method: string,
  body: unknown,
  options?: { onConflict?: () => Promise<void>; conflictMessage?: string },
) => Promise<boolean>;

export function TaskTrackerSurfaceRouter({
  data,
  setData,
  surface,
  layout,
  search,
  error,
  onClearError,
  deletionConvergenceError,
  deletionBusy,
  retryDeletionConvergence,
  taskWindowLoading,
  searchNeedle,
  busy,
  statusMap,
  projectMap,
  releaseMap,
  userMap,
  contextProjectRecord,
  contextReleaseRecord,
  projectReleaseSurfaceId,
  scopedReleases,
  catalog,
  teams,
  activeTeamPublicId,
  theme,
  sidebarCollapsed,
  signOutPath,
  applyUserProfile,
  saveUserPreferences,
  recentlyDeletedEpoch,
  refreshAfterDeletionMutation,
  workspaceData,
  workspaceFocusToken,
  workspaceScopeLoading,
  loadWorkspaceScopeSnapshot,
  navigateSurface,
  openTask,
  openCreate,
  openDialogWithCatalog,
  setDialog,
  systemBackupBusy,
  systemExport,
  mutate,
  taskSearchStatus,
  visibleTasks,
  grouping,
  currentDisplay,
  selected,
  highlightedTaskId,
  setHighlightedTaskId,
  toggleSelection,
  openTaskContextualActions,
  openContextualActions,
  setDraggingTaskId,
  collapsedGroups,
  setCollapsedGroups,
  taskSearchHasMore,
  taskQueryPaging,
  loadMoreFilteredTasks,
  pullRefreshing,
  pullRefreshError,
  refreshTaskList,
  clearTeamAlert,
}: {
  data: AppSnapshot;
  setData: Dispatch<SetStateAction<AppSnapshot>>;
  surface: string;
  layout: Layout;
  search: string;
  error: string;
  onClearError: () => void;
  deletionConvergenceError: string;
  deletionBusy: boolean;
  retryDeletionConvergence: () => Promise<unknown>;
  taskWindowLoading: boolean;
  searchNeedle: string;
  busy: boolean;
  statusMap: Map<string, WorkflowStatusRecord>;
  projectMap: Map<string, ProjectRecord>;
  releaseMap: Map<string, ReleaseRecord>;
  userMap: Map<string, UserRecord>;
  contextProjectRecord: ProjectRecord | undefined;
  contextReleaseRecord: ReleaseRecord | undefined;
  projectReleaseSurfaceId: string | null;
  scopedReleases: ReleaseRecord[];
  catalog: CatalogController;
  teams: Pick<
    TeamsController,
    | "listState"
    | "detailState"
    | "mutation"
    | "alert"
    | "loadList"
    | "loadDetail"
    | "changeMembership"
    | "setMemberForDelete"
  >;
  activeTeamPublicId: string | null;
  theme: "system" | "light" | "dark";
  sidebarCollapsed: boolean;
  signOutPath: string;
  applyUserProfile: (profile: UserProfile) => void;
  saveUserPreferences: ComponentProps<typeof SettingsSurface>["onAppearance"];
  recentlyDeletedEpoch: number;
  refreshAfterDeletionMutation: () => Promise<AppSnapshot>;
  workspaceData: AppSnapshot;
  workspaceFocusToken: string;
  workspaceScopeLoading: boolean;
  loadWorkspaceScopeSnapshot: (token: string) => Promise<boolean>;
  navigateSurface: (surface: string, layout?: Layout) => void;
  openTask: (taskId: string) => void;
  openCreate: (defaults?: TaskCreateDefaults) => Promise<void>;
  openDialogWithCatalog: (
    dialog: Exclude<Dialog, null>,
    kinds: readonly WorkspaceCatalogKind[],
  ) => Promise<void>;
  setDialog: Dispatch<SetStateAction<Dialog>>;
  systemBackupBusy: boolean;
  systemExport: Pick<SystemExportController, "active" | "open">;
  mutate: Mutate;
  taskSearchStatus: "loading" | "error" | null;
  visibleTasks: TaskRecord[];
  grouping: Pick<
    GroupingController,
    "taskGroups" | "createAssigneeUserIds" | "moveTaskToGroup"
  >;
  currentDisplay: ViewDisplay;
  selected: Set<string>;
  highlightedTaskId: string | null;
  setHighlightedTaskId: Dispatch<SetStateAction<string | null>>;
  toggleSelection: (taskId: string, extendRange?: boolean) => void;
  openTaskContextualActions: ComponentProps<typeof TaskList>["onContextActions"];
  openContextualActions: OpenContextualActions;
  setDraggingTaskId: Dispatch<SetStateAction<string | null>>;
  collapsedGroups: Set<string>;
  setCollapsedGroups: Dispatch<SetStateAction<Set<string>>>;
  taskSearchHasMore: boolean;
  taskQueryPaging: boolean;
  loadMoreFilteredTasks: () => Promise<void>;
  pullRefreshing: boolean;
  pullRefreshError: string;
  refreshTaskList: () => Promise<AppSnapshot>;
  clearTeamAlert: () => void;
}) {
  const canCreateTask = contextProjectRecord
    ? !contextProjectRecord.archivedAt && canEditContent(contextProjectRecord.accessRole)
    : data.projects.some((project) => !project.archivedAt && canEditContent(project.accessRole));
  const commonTaskSurface = {
    tasks: visibleTasks,
    hierarchyTasks: data.tasks,
    groups: grouping.taskGroups,
    groupBy: currentDisplay.groupBy,
    visibleFields: currentDisplay.visibleFields,
    canReorder: currentDisplay.orderBy === "manual",
    canMoveGroups: currentDisplay.groupBy !== "none",
    statuses: statusMap,
    projects: projectMap,
    releases: releaseMap,
    users: userMap,
    labelContext: data,
    selected,
    highlightedTaskId,
    canCreate: canCreateTask,
    createOwnerUserId: contextProjectRecord?.ownerUserId ?? data.user.id,
    createAssigneeUserIds: grouping.createAssigneeUserIds,
    onSelect: toggleSelection,
    onHighlight: setHighlightedTaskId,
    onOpen: openTask,
    onContextActions: openTaskContextualActions,
    onCreate: (defaults?: TaskCreateDefaults) => void openCreate(defaults),
    onMove: grouping.moveTaskToGroup,
    onDragState: setDraggingTaskId,
  };
  const pagination = taskSearchHasMore
    ? <TaskQueryPagination busy={taskQueryPaging} onMore={() => void loadMoreFilteredTasks()} />
    : null;

  return (
    <>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={onClearError}><X size={14} /></button></div>}
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
        <TeamsSurface state={teams.listState} query={search} onRetry={() => void teams.loadList()} onCreate={() => { clearTeamAlert(); setDialog("teamCreate"); }} onOpen={(publicId) => navigateSurface(`team:${publicId}`, "list")} />
      ) : activeTeamPublicId ? (
        <TeamDetailSurface state={teams.detailState} alert={teams.alert} mutation={teams.mutation} onRetry={() => void teams.loadDetail(activeTeamPublicId)} onMembershipAction={(membership, action) => void teams.changeMembership(membership, action)} onDelete={(membership) => { teams.setMemberForDelete(membership); setDialog("teamMemberDelete"); }} />
      ) : surface.startsWith("settings:") ? (
        <SettingsSurface section={surface.slice("settings:".length)} data={data} theme={theme} sidebarCollapsed={sidebarCollapsed} signOutPath={signOutPath} onNavigate={(section) => navigateSurface(`settings:${section}`, "list")} onProfile={applyUserProfile} onAppearance={saveUserPreferences} onStatuses={(statuses) => setData((current) => ({ ...current, statuses: [...current.statuses.filter((status) => status.ownerUserId !== current.user.id), ...statuses] }))} onLabels={(labels) => setData((current) => ({ ...current, labels: [...current.labels.filter((label) => label.ownerUserId !== current.user.id), ...labels] }))} onGroups={(labelGroups) => setData((current) => ({ ...current, labelGroups: [...(current.labelGroups ?? []).filter((group) => group.ownerUserId !== current.user.id), ...labelGroups] }))} recentlyDeletedEpoch={recentlyDeletedEpoch} onDeletionWorkspaceChanged={refreshAfterDeletionMutation} />
      ) : surface === "workspace" ? (
        <WorkspaceOverviewSurface data={data} focusedData={workspaceData} statusMap={statusMap} projectMap={projectMap} workspaceScopeToken={workspaceFocusToken} workspaceScopeLoading={workspaceScopeLoading} onWorkspaceScopeChange={(token) => void loadWorkspaceScopeSnapshot(token)} onOpen={(nextSurface, nextLayout = "list") => navigateSurface(nextSurface, nextLayout)} onOpenTask={openTask} onCreateTask={() => void openCreate()} onCreateProject={() => setDialog("project")} onCreateRelease={() => void openDialogWithCatalog("release", ["projects"])} />
      ) : surface === "shared" ? (
        <SharedWithMeSurface data={{ ...data, projects: catalog.pages.projects?.projects ?? data.projects, views: catalog.pages.views?.views ?? data.views }} tasks={data.tasks} statuses={data.statuses} users={userMap} onOpenProject={(id) => navigateSurface(`project:${id}`, "list")} onOpenView={(view) => navigateSurface(`view:${view.id}`, view.display.layout)} onProjectContextActions={(project, x, y, focus) => openTaskContext(projectContextualEntity(project), x, y, focus)} />
      ) : surface === "admin" && data.admin ? (
        <AdminSurface overview={data.admin} timeZone={data.user.timezone} backupBusy={systemBackupBusy} exportActive={systemExport.active} onExport={systemExport.open} onImport={() => setDialog("systemImport")} />
      ) : surface === "views" ? (
        <><ViewsSurface data={{ ...data, views: catalog.pages.views?.views ?? data.views }} statusMap={statusMap} onOpen={(nextSurface, nextLayout) => navigateSurface(nextSurface, nextLayout)} onContextActions={(view, x, y, focus) => openTaskContext(viewContextualEntity(view), x, y, focus)} onRestore={(view) => mutate(`/api/views/${view.id}`, "PATCH", { version: view.version, archived: false })} busy={busy} />{catalog.pages.views?.page.hasMore && <CatalogPagination busy={catalog.loading} onMore={() => void catalog.loadMore("views")} />}</>
      ) : surface === "projects" ? (
        <><ProjectsSurface projects={catalog.pages.projects?.projects ?? data.projects} tasks={data.tasks} statuses={data.statuses} users={userMap} onOpen={(id) => navigateSurface(`project:${id}`, "list")} onContextActions={(project, x, y, focus) => openTaskContext(projectContextualEntity(project), x, y, focus)} onCreate={() => setDialog("project")} />{catalog.pages.projects?.page.hasMore && <CatalogPagination busy={catalog.loading} onMore={() => void catalog.loadMore("projects")} />}</>
      ) : surface === "releases" || projectReleaseSurfaceId ? (
        <><ReleasesSurface releases={surface === "releases" ? (catalog.pages.releases?.releases ?? data.releases) : scopedReleases} projects={projectMap} tasks={data.tasks} statuses={data.statuses} onOpen={(id) => navigateSurface(`release:${id}`, "list")} onContextActions={(release, x, y, focus) => openTaskContext(releaseContextualEntity(release), x, y, focus)} onCreate={() => { if (canCreateTask) void openDialogWithCatalog("release", ["projects"]); }} />{surface === "releases" && catalog.pages.releases?.page.hasMore && <CatalogPagination busy={catalog.loading} onMore={() => void catalog.loadMore("releases")} />}</>
      ) : taskSearchStatus ? (
        <TaskSearchNotice status={taskSearchStatus} />
      ) : layout === "board" ? (
        <><TaskBoard {...commonTaskSurface} />{pagination}</>
      ) : (
        <><TaskList {...commonTaskSurface} collapsed={collapsedGroups} pullRefreshing={pullRefreshing} pullRefreshError={pullRefreshError} pullRefreshDisabled={busy || taskWindowLoading} onRefresh={refreshTaskList} onToggleGroup={(id) => setCollapsedGroups((current) => toggleSet(current, id))} onStatusChange={(task, statusId) => mutate(`/api/tasks/${task.id}`, "PATCH", { version: taskMutationVersion(task), statusId })} />{pagination}</>
      )}
    </>
  );

  function openTaskContext(
    entity: Parameters<OpenContextualActions>[0]["entities"][number],
    x: number,
    y: number,
    focus: HTMLElement | null,
  ) {
    openContextualActions({ entities: [entity] }, x, y, focus);
  }
}
