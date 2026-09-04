"use client";

import {
builtInViews,
filterTeamList,
type AsyncValue,
type TeamMutationState
} from "@/components/task-tracker-state";
import {
canEditContent,
} from "@/lib/access";
import {
navigationPath,
type Layout
} from "@/lib/navigation";
import {
formatReleaseName,
} from "@/lib/release-presentation";
import type {
AppSnapshot,
ProjectRecord,
ReleaseRecord,
SavedViewRecord,
TaskRecord,
TeamDetail,
TeamList,
TeamMembershipRecord,
UserRecord,
WorkflowStatusRecord
} from "@/lib/types";
import {
Archive,
ArchiveRestore,
Inbox,
MoreHorizontal,
Plus,
Rocket,
RotateCw,
Search,
Trash2,
UserRound,
UsersRound,
Zap
} from "lucide-react";

import {
DialogHeader,
Modal,
ProjectIcon,
handleLocalLink,
initials,
projectStatusLabel,
shortDate
} from "@/components/task-tracker-dialogs";

import {
EmptyState,
MarkdownBody,
} from "@/components/task-tracker-tasks";
import {
completion,
taskCountForView,
} from "@/components/task-tracker-view-helpers";

export function ViewsSurface({ data, statusMap, onOpen, onContextActions, onRestore, busy }: { data: AppSnapshot; statusMap: Map<string, WorkflowStatusRecord>; onOpen: (surface: string, layout: Layout) => void; onContextActions: (view: SavedViewRecord, x: number, y: number, restoreFocus: HTMLElement | null) => void; onRestore: (view: SavedViewRecord) => Promise<boolean>; busy: boolean }) {
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
export function openProjectTaskCount(projectId: string, tasks: TaskRecord[], statuses: Map<string, WorkflowStatusRecord>) {
  return tasks.filter((task) => {
    if (task.projectId !== projectId || task.archivedAt) return false;
    const category = statuses.get(task.statusId)?.category;
    return category !== "completed" && category !== "canceled";
  }).length;
}

export function openReleaseTaskCount(releaseId: string, tasks: TaskRecord[], statuses: Map<string, WorkflowStatusRecord>) {
  return tasks.filter((task) => {
    if (task.releaseId !== releaseId || task.archivedAt) return false;
    const category = statuses.get(task.statusId)?.category;
    return category !== "completed" && category !== "canceled";
  }).length;
}

export function projectMemberOptions(data: AppSnapshot, project: ProjectRecord): UserRecord[] {
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

export function TeamsSurface({ state, query, onRetry, onCreate, onOpen }: {
  state: AsyncValue<TeamList>;
  query: string;
  onRetry: () => void;
  onCreate: () => void;
  onOpen: (publicId: string) => void;
}) {
  if ((state.status === "idle" || state.status === "loading") && (!state.value || state.value.teams.length === 0)) {
    return <TeamSurfaceState status="Loading Teams…" busy />;
  }
  if (state.status === "error" && (!state.value || state.value.teams.length === 0)) {
    return <TeamSurfaceState status={state.error} onRetry={onRetry} />;
  }

  const visible = filterTeamList(state.value ?? { teams: [] }, query);
  const empty = state.status === "ready" && state.value?.teams.length === 0;
  const noMatch = state.status === "ready" && !empty && visible.length === 0;
  const groups = [
    {
      id: "owned-teams",
      title: "Owned by you",
      description: "You manage these Team memberships.",
      teams: visible.filter(({ currentMembership }) => currentMembership.role === "owner"),
    },
    {
      id: "joined-teams",
      title: "Joined",
      description: "Teams where you are an active member.",
      teams: visible.filter(({ currentMembership }) => currentMembership.role === "member"),
    },
  ].filter((group) => group.teams.length > 0);

  return <div className="teams-surface" aria-busy={state.status === "loading" || undefined}>
    <div className="team-live-region" role="status" aria-live="polite">{state.status === "loading" ? "Refreshing Teams…" : ""}</div>
    {state.status === "error" && <div className="team-local-alert" role="alert"><span>{state.error}</span><button className="button ghost compact" type="button" onClick={onRetry}>Retry</button></div>}
    {empty ? <section className="team-empty-state"><span className="empty-icon"><UsersRound size={20} /></span><h2>No Teams yet</h2><p>Create a Team to manage a reusable member list.</p><button className="button primary" type="button" onClick={onCreate}><Plus size={14} />New Team</button></section>
      : noMatch ? <section className="team-empty-state"><Search size={20} /><h2>No Teams match “{query.trim()}”</h2><p>Try a different Team name.</p></section>
      : <div className="teams-catalog-groups" aria-label="Teams">{groups.map((group) => <section className="team-members-section team-catalog-group" key={group.id} aria-labelledby={group.id}><header><div><h2 id={group.id}>{group.title}</h2><p>{group.description}</p></div><span className="count-pill">{group.teams.length}</span></header><div className="entity-grid team-grid">{group.teams.map(({ team, currentMembership, activeMemberCount }) => <a className="entity-card team-card" key={team.id} href={`/teams/${encodeURIComponent(team.publicId)}`} onClick={(event) => handleLocalLink(event, () => onOpen(team.publicId))}><div className="entity-icon team-icon"><UsersRound size={18} /></div><div className="entity-card-copy"><div><h2 title={team.name}>{team.name}</h2><span className="status-badge">{currentMembership.role}</span></div><p>{activeMemberCount} active member{activeMemberCount === 1 ? "" : "s"}</p><div className="progress-meta"><span>Your membership</span><span>{currentMembership.status}</span></div></div></a>)}</div></section>)}</div>}
  </div>;
}

export function TeamSurfaceState({ status, busy = false, onRetry }: { status: string; busy?: boolean; onRetry?: () => void }) {
  return <section className="team-surface-state" aria-busy={busy || undefined}>{busy ? <RotateCw size={20} className="spin" aria-hidden="true" /> : <UsersRound size={20} aria-hidden="true" />}<h2>{status}</h2>{onRetry && <button className="button ghost" type="button" onClick={onRetry}>Retry</button>}</section>;
}

export function TeamDetailSurface({ state, alert, mutation, onRetry, onMembershipAction, onDelete }: {
  state: AsyncValue<TeamDetail>;
  alert: string;
  mutation: TeamMutationState;
  onRetry: () => void;
  onMembershipAction: (membership: TeamMembershipRecord, action: "deactivate" | "reactivate") => void;
  onDelete: (membership: TeamMembershipRecord) => void;
}) {
  if ((state.status === "idle" || state.status === "loading") && !state.value) return <TeamSurfaceState status="Loading Team…" busy />;
  if (state.status === "error" && !state.value) return <TeamSurfaceState status={state.error === "Team unavailable" ? state.error : alert || state.error} onRetry={onRetry} />;
  const detail = state.value;
  if (!detail) return <TeamSurfaceState status="Team unavailable" onRetry={onRetry} />;

  const isOwner = detail.currentMembership.role === "owner";
  const activeMembers = detail.members.filter((membership) => membership.status === "active");
  const inactiveMembers = detail.members.filter((membership) => membership.status === "inactive");
  const memberRow = (membership: TeamMembershipRecord) => {
    const isCurrent = membership.id === detail.currentMembership.id;
    const mutable = isOwner && membership.role !== "owner";
    const membershipBusy = mutation?.key === membership.id;
    return <li className="team-member-row" key={membership.id} aria-busy={membershipBusy || undefined}><span className="avatar">{initials(membership.displayName)}</span><span className="team-member-identity"><span><b>{membership.displayName}</b>{isCurrent && <em>You</em>}</span><small>{membership.email}</small></span><span className="team-member-state"><span className="status-badge">{membership.role}</span><span className={`status-badge team-membership-${membership.status}`}>{membership.status}</span></span>{mutable && <span className="team-member-actions"><button className="button ghost compact" type="button" disabled={Boolean(mutation) || state.status !== "ready"} onClick={() => onMembershipAction(membership, membership.status === "active" ? "deactivate" : "reactivate")}>{membership.status === "active" ? "Deactivate" : "Reactivate"}</button><button className="button danger compact" type="button" disabled={Boolean(mutation) || state.status !== "ready"} onClick={() => onDelete(membership)}>Delete</button></span>}</li>;
  };

  return <div className="team-detail-surface" aria-busy={state.status === "loading" || undefined}>
    <div className="team-live-region" role="status" aria-live="polite">{state.status === "loading" ? "Refreshing Team…" : ""}</div>
    {alert && <div className="team-local-alert" role="alert">{alert}</div>}
    {state.status === "error" && <div className="team-local-alert" role="alert"><span>{state.error}</span><button className="button ghost compact" type="button" onClick={onRetry}>Retry</button></div>}
    <section className="team-overview" aria-labelledby="team-overview-heading"><span className="team-overview-icon"><UsersRound size={20} /></span><div><span className="project-code">Team</span><h2 id="team-overview-heading">{detail.team.name}</h2><p>{activeMembers.length} active member{activeMembers.length === 1 ? "" : "s"}</p></div><dl><div><dt>Your role</dt><dd>{detail.currentMembership.role}</dd></div><div><dt>Your state</dt><dd>{detail.currentMembership.status}</dd></div></dl></section>
    <section className="team-members-section" aria-labelledby="active-team-members"><header><div><h2 id="active-team-members">Active members</h2><p>People currently included in this Team.</p></div><span className="count-pill">{activeMembers.length}</span></header><ul className="team-member-list">{activeMembers.map(memberRow)}</ul></section>
    {inactiveMembers.length > 0 && <section className="team-members-section" aria-labelledby="inactive-team-members"><header><div><h2 id="inactive-team-members">Inactive members</h2><p>Reactivate or delete a previous membership.</p></div><span className="count-pill">{inactiveMembers.length}</span></header><ul className="team-member-list">{inactiveMembers.map(memberRow)}</ul></section>}
  </div>;
}

export function TeamNameDialog({ title, submitLabel, initialName = "", error, busy, onClose, onSubmit }: { title: string; submitLabel: string; initialName?: string; error: string; busy: boolean; onClose: () => void; onSubmit: (name: string) => Promise<boolean> }) {
  return <Modal onClose={onClose} className="team-dialog" ariaLabel={title}><DialogHeader title={title} icon={<UsersRound size={17} />} onClose={onClose} /><form className="form-stack team-dialog-form" aria-busy={busy || undefined} onSubmit={(event) => { event.preventDefault(); const input = new FormData(event.currentTarget); void onSubmit(String(input.get("name") ?? "")); }}><label><span>Name</span><input name="name" required maxLength={100} defaultValue={initialName} autoFocus /></label>{error && <div className="form-error" role="alert">{error}</div>}<div className="dialog-actions"><button className="button ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Saving…" : submitLabel}</button></div></form></Modal>;
}

export function TeamMemberDialog({ error, busy, onClose, onSubmit }: { error: string; busy: boolean; onClose: () => void; onSubmit: (email: string) => Promise<boolean> }) {
  return <Modal onClose={onClose} className="team-dialog" ariaLabel="Add Team member"><DialogHeader title="Add Team member" icon={<UserRound size={17} />} onClose={onClose} /><form className="form-stack team-dialog-form" aria-busy={busy || undefined} onSubmit={(event) => { event.preventDefault(); const input = new FormData(event.currentTarget); void onSubmit(String(input.get("email") ?? "")); }}><p className="dialog-copy">Add a registered user by verified email. They must have signed in once; no email is sent.</p><label><span>Email</span><input name="email" type="email" required autoComplete="off" placeholder="name@example.com" autoFocus /></label>{error && <div className="form-error" role="alert">{error}</div>}<div className="dialog-actions"><button className="button ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? "Adding…" : "Add member"}</button></div></form></Modal>;
}

export function TeamMemberDeleteDialog({ membership, error, busy, onClose, onConfirm }: { membership: TeamMembershipRecord; error: string; busy: boolean; onClose: () => void; onConfirm: () => Promise<boolean> }) {
  return <Modal onClose={onClose} className="team-dialog" ariaLabel="Delete Team membership"><DialogHeader title="Delete Team membership" icon={<Trash2 size={17} />} onClose={onClose} /><div className="team-delete-copy"><p>Delete the membership for <b>{membership.displayName}</b>?</p><small>{membership.email}</small><p>This removes the membership record. Use Deactivate when the membership may need to be restored later.</p></div>{error && <div className="form-error" role="alert">{error}</div>}<div className="dialog-actions team-delete-actions"><button className="button ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button danger" type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => void onConfirm()}>{busy ? "Deleting…" : "Delete membership"}</button></div></Modal>;
}

export function ProjectsSurface({ projects, tasks, statuses, users, onOpen, onContextActions, onCreate }: { projects: ProjectRecord[]; tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; users: Map<string, UserRecord>; onOpen: (id: string) => void; onContextActions: (project: ProjectRecord, x: number, y: number, restoreFocus: HTMLElement | null) => void; onCreate: () => void }) {
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

export function ReleasesSurface({ releases, projects, tasks, statuses, onOpen, onContextActions, onCreate }: { releases: ReleaseRecord[]; projects: Map<string, ProjectRecord>; tasks: TaskRecord[]; statuses: WorkflowStatusRecord[]; onOpen: (id: string) => void; onContextActions: (release: ReleaseRecord, x: number, y: number, restoreFocus: HTMLElement | null) => void; onCreate: () => void }) {
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
