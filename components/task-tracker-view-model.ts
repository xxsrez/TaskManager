"use client";

import { useMemo } from "react";
import { canEditContent } from "@/lib/access";
import { selectRecentNavigation } from "@/lib/recent-navigation";
import { taskMutationVersion } from "@/lib/task-detail-reconciliation";
import { defaultViewDisplay } from "@/lib/view-contract";
import { sharedWithMeRoots } from "@/lib/workspace-scope";
import type {
  AppSnapshot,
  SavedViewRecord,
  TaskRecord,
  TeamDetail,
  ViewDisplay,
  ViewQuery,
  WorkspaceCatalogKind,
  WorkspaceCatalogPage,
} from "@/lib/types";
import {
  builtInViews,
  mergeUnique,
  resolveArchiveBulkAction,
} from "@/components/task-tracker-state";
import {
  projectContextualEntity,
  releaseContextualEntity,
  resolveShareContext,
  surfaceBreadcrumbs,
  viewContextualEntity,
} from "@/components/task-tracker-view";

export function useTaskTrackerViewModel({
  data,
  surface,
  search,
  sidebarCollapsed,
  mobileSidebarOpen,
  activeSavedView,
  activeTeamPublicId,
  activeTeamDetail,
  teamCount,
  catalogPages,
  visibleTasks,
  activeTask,
  selected,
  currentDisplay,
  canonicalTemporaryQuery,
}: {
  data: AppSnapshot;
  surface: string;
  search: string;
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  activeSavedView?: SavedViewRecord;
  activeTeamPublicId: string | null;
  activeTeamDetail: TeamDetail | null;
  teamCount?: number;
  catalogPages: Partial<Record<WorkspaceCatalogKind, WorkspaceCatalogPage>>;
  visibleTasks: TaskRecord[];
  activeTask: TaskRecord | null;
  selected: Set<string>;
  currentDisplay: ViewDisplay;
  canonicalTemporaryQuery: ViewQuery;
}) {
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
  const userMap = useMemo(
    () => new Map([...data.users, data.user].map((user) => [user.id, user])),
    [data.user, data.users],
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
    : projectReleaseSurfaceId ?? contextReleaseRecord?.projectId ?? activeSavedView?.scopeProjectId ?? null;
  const contextProjectRecord = contextProject
    ? data.projects.find((project) => project.id === contextProject)
    : undefined;
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
            ? teamCount ?? ""
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
  const surfaceContextualEntity = contextReleaseRecord
    ? releaseContextualEntity(contextReleaseRecord)
    : activeSavedView
      ? viewContextualEntity(activeSavedView)
      : surface.startsWith("project:") && contextProjectRecord
        ? projectContextualEntity(contextProjectRecord)
        : null;
  const currentShareContext = resolveShareContext(surface, activeTask, data);
  const canCreateTask = contextProjectRecord
    ? !contextProjectRecord.archivedAt && canEditContent(contextProjectRecord.accessRole)
    : data.projects.some((project) => !project.archivedAt && canEditContent(project.accessRole));
  const canSaveView = contextProjectRecord
    ? canEditContent(contextProjectRecord.accessRole)
    : activeSavedView
      ? canEditContent(activeSavedView.accessRole)
      : true;
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
    search.trim() || (canonicalTemporaryQuery.conditions?.length ?? 0),
  );
  const hasDisplayChanges = JSON.stringify(currentDisplay) !== JSON.stringify(
    activeSavedView?.display ?? defaultViewDisplay(),
  );

  return {
    statusMap,
    projectMap,
    releaseMap,
    userMap,
    sidebarViews,
    sidebarProjects,
    sidebarReleases,
    breadcrumbs: surfaceBreadcrumbs(surface, data, activeSavedView, activeTeamDetail?.team.name),
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
    sidebarCompact: sidebarCollapsed && !mobileSidebarOpen,
    searchLabel,
    hasTemporaryFilters,
    hasDisplayChanges,
    hasRuntimeViewChanges: hasTemporaryFilters || hasDisplayChanges,
  };
}
