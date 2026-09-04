"use client";

import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import { canEditContent } from "@/lib/access";
import type { Layout, ResolvedNavigation } from "@/lib/navigation";
import { taskMutationVersion } from "@/lib/task-detail-reconciliation";
import type { TaskQueryDependency } from "@/lib/task-query-reconciliation";
import type {
  AppSnapshot,
  ProjectRecord,
  ReleaseRecord,
  SavedViewRecord,
  TaskRecord,
  TeamDetail,
  TeamMembershipRecord,
  ViewDisplay,
  ViewQuery,
  WorkflowStatusRecord,
  WorkspaceCatalogKind,
} from "@/lib/types";
import { resolveContextualActions } from "@/lib/contextual-actions";
import type {
  Dialog,
  ShareContext,
  TaskCreateDefaults,
  TeamMutationState,
} from "@/components/task-tracker-state";
import { resolveArchiveBulkAction } from "@/components/task-tracker-state";
import {
  BulkBar,
  BulkProjectDialog,
  BulkReleaseDialog,
  CodexSetupDialog,
  GlobalSearchOverlay,
  LabelGroupSettingsDialog,
  LabelSettingsDialog,
  Peek,
  ProjectDialog,
  ReleaseDialog,
  ShareDialog,
  SystemBackupExportDialog,
  SystemImportDialog,
  TaskComposer,
  TaskDetails,
  TaskDetailsLoading,
  TaskMoveDialog,
  TeamMemberDeleteDialog,
  TeamMemberDialog,
  TeamNameDialog,
  ViewDialog,
  WorkflowSettingsDialog,
  confirmReleasedCompositionChange,
  labelsForTask,
  openProjectTaskCount,
  openReleaseTaskCount,
  projectMemberOptions,
  queryFilterCount,
  releaseContextualEntity,
  releasedCompositionNeedsConfirmation,
  statusGroupsForTasks,
  taskContextualEntity,
  taskHierarchySummary,
} from "@/components/task-tracker-view";
import { ContextualActionMenu } from "@/components/contextual-action-menu";
import {
  DeletionUndoToast,
  RecoverableDeleteDialog,
} from "@/components/deletion-dialogs";
import type { useRecoverableDeletionController } from "@/components/task-tracker-deletion-controller";
import type { useSystemExportController } from "@/components/task-tracker-system-export";
import type { useTaskTrackerContextualActions } from "@/components/task-tracker-contextual-actions";

type Mutate = (
  path: string,
  method: string,
  body: unknown,
  options?: {
    onConflict?: () => Promise<void>;
    conflictMessage?: string;
  },
) => Promise<boolean>;

type TaskTrackerOverlayHostProps = {
  data: AppSnapshot;
  setData: Dispatch<SetStateAction<AppSnapshot>>;
  dataRef: MutableRefObject<AppSnapshot>;
  surface: string;
  layout: Layout;
  globalSearchOpen: boolean;
  closeGlobalSearch: () => void;
  openGlobalSearchResult: Parameters<typeof GlobalSearchOverlay>[0]["onOpen"];
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  selectedTasks: TaskRecord[];
  selectedTaskVersions: Record<string, number>;
  archiveAction: ReturnType<typeof resolveArchiveBulkAction>;
  contextual: Pick<ReturnType<typeof useTaskTrackerContextualActions>, "menu" | "execute" | "close" | "open">;
  deletion: Pick<ReturnType<typeof useRecoverableDeletionController>, "pending" | "undo" | "busy" | "confirm" | "undoDelete" | "closePending" | "dismissUndo" | "open">;
  activeTask: TaskRecord | null;
  activeDetailsData: AppSnapshot;
  taskPropertyCatalogReady: boolean;
  pendingMoveTask?: TaskRecord;
  pendingMoveSourceProject?: ProjectRecord;
  pendingMoveTargetProject?: ProjectRecord;
  pendingMoveParent?: TaskRecord;
  pendingMoveSubtasks: TaskRecord[];
  setPendingProjectMove: (value: null) => void;
  peekTask: TaskRecord | null;
  setPeekTaskId: Dispatch<SetStateAction<string | null>>;
  dialog: Dialog;
  setDialog: Dispatch<SetStateAction<Dialog>>;
  createDefaults: TaskCreateDefaults;
  contextProject: string | null;
  contextRelease: string | null;
  contextProjectRecord?: ProjectRecord;
  contextReleaseRecord?: ReleaseRecord;
  activeSavedView?: SavedViewRecord;
  currentShareContext: ShareContext | null;
  canCreateTask: boolean;
  canSaveView: boolean;
  currentViewQuery: ViewQuery;
  temporaryViewQuery: ViewQuery;
  currentDisplay: ViewDisplay;
  error: string;
  statusMap: Map<string, WorkflowStatusRecord>;
  projectMap: Map<string, ProjectRecord>;
  busy: boolean;
  systemExport: ReturnType<typeof useSystemExportController>;
  setAuxiliaryBackupBusy: Dispatch<SetStateAction<boolean>>;
  activeTeamDetail: TeamDetail | null;
  teamMemberForDelete: TeamMembershipRecord | null;
  teamMutation: TeamMutationState;
  teamAlert: string;
  setTeamMemberForDelete: Dispatch<SetStateAction<TeamMembershipRecord | null>>;
  mutate: Mutate;
  createTaskForComposer: (input: Record<string, unknown>) => Promise<TaskRecord | null>;
  refreshTaskDetail: (taskId: string) => Promise<TaskRecord | null>;
  refreshSavedViewsAfterConflict: () => Promise<void>;
  reconcileSuccessfulTaskMutation: (
    tasks: readonly TaskRecord[],
    before: AppSnapshot,
    after: AppSnapshot,
    dependencies?: Iterable<TaskQueryDependency>,
  ) => void;
  openDialogWithCatalog: (
    dialog: Exclude<Dialog, null>,
    kinds: readonly WorkspaceCatalogKind[],
  ) => Promise<void>;
  closeTask: () => void;
  openTask: (taskId: string) => void;
  changeLayout: (layout: Layout) => void;
  applyNavigation: (
    next: ResolvedNavigation,
    historyMode?: "push" | "replace" | "none",
    preserveTemporaryFilter?: boolean,
    canonicalPath?: string,
  ) => void;
  setDisplayOverrides: Dispatch<SetStateAction<Partial<Record<string, ViewDisplay>>>>;
  createTeam: (name: string) => Promise<boolean>;
  renameTeam: (name: string) => Promise<boolean>;
  addTeamMember: (email: string) => Promise<boolean>;
  deleteTeamMembership: (membership: TeamMembershipRecord) => Promise<boolean>;
};

export function TaskTrackerOverlayHost({
  data,
  setData,
  dataRef,
  surface,
  layout,
  globalSearchOpen,
  closeGlobalSearch,
  openGlobalSearchResult,
  selected,
  setSelected,
  selectedTasks,
  selectedTaskVersions,
  archiveAction,
  contextual,
  deletion,
  activeTask,
  activeDetailsData,
  taskPropertyCatalogReady,
  pendingMoveTask,
  pendingMoveSourceProject,
  pendingMoveTargetProject,
  pendingMoveParent,
  pendingMoveSubtasks,
  setPendingProjectMove,
  peekTask,
  setPeekTaskId,
  dialog,
  setDialog,
  createDefaults,
  contextProject,
  contextRelease,
  contextProjectRecord,
  contextReleaseRecord,
  activeSavedView,
  currentShareContext,
  canCreateTask,
  canSaveView,
  currentViewQuery,
  temporaryViewQuery,
  currentDisplay,
  error,
  statusMap,
  projectMap,
  busy,
  systemExport,
  setAuxiliaryBackupBusy,
  activeTeamDetail,
  teamMemberForDelete,
  teamMutation,
  teamAlert,
  setTeamMemberForDelete,
  mutate,
  createTaskForComposer,
  refreshTaskDetail,
  refreshSavedViewsAfterConflict,
  reconcileSuccessfulTaskMutation,
  openDialogWithCatalog,
  closeTask,
  openTask,
  changeLayout,
  applyNavigation,
  setDisplayOverrides,
  createTeam,
  renameTeam,
  addTeamMember,
  deleteTeamMembership,
}: TaskTrackerOverlayHostProps) {
  const contextualMenu = contextual.menu;
  const recoverableDeletion = deletion.pending;
  const deletionUndo = deletion.undo;
  const deletionBusy = deletion.busy;

  return (
    <>
      {globalSearchOpen && <GlobalSearchOverlay onClose={closeGlobalSearch} onOpen={openGlobalSearchResult} />}

      {selected.size > 0 && <BulkBar data={data} tasks={selectedTasks} statuses={statusGroupsForTasks(selectedTasks, data.statuses)} archiveAction={archiveAction} onStatus={(value) => mutate("/api/tasks/bulk", "POST", { ids: [...selected], versions: selectedTaskVersions, field: "statusId", value }).then((ok) => ok && setSelected(new Set()))} onPriority={(value) => mutate("/api/tasks/bulk", "POST", { ids: [...selected], versions: selectedTaskVersions, field: "priority", value }).then((ok) => ok && setSelected(new Set()))} onAssignee={(value) => mutate("/api/tasks/bulk", "POST", { ids: [...selected], versions: selectedTaskVersions, field: "assigneeUserId", value }).then((ok) => ok && setSelected(new Set()))} onProject={() => void openDialogWithCatalog("bulkProject", ["projects", "releases"])} onRelease={() => void openDialogWithCatalog("bulkRelease", ["releases"])} onLabel={(labelId, active) => mutate("/api/tasks/labels/bulk", "POST", { ids: [...selected], labelId, active })} onArchive={() => mutate("/api/tasks/bulk", "POST", { ids: [...selected], versions: selectedTaskVersions, field: "archived", value: archiveAction.archived }).then((ok) => ok && setSelected(new Set()))} onClose={() => setSelected(new Set())} />}

      {contextualMenu && <ContextualActionMenu actions={resolveContextualActions(contextualMenu.context)} x={contextualMenu.x} y={contextualMenu.y} busy={busy} onExecute={contextual.execute} onClose={contextual.close} />}

      {recoverableDeletion && <RecoverableDeleteDialog target={recoverableDeletion} busy={deletionBusy} onConfirm={() => void deletion.confirm()} onClose={deletion.closePending} />}
      {deletionUndo && <DeletionUndoToast label={deletionUndo.label} busy={deletionBusy} onUndo={() => void deletion.undoDelete()} onDismiss={deletion.dismissUndo} />}

      {activeTask && <div className={currentShareContext ? undefined : "details-no-share"}>{activeTask.description === null ? <TaskDetailsLoading task={activeTask} onClose={closeTask} /> : <TaskDetails key={activeTask.id} task={activeTask} data={activeDetailsData} catalogReady={taskPropertyCatalogReady} onClose={closeTask} onOpenTask={openTask} onContextActions={(x, y, focus) => contextual.open({ entities: [taskContextualEntity(activeTask)] }, x, y, focus)} onSave={async (changes) => { const nextReleaseId = Object.hasOwn(changes, "releaseId") ? changes.releaseId as string | null : activeTask.releaseId; const confirmReleasedComposition = releasedCompositionNeedsConfirmation(activeTask.releaseId, nextReleaseId, data.releases); if (confirmReleasedComposition && !confirmReleasedCompositionChange()) return false; return mutate(`/api/tasks/${activeTask.id}`, "PATCH", { version: taskMutationVersion(activeTask), ...changes, ...(confirmReleasedComposition ? { confirmReleasedComposition: true } : {}) }); }} onMove={async (changes) => { const nextReleaseId = Object.hasOwn(changes, "releaseId") ? changes.releaseId as string | null : null; const confirmReleasedComposition = releasedCompositionNeedsConfirmation(activeTask.releaseId, nextReleaseId, data.releases); if (confirmReleasedComposition && !confirmReleasedCompositionChange()) return false; return mutate(`/api/tasks/${activeTask.id}/move`, "POST", { version: taskMutationVersion(activeTask), ...changes, ...(confirmReleasedComposition ? { confirmReleasedComposition: true } : {}) }); }} onSetParent={(parentTaskId) => mutate(`/api/tasks/${activeTask.id}/parent`, "PATCH", { version: taskMutationVersion(activeTask), parentTaskId })} onCreateSubtask={(title) => mutate(`/api/tasks/${activeTask.id}/subtasks`, "POST", { version: taskMutationVersion(activeTask), title })} onSetLabel={(labelId, active) => mutate(`/api/tasks/${activeTask.id}/labels`, "POST", { labelId, active })} onRebase={refreshTaskDetail} onRelationMutation={(tasks, dependencies) => reconcileSuccessfulTaskMutation(tasks, dataRef.current, dataRef.current, dependencies)} onShare={() => setDialog("share")} busy={busy} />}</div>}

      {pendingMoveTask && pendingMoveSourceProject && pendingMoveTargetProject && <TaskMoveDialog task={pendingMoveTask} sourceProject={pendingMoveSourceProject} targetProject={pendingMoveTargetProject} data={data} parent={pendingMoveParent} subtasks={pendingMoveSubtasks} busy={busy} onClose={() => setPendingProjectMove(null)} onMove={async (changes) => { const nextReleaseId = Object.hasOwn(changes, "releaseId") ? changes.releaseId as string | null : null; const confirmReleasedComposition = releasedCompositionNeedsConfirmation(pendingMoveTask.releaseId, nextReleaseId, data.releases); if (confirmReleasedComposition && !confirmReleasedCompositionChange()) return; const moved = await mutate(`/api/tasks/${pendingMoveTask.id}/move`, "POST", { version: taskMutationVersion(pendingMoveTask), ...changes, ...(confirmReleasedComposition ? { confirmReleasedComposition: true } : {}) }); if (moved) setPendingProjectMove(null); }} />}

      {peekTask && <Peek task={peekTask} status={statusMap.get(peekTask.statusId)} project={peekTask.projectId ? projectMap.get(peekTask.projectId) : undefined} labels={labelsForTask(data, peekTask.id)} hierarchy={taskHierarchySummary(peekTask, data.tasks)} onClose={() => setPeekTaskId(null)} onOpen={() => { openTask(peekTask.id); setPeekTaskId(null); }} />}

      {dialog === "task" && canCreateTask && <TaskComposer data={data} contextProject={contextProject} contextRelease={contextRelease} defaults={createDefaults} onClose={() => setDialog(null)} onSubmit={createTaskForComposer} busy={busy} />}
      {dialog === "project" && <ProjectDialog currentUser={data.user} leadOptions={[data.user]} openTaskCount={0} onClose={() => setDialog(null)} onSubmit={async (input) => { const before = new Set(dataRef.current.projects.map((project) => project.id)); const ok = await mutate("/api/projects", "POST", input); if (!ok) return; const created = dataRef.current.projects.find((project) => !before.has(project.id)); setDialog(null); if (created) applyNavigation({ surface: `project:${created.id}`, layout: "list", taskId: null }, "push", false, `/projects/${encodeURIComponent(created.publicId)}`); }} busy={busy} />}
      {dialog === "projectEdit" && contextProjectRecord && <ProjectDialog project={contextProjectRecord} currentUser={data.user} leadOptions={projectMemberOptions(data, contextProjectRecord)} openTaskCount={openProjectTaskCount(contextProjectRecord.id, data.tasks, statusMap)} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate(`/api/projects/${contextProjectRecord.id}`, "PATCH", { version: contextProjectRecord.version, ...input }); if (ok) setDialog(null); }} onArchive={async () => { const ok = await mutate(`/api/projects/${contextProjectRecord.id}`, "PATCH", { version: contextProjectRecord.version, archived: !contextProjectRecord.archivedAt }); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "release" && <ReleaseDialog projects={data.projects.filter((project) => !project.archivedAt && canEditContent(project.accessRole))} initialProjectId={contextProject} openTaskCount={0} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/releases", "POST", input); if (ok) setDialog(null); }} busy={busy} />}
      {dialog === "releaseEdit" && contextReleaseRecord && <ReleaseDialog release={contextReleaseRecord} projects={data.projects.filter((project) => project.id === contextReleaseRecord.projectId)} initialProjectId={contextReleaseRecord.projectId} openTaskCount={openReleaseTaskCount(contextReleaseRecord.id, data.tasks, statusMap)} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate(`/api/releases/${contextReleaseRecord.id}`, "PATCH", { version: contextReleaseRecord.version, ...input }); if (ok) setDialog(null); }} onDelete={() => void deletion.open(releaseContextualEntity(contextReleaseRecord))} busy={busy} />}
      {dialog === "view" && canSaveView && <ViewDialog view={activeSavedView} editing={false} query={currentViewQuery} display={currentDisplay} data={data} initialScopeProjectId={activeSavedView?.scopeProjectId ?? contextProject} temporaryFilterCount={0} submissionError={error} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate("/api/views", "POST", input); if (ok) setDialog(null); return ok; }} busy={busy} />}
      {dialog === "viewEdit" && activeSavedView && canSaveView && <ViewDialog key={activeSavedView.id} view={activeSavedView} editing query={activeSavedView.query} display={activeSavedView.display} data={data} initialScopeProjectId={activeSavedView.scopeProjectId} temporaryFilterCount={queryFilterCount(temporaryViewQuery)} submissionError={error} onClose={() => setDialog(null)} onSubmit={async (input) => { const ok = await mutate(`/api/views/${activeSavedView.id}`, "PATCH", { version: activeSavedView.version, ...input }, { onConflict: refreshSavedViewsAfterConflict, conflictMessage: "This Saved View changed in another session. The latest saved version was reloaded; review it and try again." }); if (ok) { setDialog(null); setDisplayOverrides((current) => { const next = { ...current }; delete next[surface]; return next; }); const savedDisplay = input.display as ViewDisplay; if (savedDisplay.layout !== layout) changeLayout(savedDisplay.layout); } return ok; }} busy={busy} />}
      {dialog === "share" && currentShareContext && <ShareDialog key={currentShareContext.key} context={currentShareContext} currentUser={data.user} users={data.users} collaborators={data.collaborators} onClose={() => setDialog(null)} onShare={(input) => mutate("/api/shares", "POST", input)} onRoleChange={(grantId, permission) => mutate("/api/shares", "PATCH", { grantId, permission })} onRevoke={(grantId) => mutate("/api/shares", "DELETE", { grantId })} onTransfer={(projectId, targetUserId) => mutate("/api/shares/transfer", "POST", { projectId, targetUserId })} busy={busy} />}
      {dialog === "systemExport" && <SystemBackupExportDialog status={systemExport.status} busy={systemExport.running} waitingForNetwork={systemExport.waitingForNetwork} error={systemExport.error} onClose={() => setDialog(null)} onStart={(fresh) => void systemExport.start(fresh)} onResume={systemExport.resume} />}
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
    </>
  );
}
