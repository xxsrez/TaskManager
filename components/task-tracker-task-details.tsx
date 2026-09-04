"use client";

import {
TaskAttachments
} from "@/components/task-attachments";
import {
TaskDescriptionEditor,
} from "@/components/task-description-editor";
import {
priorityMeta,
type LabelMutationResult
} from "@/components/task-tracker-state";
import {
canEditContent,
} from "@/lib/access";
import {
rebaseTaskDraft,
resizeTaskTitle,
taskDraftSyncMode,
taskDraftValueChanged,
taskNeedsDetailRefresh,
type TaskDraftDirty,
} from "@/lib/task-detail-reconciliation";
import {
type TaskQueryDependency,
} from "@/lib/task-query-reconciliation";
import type {
AppSnapshot,
LabelRecord,
ProjectRecord,
TaskRecord
} from "@/lib/types";
import {
Archive,
ArrowDown,
ArrowDownWideNarrow,
Boxes,
CalendarDays,
CircleDot,
FolderKanban,
Link2,
MoreHorizontal,
Plus,
Rocket,
Share2,
Tag,
UsersRound,
X,
Zap
} from "lucide-react";
import {
useCallback,
useEffect,
useRef,
useState
} from "react";

import {
DialogFooter,
DialogHeader,
Modal,
longDate,
shortDate
} from "@/components/task-tracker-dialogs";

import { TaskActivity } from "@/components/task-tracker-task-activity";
import { TaskDescriptionMarkdown } from "@/components/task-tracker-task-markdown";
import {
DetailsSection,
LabelChip,
LabelPicker,
PropertyRow,
PropertyValue,
TaskReference,
labelsForTask,
wouldCreateHierarchyCycle,
} from "@/components/task-tracker-task-primitives";
import { TaskRelations } from "@/components/task-tracker-task-relations";
import { taskAssigneeOptions } from "@/components/task-tracker-task-surfaces";

export function TaskDetails({ task, data, catalogReady, onClose, onOpenTask, onContextActions, onSave, onMove, onSetParent, onCreateSubtask, onSetLabel, onRebase, onRelationMutation, onShare, busy }: { task: TaskRecord; data: AppSnapshot; catalogReady: boolean; onClose: () => void; onOpenTask: (id: string) => void; onContextActions: (x: number, y: number, restoreFocus: HTMLElement | null) => void; onSave: (input: Record<string, unknown>) => Promise<unknown>; onMove: (input: Record<string, unknown>) => Promise<unknown>; onSetParent: (parentTaskId: string | null) => Promise<unknown>; onCreateSubtask: (title: string) => Promise<unknown>; onSetLabel: (labelId: string, active: boolean) => Promise<unknown>; onRebase: (taskId: string) => Promise<TaskRecord | null>; onRelationMutation: (tasks: TaskRecord[], dependencies: TaskQueryDependency[]) => void; onShare: () => void; busy: boolean }) {
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

export function TaskDetailsLoading({ task, onClose }: { task: TaskRecord; onClose: () => void }) {
  return <div className="details-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="details-panel" aria-busy="true"><header><div className="details-crumb"><span>{task.identifier}</span></div><button className="icon-button" onClick={onClose}><X size={16} /></button></header><div className="details-body task-details-loading"><h1 className="read-only-title">{task.title}</h1><p>Loading task details…</p></div></aside></div>;
}

export function ReadOnlyTaskDetails({ task, data, onClose, onOpenTask }: { task: TaskRecord; data: AppSnapshot; onClose: () => void; onOpenTask: (id: string) => void }) {
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
