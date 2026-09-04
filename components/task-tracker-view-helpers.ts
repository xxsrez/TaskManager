"use client";

import {
builtInViews,
type ShareContext,
type ShareTarget,
type TeamShareRoute
} from "@/components/task-tracker-state";
import {
type ContextualActionEntity,
} from "@/lib/contextual-actions";
import {
type Layout,
type SettingsSection
} from "@/lib/navigation";
import {
formatReleaseName,
} from "@/lib/release-presentation";
import {
taskMutationVersion,
} from "@/lib/task-detail-reconciliation";
import type {
AccessRole,
AppSnapshot,
Priority,
ProjectRecord,
ReleaseRecord,
SavedViewRecord,
TaskRecord,
ViewDisplay,
WorkflowStatusRecord
} from "@/lib/types";

import {
settingsNavigation
} from "@/components/task-tracker-dialogs";

import type { BreadcrumbItem } from "@/components/task-tracker-global-search";

export function defaultLayoutForSurface(surface: string, data: AppSnapshot): Layout {
  if (!surface.startsWith("view:")) return "list";
  return data.views.find(
    (view) => view.id === surface.slice(5) && !view.archivedAt,
  )?.display.layout ?? "list";
}

export function surfaceBreadcrumbs(
  surface: string,
  data: AppSnapshot,
  view?: SavedViewRecord,
  teamName?: string,
): BreadcrumbItem[] {
  const workspace: BreadcrumbItem = {
    label: "Workspace",
    surface: "workspace",
    layout: "list",
  };
  const current = (label: string): BreadcrumbItem => ({ label });
  const ancestor = (label: string, ancestorSurface: string, layout: Layout = "list"): BreadcrumbItem => ({
    label,
    surface: ancestorSurface,
    layout,
  });

  if (surface === "workspace") return [current("Workspace")];
  if (surface === "admin") return [workspace, current("Administration")];
  if (surface.startsWith("settings:")) {
    const section = surface.slice("settings:".length) as SettingsSection;
    const label = settingsNavigation.flatMap((group) => group.items)
      .find((item) => item.section === section)?.label ?? "Profile";
    return [workspace, ancestor("Settings", "settings:profile"), current(label)];
  }
  if (surface === "views") return [workspace, current("Views")];
  if (surface === "projects") return [workspace, current("Projects")];
  if (surface === "releases") return [workspace, current("Releases")];
  if (surface === "teams") return [workspace, current("Teams")];
  if (surface.startsWith("team:")) return [workspace, ancestor("Teams", "teams"), current(teamName ?? "Team")];
  if (surface === "shared") return [workspace, current("Shared with me")];

  if (surface.startsWith("view:")) {
    return [
      workspace,
      ancestor("Views", "views"),
      current(view?.name ?? "Saved view"),
    ];
  }

  if (surface.startsWith("project-releases:")) {
    const project = data.projects.find(
      (item) => item.id === surface.slice("project-releases:".length),
    );
    if (!project) return [workspace, ancestor("Projects", "projects"), current("Releases")];
    return [
      workspace,
      ancestor("Projects", "projects"),
      ancestor(project.name, `project:${project.id}`),
      current("Releases"),
    ];
  }

  if (surface.startsWith("project:")) {
    const project = data.projects.find((item) => item.id === surface.slice(8));
    return [
      workspace,
      ancestor("Projects", "projects"),
      current(project?.name ?? "Project"),
    ];
  }

  if (surface.startsWith("release:")) {
    const release = data.releases.find((item) => item.id === surface.slice(8));
    const project = release
      ? data.projects.find((item) => item.id === release.projectId)
      : undefined;
    if (!release || !project) {
      return [workspace, ancestor("Releases", "releases"), current(release?.name ?? "Release")];
    }
    return [
      workspace,
      ancestor("Projects", "projects"),
      ancestor(project.name, `project:${project.id}`),
      ancestor("Releases", `project-releases:${project.id}`),
      current(formatReleaseName(project.name, release.name)),
    ];
  }

  const builtIn = builtInViews.find((item) => item.id === surface);
  return [workspace, current(builtIn?.label ?? "My tasks")];
}
export function isCollectionSurface(surface: string) { return surface === "workspace" || surface === "shared" || surface === "admin" || surface === "views" || surface === "projects" || surface === "releases" || surface === "teams" || surface.startsWith("team:") || surface.startsWith("project-releases:") || surface.startsWith("settings:"); }
export function taskContextualEntity(task: TaskRecord): ContextualActionEntity {
  return { kind: "task", id: task.id, label: task.identifier, accessRole: task.accessRole, archivedAt: task.archivedAt, version: taskMutationVersion(task) };
}
export function projectContextualEntity(project: ProjectRecord): ContextualActionEntity {
  return { kind: "project", id: project.id, label: project.name, accessRole: project.accessRole, archivedAt: project.archivedAt ?? null, version: project.version };
}
export function releaseContextualEntity(release: ReleaseRecord): ContextualActionEntity {
  return { kind: "release", id: release.id, label: release.name, accessRole: release.accessRole, archivedAt: null, version: release.version };
}
export function viewContextualEntity(view: SavedViewRecord): ContextualActionEntity {
  return { kind: "saved_view", id: view.id, label: view.name, accessRole: view.accessRole, archivedAt: view.archivedAt ?? null, version: view.version };
}
export function resolveShareContext(
  surface: string,
  activeTask: TaskRecord | null,
  data: AppSnapshot,
): ShareContext | null {
  const canManage = (role: AccessRole) => role === "owner" || role === "manager";
  const projectTarget = (project: ProjectRecord | undefined): ShareTarget | null => {
    if (!project || !canManage(project.accessRole)) return null;
    return {
      resourceType: "project",
      resourceId: project.id,
      label: project.name,
      accessRole: project.accessRole,
      ownerUserId: project.ownerUserId,
      inherited: true,
    };
  };
  const projectRoute = (project: ProjectRecord | undefined): TeamShareRoute | null => {
    if (!project || !canManage(project.accessRole)) return null;
    return {
      key: `project:${project.id}`,
      resourceType: "project",
      resourceId: project.id,
      publicId: project.publicId,
      label: "Project access",
      explanation: "Adds the Team to the Project. Every Task, Release, and Project-scoped View inherits this role.",
      accessRole: project.accessRole,
    };
  };
  const taskRoute = (task: TaskRecord): TeamShareRoute | null => {
    if (!canManage(task.accessRole)) return null;
    return {
      key: `task:${task.id}`,
      resourceType: "task",
      resourceId: task.id,
      publicId: task.publicId,
      label: "This Task only",
      explanation: "Adds an explicit route to this Task only. It does not expose the Project, sibling Tasks, or Releases.",
      accessRole: task.accessRole,
    };
  };

  if (activeTask) {
    if (activeTask.projectId) {
      const project = data.projects.find((item) => item.id === activeTask.projectId);
      if (!project) return null;
      const directTarget = projectTarget(project);
      const teamRoutes = [projectRoute(project), taskRoute(activeTask)].filter(
        (route): route is TeamShareRoute => route !== null,
      );
      return directTarget || teamRoutes.length
        ? {
            key: `task:${activeTask.id}`,
            label: activeTask.identifier,
            directTarget,
            teamRoutes,
            teamUnavailableCopy: null,
          }
        : null;
    }
    const directTarget: ShareTarget | null = activeTask.accessRole === "owner"
      ? {
          resourceType: "task",
          resourceId: activeTask.id,
          label: activeTask.identifier,
          accessRole: activeTask.accessRole,
          ownerUserId: activeTask.ownerUserId,
          inherited: false,
        }
      : null;
    const route = taskRoute(activeTask);
    return directTarget || route
      ? {
          key: `task:${activeTask.id}`,
          label: activeTask.identifier,
          directTarget,
          teamRoutes: route ? [route] : [],
          teamUnavailableCopy: null,
        }
      : null;
  }
  if (surface.startsWith("project:")) {
    const project = data.projects.find((item) => item.id === surface.slice(8));
    const directTarget = projectTarget(project);
    const route = projectRoute(project);
    return directTarget && project
      ? {
          key: `project:${project.id}`,
          label: project.name,
          directTarget,
          teamRoutes: route ? [route] : [],
          teamUnavailableCopy: null,
        }
      : null;
  }
  if (surface.startsWith("project-releases:")) {
    const project = data.projects.find((item) => item.id === surface.slice("project-releases:".length));
    const directTarget = projectTarget(project);
    const route = projectRoute(project);
    return directTarget && project
      ? {
          key: `project-releases:${project.id}`,
          label: project.name,
          directTarget,
          teamRoutes: route ? [route] : [],
          teamUnavailableCopy: null,
        }
      : null;
  }
  if (surface.startsWith("release:")) {
    const release = data.releases.find((item) => item.id === surface.slice(8));
    const project = release
      ? data.projects.find((item) => item.id === release.projectId)
      : undefined;
    const directTarget = projectTarget(project);
    return release && directTarget
      ? {
          key: `release:${release.id}`,
          label: formatReleaseName(project?.name, release.name),
          directTarget,
          teamRoutes: [],
          teamUnavailableCopy: "Releases do not have a Team grant route. Manage Team access from the Project surface; direct People access here remains Project-based.",
        }
      : null;
  }
  if (surface.startsWith("view:")) {
    const view = data.views.find((item) => item.id === surface.slice(5));
    if (!view) return null;
    if (view.scopeProjectId) {
      const project = data.projects.find((item) => item.id === view.scopeProjectId);
      const directTarget = projectTarget(project);
      const route = projectRoute(project);
      return directTarget
        ? {
            key: `view:${view.id}`,
            label: view.name,
            directTarget,
            teamRoutes: route ? [route] : [],
            teamUnavailableCopy: null,
          }
        : null;
    }
    const directTarget: ShareTarget | null = view.accessRole === "owner"
      ? {
          resourceType: "saved_view",
          resourceId: view.id,
          label: view.name,
          accessRole: view.accessRole,
          ownerUserId: view.ownerUserId,
          inherited: false,
        }
      : null;
    const route = canManage(view.accessRole)
      ? {
          key: `saved_view:${view.id}`,
          resourceType: "saved_view" as const,
          resourceId: view.id,
          publicId: view.publicId,
          label: "This global View",
          explanation: "Adds the Team to this global View. The View still returns only Tasks each member can already access.",
          accessRole: view.accessRole,
        }
      : null;
    return directTarget || route
      ? {
          key: `view:${view.id}`,
          label: view.name,
          directTarget,
          teamRoutes: route ? [route] : [],
          teamUnavailableCopy: null,
        }
      : null;
  }
  return null;
}
export function statusGroupsForTasks(tasks: TaskRecord[], statuses: WorkflowStatusRecord[]) { const owners = new Set(tasks.map((task) => task.ownerUserId)); return statuses.filter((status) => !status.archivedAt && (owners.has(status.ownerUserId) || tasks.length === 0)).sort((a, b) => a.position - b.position); }
export function sortTasks(tasks: TaskRecord[], display?: ViewDisplay) {
  const orderBy = display?.orderBy ?? "priority";
  const direction = orderBy !== "manual" && display?.direction === "desc" ? -1 : 1;
  const priorityOrder: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  return [...tasks].sort((a, b) => {
    let comparison = 0;
    if (orderBy === "priority") comparison = priorityOrder[a.priority] - priorityOrder[b.priority];
    else if (orderBy === "created") comparison = a.createdAt.localeCompare(b.createdAt);
    else if (orderBy === "updated") comparison = a.updatedAt.localeCompare(b.updatedAt);
    else if (orderBy === "due") comparison = (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31");
    else if (orderBy === "title") comparison = a.title.toLocaleLowerCase().localeCompare(b.title.toLocaleLowerCase());
    else comparison = a.rank - b.rank;
    return comparison * direction || a.rank - b.rank || a.publicId.localeCompare(b.publicId);
  });
}
export function taskCountForView(id: string, data: AppSnapshot, statusMap: Map<string, WorkflowStatusRecord>) { const exact = data.workspaceMetrics?.taskCounts; if (id === "mine") return exact?.mine ?? data.tasks.filter((task) => !task.archivedAt && task.assigneeUserId === data.user.id).length; if (id === "archived") return exact?.archived ?? data.tasks.filter((task) => task.archivedAt).length; if (id === "backlog") return exact?.backlog ?? data.tasks.filter((task) => !task.archivedAt && statusMap.get(task.statusId)?.category === "backlog").length; if (id === "active") return exact?.active ?? data.tasks.filter((task) => !task.archivedAt && ["unstarted", "started"].includes(statusMap.get(task.statusId)?.category ?? "")).length; return exact?.all ?? data.tasks.filter((task) => !task.archivedAt).length; }
export function completion(tasks: TaskRecord[], statuses: WorkflowStatusRecord[]) { const statusMap = new Map(statuses.map((status) => [status.id, status])); const eligible = tasks.filter((task) => statusMap.get(task.statusId)?.category !== "canceled"); if (!eligible.length) return 0; return Math.round((eligible.filter((task) => statusMap.get(task.statusId)?.category === "completed").length / eligible.length) * 100); }
export function toggleSet(current: Set<string>, value: string) { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; }
export function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>) { return left.size === right.size && [...left].every((value) => right.has(value)); }
