import type { Metadata } from "next";
import type { ResolvedNavigation } from "./navigation";
import { formatReleaseDocumentTitle, formatReleaseName } from "./release-presentation";
import type { AppSnapshot } from "./types";

export function metadataForNavigation(
  navigation: ResolvedNavigation,
  data: AppSnapshot,
): Metadata {
  let title = "Task Manager";
  let description = "A focused workspace for tasks, projects, releases, and saved views.";

  if (navigation.taskId) {
    const task = data.tasks.find((item) => item.id === navigation.taskId);
    if (task) {
      title = `${task.identifier}: ${task.title} – Task Manager`;
      description = summary(task.description || task.title);
    }
  } else if (navigation.surface === "workspace") {
    title = "Workspace – Task Manager";
    description = "Your tasks, projects, releases, saved views, and shared resources in one overview.";
  } else if (navigation.surface.startsWith("project:")) {
    const project = data.projects.find(
      (item) => item.id === navigation.surface.slice(8),
    );
    if (project) {
      title = `${project.name}${navigation.layout === "board" ? " board" : ""} – Task Manager`;
      description = summary(project.summary || project.description || `Tasks in ${project.name}.`);
    }
  } else if (navigation.surface.startsWith("release:")) {
    const release = data.releases.find(
      (item) => item.id === navigation.surface.slice(8),
    );
    const project = release
      ? data.projects.find((item) => item.id === release.projectId)
      : undefined;
    if (release) {
      const releaseName = formatReleaseName(project?.name, release.name);
      title = formatReleaseDocumentTitle(project?.name, release.name, navigation.layout);
      description = summary(release.description || `${releaseName}.`);
    }
  } else if (navigation.surface.startsWith("view:")) {
    const view = data.views.find(
      (item) => item.id === navigation.surface.slice(5),
    );
    if (view) {
      title = `${view.name}${navigation.layout === "board" ? " board" : ""} – Task Manager`;
      description = `Saved ${navigation.layout} view in Task Manager.`;
    }
  } else if (navigation.surface.startsWith("project-releases:")) {
    const project = data.projects.find(
      (item) => item.id === navigation.surface.slice("project-releases:".length),
    );
    if (project) {
      title = `${project.name} releases – Task Manager`;
      description = `Releases in ${project.name}.`;
    }
  } else if (["mine", "all", "active", "backlog", "archived"].includes(navigation.surface)) {
    const label = {
      mine: "My tasks",
      all: "All tasks",
      active: "Active",
      backlog: "Backlog",
      archived: "Archived",
    }[navigation.surface];
    title = `${label}${navigation.layout === "board" ? " board" : ""} – Task Manager`;
    description = `${label} tasks in ${navigation.layout} layout.`;
  } else if (navigation.surface === "views") {
    title = "Views – Task Manager";
    description = "Built-in and saved task views in Task Manager.";
  } else if (navigation.surface === "projects") {
    title = "Projects – Task Manager";
    description = "Projects and their progress in Task Manager.";
  } else if (navigation.surface === "releases") {
    title = "Releases – Task Manager";
    description = "Project releases and their progress in Task Manager.";
  } else if (navigation.surface === "shared") {
    title = "Shared with me – Task Manager";
    description = "Task Manager resources shared with the current user.";
  } else if (navigation.surface === "teams") {
    title = "Teams – Task Manager";
    description = "Teams and their members in Task Manager.";
  } else if (navigation.surface.startsWith("team:")) {
    title = "Team – Task Manager";
    description = "Team members and access in Task Manager.";
  } else if (navigation.surface === "admin") {
    title = "Administration – Task Manager";
    description = "Registration and activity overview for Task Manager administrators.";
  } else if (navigation.surface.startsWith("settings:")) {
    const section = navigation.surface.slice("settings:".length)
      .replaceAll("-", " ");
    title = `${section[0]?.toUpperCase() ?? "S"}${section.slice(1)} settings – Task Manager`;
    description = "Personal preferences, workspace catalogs, integrations, and project backups in Task Manager.";
  }

  return {
    title,
    description,
    openGraph: { title, description, images: [] },
    twitter: { card: "summary", title, description, images: [] },
  };
}

function summary(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}…`;
}
