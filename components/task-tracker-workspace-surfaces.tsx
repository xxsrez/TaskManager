"use client";

import {
canEditContent,
} from "@/lib/access";
import {
navigationPath,
taskPath,
type Layout
} from "@/lib/navigation";
import {
selectRecentNavigation,
} from "@/lib/recent-navigation";
import {
formatReleaseName,
} from "@/lib/release-presentation";
import type {
AppSnapshot,
ProjectRecord,
SavedViewRecord,
TaskRecord,
UserRecord,
WorkflowStatusRecord
} from "@/lib/types";
import {
sharedWithMeRoots,
} from "@/lib/workspace-scope";
import {
Boxes,
ChevronRight,
Circle,
FolderKanban,
Inbox,
Plus,
Rocket,
UsersRound,
Zap
} from "lucide-react";

import {
handleLocalLink,
shortDate
} from "@/components/task-tracker-dialogs";

import { ProjectsSurface } from "@/components/task-tracker-collection-surfaces";
import {
StatusIcon,
WorkspaceScopeSelector,
} from "@/components/task-tracker-tasks";
import {
completion
} from "@/components/task-tracker-view-helpers";

export function WorkspaceOverviewSurface({
  data,
  focusedData,
  statusMap,
  projectMap,
  workspaceScopeToken,
  workspaceScopeLoading,
  onWorkspaceScopeChange,
  onOpen,
  onOpenTask,
  onCreateTask,
  onCreateProject,
  onCreateRelease,
}: {
  data: AppSnapshot;
  focusedData: AppSnapshot;
  statusMap: Map<string, WorkflowStatusRecord>;
  projectMap: Map<string, ProjectRecord>;
  workspaceScopeToken: string;
  workspaceScopeLoading: boolean;
  onWorkspaceScopeChange: (token: string) => void;
  onOpen: (surface: string, layout?: Layout) => void;
  onOpenTask: (taskId: string) => void;
  onCreateTask: () => void;
  onCreateProject: () => void;
  onCreateRelease: () => void;
}) {
  const openTasks = focusedData.tasks.filter((task) => !task.archivedAt);
  const activeCount = focusedData.workspaceMetrics?.taskCounts.active ?? openTasks.filter((task) => {
    const category = statusMap.get(task.statusId)?.category;
    return category === "unstarted" || category === "started";
  }).length;
  const backlogCount = focusedData.workspaceMetrics?.taskCounts.backlog ?? openTasks.filter(
    (task) => statusMap.get(task.statusId)?.category === "backlog",
  ).length;
  const recentTasks = [...openTasks]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 5);
  const recentProjects = selectRecentNavigation(
    focusedData.navigationCollections?.projects.items ?? focusedData.projects,
  );
  const recentReleases = selectRecentNavigation(
    focusedData.navigationCollections?.releases.items ?? focusedData.releases,
  );
  const recentViews = selectRecentNavigation(
    focusedData.navigationCollections?.views.items ?? focusedData.views,
  );
  const { projects: sharedProjects, views: sharedViews } = sharedWithMeRoots(data);
  const sharedCount = sharedProjects.length + sharedViews.length;
  const isEmpty =
    openTasks.length === 0 &&
    (focusedData.navigationCollections?.projects.total ?? focusedData.projects.length) === 0 &&
    (focusedData.navigationCollections?.releases.total ?? focusedData.releases.length) === 0 &&
    (focusedData.navigationCollections?.views.total ?? focusedData.views.length) === 0 &&
    sharedCount === 0;
  const canCreateRelease = focusedData.projects.some((project) => canEditContent(project.accessRole));
  const scopeOptions = focusedData.workspaceScope?.options ?? data.workspaceScope?.options ?? [];
  const scopeLabel = scopeOptions.find((option) => option.token === workspaceScopeToken)?.label ?? "My";

  return (
    <div className="workspace-overview">
      {scopeOptions.length > 0 && (
        <div className="workspace-focus-row">
          <div>
            <b>Workspace focus</b>
            <span>{scopeLabel === "My" ? "Only resources you own" : "Every resource you can access"}</span>
          </div>
          <WorkspaceScopeSelector
            value={workspaceScopeToken}
            options={scopeOptions}
            busy={workspaceScopeLoading}
            onChange={onWorkspaceScopeChange}
          />
        </div>
      )}
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
          title="Focused work"
          description={`${scopeLabel} resources inside Workspace only.`}
          href="/issues"
          label="My tasks"
          onOpen={() => onOpen("mine")}
        />
        <div className="workspace-metrics">
          <WorkspaceMetric label="Active" value={activeCount} icon={<Zap size={16} />} />
          <WorkspaceMetric label="Backlog" value={backlogCount} icon={<Inbox size={16} />} />
          <WorkspaceMetric label="Projects" value={focusedData.navigationCollections?.projects.total ?? focusedData.projects.length} icon={<FolderKanban size={16} />} />
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
                      <span className="workspace-record-copy"><b>{project.name}</b><small>{tasks.length} tasks · {completion(tasks, focusedData.statuses)}% complete</small></span>
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
                      <span className="workspace-record-copy"><b>{formatReleaseName(project?.name, release.name)}</b><small>{tasks.length} tasks · {completion(tasks, focusedData.statuses)}% complete</small></span>
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

export function WorkspaceSectionHeader({ id, title, description, href, label, onOpen }: { id: string; title: string; description: string; href: string; label: string; onOpen: () => void }) {
  return <header className="workspace-section-header"><div><h2 id={id}>{title}</h2><p>{description}</p></div><a href={href} onClick={(event) => handleLocalLink(event, onOpen)}>{label}<ChevronRight size={13} aria-hidden="true" /></a></header>;
}

export function WorkspaceMetric({ href, label, value, icon, onOpen }: { href?: string; label: string; value: number; icon: React.ReactNode; onOpen?: () => void }) {
  const content = <><span className="workspace-metric-icon">{icon}</span><span><b>{value}</b><small>{label}</small></span>{href && <ChevronRight size={14} aria-hidden="true" />}</>;
  return href && onOpen
    ? <a className="workspace-metric" href={href} onClick={(event) => handleLocalLink(event, onOpen)}>{content}</a>
    : <div className="workspace-metric">{content}</div>;
}

export function WorkspaceSectionEmpty({ title, description }: { title: string; description: string }) {
  return <div className="workspace-section-empty"><b>{title}</b><p>{description}</p></div>;
}

export function WorkspaceSharedCount({ label, value }: { label: string; value: number }) {
  return <span><b>{value}</b><small>{label}</small></span>;
}

export function SharedWithMeSurface({ data, tasks, statuses, users, onOpenProject, onOpenView, onProjectContextActions }: {
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
