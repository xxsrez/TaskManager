import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
} from "./chatgpt-auth";
import { TaskTracker } from "@/components/task-tracker";
import { getCurrentActor } from "@/lib/auth";
import {
  legacyRedirectPath,
  parseNavigationPath,
  resolveNavigationTarget,
  type ResolvedNavigation,
} from "@/lib/navigation";
import { getOrCreateUser, getSnapshot } from "@/lib/repository";
import type { AppSnapshot } from "@/lib/types";

const loadWorkspaceSnapshot = cache(async () => {
  const actor = await getCurrentActor();
  if (!actor) return null;
  const user = await getOrCreateUser(actor);
  return getSnapshot(user);
});

export async function WorkspacePage({ pathname }: { pathname: string }) {
  const target = parseNavigationPath(pathname);
  if (!target) notFound();

  const snapshot = await loadWorkspaceSnapshot();
  if (!snapshot) return <SignInPage returnTo={pathname} />;

  const navigation = resolveNavigationTarget(target, snapshot);
  if (!navigation) notFound();
  const redirectTo = legacyRedirectPath(target, snapshot);
  if (redirectTo) redirect(redirectTo);

  return (
    <TaskTracker
      initialData={snapshot}
      initialNavigation={navigation}
      signOutPath={chatGPTSignOutPath("/")}
    />
  );
}

export async function workspaceMetadata(pathname: string): Promise<Metadata> {
  const target = parseNavigationPath(pathname);
  if (!target) return notFoundMetadata();

  const snapshot = await loadWorkspaceSnapshot();
  if (!snapshot) return signedOutMetadata();
  const navigation = resolveNavigationTarget(target, snapshot);
  if (!navigation) return notFoundMetadata();
  return metadataForNavigation(navigation, snapshot);
}

function SignInPage({ returnTo }: { returnTo: string }) {
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="product-mark large" aria-hidden="true">T</div>
        <div className="auth-copy">
          <span className="eyebrow">TASK MANAGER</span>
          <h1>Move work forward.</h1>
          <p>
            A focused workspace for tasks, projects, releases, and the views
            that keep them clear.
          </p>
        </div>
        <a className="button primary auth-button" href={chatGPTSignInPath(returnTo)}>
          Continue with ChatGPT
        </a>
        <p className="auth-note">
          Your workspace is private by default. Google sign-in is being
          connected through the Sites identity boundary.
        </p>
      </section>
    </main>
  );
}

function metadataForNavigation(
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
      title = `${release.name}${navigation.layout === "board" ? " board" : ""} – Task Manager`;
      description = summary(
        release.description ||
          `${release.name}${project ? ` for ${project.name}` : ""}.`,
      );
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
  } else if (["all", "active", "backlog", "archived"].includes(navigation.surface)) {
    const label = {
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
  } else if (navigation.surface === "admin") {
    title = "Administration – Task Manager";
    description = "Registration and activity overview for Task Manager administrators.";
  }

  return {
    title,
    description,
    openGraph: { title, description, images: [] },
    twitter: { card: "summary", title, description, images: [] },
  };
}

function signedOutMetadata(): Metadata {
  const title = "Sign in – Task Manager";
  const description = "Sign in to open this Task Manager link.";
  return {
    title,
    description,
    openGraph: { title, description, images: [] },
    twitter: { card: "summary", title, description, images: [] },
  };
}

function notFoundMetadata(): Metadata {
  return {
    title: "Not found – Task Manager",
    robots: { index: false, follow: false },
    openGraph: { title: "Not found – Task Manager", images: [] },
    twitter: { card: "summary", title: "Not found – Task Manager", images: [] },
  };
}

function summary(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}…`;
}
