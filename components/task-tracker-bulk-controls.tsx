"use client";

import {
priorityMeta,
resolveArchiveBulkAction
} from "@/components/task-tracker-state";
import {
canEditContent,
} from "@/lib/access";
import {
formatReleaseName,
} from "@/lib/release-presentation";
import type {
AppSnapshot,
LabelRecord,
Priority,
TaskRecord,
UserRecord,
WorkflowStatusRecord
} from "@/lib/types";
import {
Archive,
ArchiveRestore,
FolderKanban,
Rocket,
X
} from "lucide-react";
import {
useEffect,
useState
} from "react";

import {
DialogHeader,
Modal
} from "@/components/task-tracker-dialogs";


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

export function BulkBar({ data, tasks, statuses, archiveAction, onStatus, onPriority, onAssignee, onProject, onRelease, onLabel, onArchive, onClose }: { data: AppSnapshot; tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; archiveAction: ReturnType<typeof resolveArchiveBulkAction>; onStatus: (value: string) => void; onPriority: (value: Priority) => void; onAssignee: (value: string | null) => void; onProject: () => void; onRelease: () => void; onLabel: (labelId: string, active: boolean) => void; onArchive: () => void; onClose: () => void }) {
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
