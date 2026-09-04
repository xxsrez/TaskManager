"use client";

import {
groupByOptions,
toggleViewField,
viewDisplayDependencies,
viewFieldOptions,
viewOrderOptions
} from "@/components/task-tracker-state";
import {
canEditContent
} from "@/lib/access";
import {
filterCatalogOptions,
unavailableFilterReferences
} from "@/lib/filter-catalog";
import {
isProjectTaskCode,
normalizeProjectTaskCodeDraft,
PROJECT_TASK_CODE_INPUT_PATTERN,
suggestProjectTaskCode,
} from "@/lib/project-task-code";
import {
canonicalViewQuery,
} from "@/lib/task-filter";
import type {
AppSnapshot,
ProjectRecord,
ProjectStatus,
ReleaseRecord,
ReleaseStatus,
SavedViewRecord,
UserRecord,
ViewDisplay,
ViewQuery
} from "@/lib/types";
import {
Archive,
ArchiveRestore,
Columns3,
LayoutList,
ListFilter,
Rocket,
Trash2,
Zap
} from "lucide-react";
import {
FormEvent,
useRef,
useState
} from "react";

import {
DialogHeader,
Modal,
ProjectIcon,
projectStatusLabel,
projectStatusOptions,
} from "@/components/task-tracker-dialog-primitives";
import {
FilterConditionEditor,
queryFilterCount,
} from "@/components/task-tracker-filter-controls";

export function ProjectDialog({ project, currentUser, leadOptions, openTaskCount, onClose, onSubmit, onArchive, busy }: { project?: ProjectRecord; currentUser: UserRecord; leadOptions: UserRecord[]; openTaskCount: number; onClose: () => void; onSubmit: (input: Record<string, unknown>) => Promise<void>; onArchive?: () => Promise<void>; busy: boolean }) {
  const [name, setName] = useState(project?.name ?? "");
  const [taskCode, setTaskCode] = useState(project?.taskCode ?? "PR");
  const [codeEdited, setCodeEdited] = useState(Boolean(project));
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? "planned");
  const terminalWarning = Boolean(project && openTaskCount > 0 && (status === "completed" || status === "canceled") && status !== project.status);
  const codeLocked = Boolean(project?.codeLockedAt || (project?.taskSequence ?? 0) > 0);
  return <Modal onClose={onClose} className="project-dialog" ariaLabel={project ? `Edit ${project.name}` : "Create project"}><form onSubmit={(event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); void onSubmit({ ...values, leadUserId: values.leadUserId || null, confirmOpenTasks: values.confirmOpenTasks === "on" }); }}><DialogHeader title={project ? "Edit project" : "Create project"} icon={<ProjectIcon project={project} size={17} />} onClose={onClose} /><div className="form-stack project-form-stack"><label><span>Project name</span><input name="name" required autoFocus value={name} onChange={(event) => { const next = event.target.value; setName(next); if (!codeEdited) setTaskCode(suggestProjectTaskCode(next)); }} /></label><div className="project-form-grid"><label><span>Task code</span><input name="taskCode" required minLength={1} pattern={PROJECT_TASK_CODE_INPUT_PATTERN} value={taskCode} readOnly={codeLocked} className={codeLocked ? "read-only-control" : undefined} onChange={(event) => { setCodeEdited(true); setTaskCode(normalizeProjectTaskCodeDraft(event.target.value)); }} aria-describedby="project-code-help" /></label><label><span>Status</span><select name="status" value={status} onChange={(event) => setStatus(event.target.value as ProjectStatus)}>{projectStatusOptions.map((value) => <option key={value} value={value}>{projectStatusLabel(value)}</option>)}</select></label></div><small id="project-code-help" className="dialog-copy">{codeLocked ? `Locked after ${project?.taskSequence ?? 0} allocated Task number${project?.taskSequence === 1 ? "" : "s"}.` : "1–12 characters: Latin letters, digits, and internal hyphens. The code locks after this Project receives its first Task."}</small><label><span>Short summary</span><input name="summary" maxLength={500} defaultValue={project?.summary ?? ""} /></label><label><span>Markdown description</span><textarea name="description" rows={7} defaultValue={project?.description ?? ""} placeholder="Project context, outcome, and constraints…" /></label><div className="project-form-grid"><label><span>Lead</span><select name="leadUserId" defaultValue={project?.leadUserId ?? currentUser.id}><option value="">No lead</option>{leadOptions.map((user) => <option key={user.id} value={user.id}>{user.displayName}</option>)}</select></label><label><span>Icon</span><select name="icon" defaultValue={project?.icon ?? "cube"}><option value="cube">Cube</option><option value="folder">Folder</option><option value="target">Target</option><option value="rocket">Rocket</option></select></label><label><span>Color</span><input name="color" type="color" defaultValue={project?.color ?? "#8b7cf6"} /></label></div><div className="project-form-grid"><label><span>Start date</span><input name="startDate" type="date" defaultValue={project?.startDate ?? ""} /></label><label><span>Target date</span><input name="targetDate" type="date" defaultValue={project?.targetDate ?? ""} /></label></div>{terminalWarning && <label className="project-terminal-warning"><input name="confirmOpenTasks" type="checkbox" required /><span>This Project has {openTaskCount} open Task{openTaskCount === 1 ? "" : "s"}. Confirm the terminal transition.</span></label>}</div><div className="project-dialog-footer">{project && onArchive && <button className={`button ghost ${project.archivedAt ? "" : "danger"}`} type="button" disabled={busy} onClick={() => void onArchive()}>{project.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}{project.archivedAt ? "Restore project" : "Archive project"}</button>}<div><button className="button ghost" type="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !name.trim() || !isProjectTaskCode(taskCode)}>{busy ? "Saving…" : project ? "Save changes" : "Create"}</button></div></div></form></Modal>;
}
export const releaseStatusOptions: ReleaseStatus[] = ["planned", "active", "released", "canceled"];

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
export type ViewDialogDraft = {
  name: string;
  scopeProjectId: string | null;
  query: ViewQuery;
  display: ViewDisplay;
};

export function comparableViewDialogDraft(draft: ViewDialogDraft) {
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

export function ViewDisplayEditor({ display, data, scopeProjectId, onDisplay }: {
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
