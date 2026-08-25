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
import { metadataForNavigation } from "@/lib/navigation-metadata";
import {
  getOrCreateUser,
  getSnapshot,
  getTask,
  loadAccessibleProject,
  loadAccessibleRelease,
  loadAccessibleView,
  INITIAL_UI_SNAPSHOT_TASKS,
} from "@/lib/repository";
import type { AppSnapshot } from "@/lib/types";
import { RECENT_NAVIGATION_LIMIT } from "@/lib/recent-navigation";
import { NotFoundError } from "@/lib/domain";
import {
  ALL_ACCESSIBLE_WORKSPACE_SCOPE,
  opaqueWorkspaceOwnerToken,
  workspaceOwnerUserId,
} from "@/lib/workspace-scope";

const loadWorkspaceSnapshot = cache(async (includeAdminOverview: boolean) => {
  const actor = await getCurrentActor();
  if (!actor) return null;
  const user = await getOrCreateUser(actor);
  return getSnapshot(user, {
    includeAdminOverview,
    taskLimit: INITIAL_UI_SNAPSHOT_TASKS,
    navigationLimit: RECENT_NAVIGATION_LIMIT,
    workspaceScope: null,
  });
});

export async function WorkspacePage({ pathname }: { pathname: string }) {
  const target = parseNavigationPath(pathname);
  if (!target) notFound();

  const loadedSnapshot = await loadWorkspaceSnapshot(target.kind === "admin");
  if (!loadedSnapshot) return <SignInPage returnTo={pathname} />;
  const baseSnapshot = target.kind === "shared"
    ? await getSnapshot(loadedSnapshot.user, {
        taskLimit: INITIAL_UI_SNAPSHOT_TASKS,
        navigationLimit: RECENT_NAVIGATION_LIMIT,
        workspaceScope: ALL_ACCESSIBLE_WORKSPACE_SCOPE,
      })
    : loadedSnapshot;

  const contextSnapshot = await withAddressedEntityContext(baseSnapshot, target);
  const addressableSnapshot = await withAddressedTaskDetail(contextSnapshot, target);
  const navigation = resolveNavigationTarget(target, addressableSnapshot);
  if (!navigation) notFound();
  const redirectTo = legacyRedirectPath(target, addressableSnapshot);
  if (redirectTo) redirect(redirectTo);
  const selectedSnapshot = await withSelectedTaskDetail(addressableSnapshot, navigation);
  const snapshot = await withAddressedWorkspaceScope(selectedSnapshot, navigation);

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

  const loadedSnapshot = await loadWorkspaceSnapshot(target.kind === "admin");
  if (!loadedSnapshot) return signedOutMetadata();
  const baseSnapshot = target.kind === "shared"
    ? await getSnapshot(loadedSnapshot.user, {
        taskLimit: INITIAL_UI_SNAPSHOT_TASKS,
        navigationLimit: RECENT_NAVIGATION_LIMIT,
        workspaceScope: ALL_ACCESSIBLE_WORKSPACE_SCOPE,
      })
    : loadedSnapshot;
  const contextSnapshot = await withAddressedEntityContext(baseSnapshot, target);
  const addressableSnapshot = await withAddressedTaskDetail(contextSnapshot, target);
  const navigation = resolveNavigationTarget(target, addressableSnapshot);
  if (!navigation) return notFoundMetadata();
  const selectedSnapshot = await withSelectedTaskDetail(addressableSnapshot, navigation);
  const snapshot = await withAddressedWorkspaceScope(selectedSnapshot, navigation);
  return metadataForNavigation(navigation, snapshot);
}

async function withAddressedWorkspaceScope(
  snapshot: AppSnapshot,
  navigation: ResolvedNavigation,
): Promise<AppSnapshot> {
  if (!snapshot.workspaceScope) return snapshot;
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const task = navigation.taskId
    ? snapshot.tasks.find((item) => item.id === navigation.taskId)
    : undefined;
  const record = task ?? (
    navigation.surface.startsWith("project:")
      ? snapshot.projects.find((item) => item.id === navigation.surface.slice(8))
      : navigation.surface.startsWith("project-releases:")
        ? snapshot.projects.find((item) => item.id === navigation.surface.slice("project-releases:".length))
        : navigation.surface.startsWith("release:")
          ? snapshot.releases.find((item) => item.id === navigation.surface.slice(8))
          : navigation.surface.startsWith("view:")
            ? snapshot.views.find((item) => item.id === navigation.surface.slice(5))
            : undefined
  );
  if (!record) return snapshot;
  const ownerUserId = workspaceOwnerUserId(record, projects);
  if (!ownerUserId) return snapshot;
  const token = await opaqueWorkspaceOwnerToken(ownerUserId);
  const option = snapshot.workspaceScope.options.find((item) => item.token === token);
  if (!option || option.token === snapshot.workspaceScope.selectedToken) return snapshot;

  const scoped = await getSnapshot(snapshot.user, {
    taskLimit: INITIAL_UI_SNAPSHOT_TASKS,
    navigationLimit: RECENT_NAVIGATION_LIMIT,
    workspaceScope: option.token,
  });
  return mergeAddressedContext(scoped, snapshot, navigation);
}

function mergeAddressedContext(
  scoped: AppSnapshot,
  addressed: AppSnapshot,
  navigation: ResolvedNavigation,
): AppSnapshot {
  const task = navigation.taskId
    ? addressed.tasks.find((item) => item.id === navigation.taskId)
    : undefined;
  const view = navigation.surface.startsWith("view:")
    ? addressed.views.find((item) => item.id === navigation.surface.slice(5))
    : undefined;
  const release = navigation.surface.startsWith("release:")
    ? addressed.releases.find((item) => item.id === navigation.surface.slice(8))
    : task?.releaseId
      ? addressed.releases.find((item) => item.id === task.releaseId)
      : undefined;
  const projectId = task?.projectId ?? release?.projectId ?? view?.scopeProjectId ?? (
    navigation.surface.startsWith("project:")
      ? navigation.surface.slice(8)
      : navigation.surface.startsWith("project-releases:")
        ? navigation.surface.slice("project-releases:".length)
        : null
  );
  const project = projectId
    ? addressed.projects.find((item) => item.id === projectId)
    : undefined;
  return {
    ...scoped,
    tasks: task ? prependUnique(task, scoped.tasks) : scoped.tasks,
    projects: project ? prependUnique(project, scoped.projects) : scoped.projects,
    releases: release ? prependUnique(release, scoped.releases) : scoped.releases,
    views: view ? prependUnique(view, scoped.views) : scoped.views,
  };
}

async function withAddressedEntityContext(
  snapshot: AppSnapshot,
  target: ReturnType<typeof parseNavigationPath>,
): Promise<AppSnapshot> {
  if (!target) return snapshot;
  try {
    if (target.kind === "view") {
      const view = await loadAccessibleView(snapshot.user.id, target.id);
      return { ...snapshot, views: prependUnique(view, snapshot.views) };
    }
    if (target.kind === "project" || target.kind === "projectReleases") {
      const reference = target.kind === "project" ? target.id : target.projectId;
      const project = await loadAccessibleProject(snapshot.user.id, reference);
      return { ...snapshot, projects: prependUnique(project, snapshot.projects) };
    }
    if (target.kind === "projectRelease") {
      const [project, release] = await Promise.all([
        loadAccessibleProject(snapshot.user.id, target.projectId),
        loadAccessibleRelease(snapshot.user.id, target.releaseId),
      ]);
      return {
        ...snapshot,
        projects: prependUnique(project, snapshot.projects),
        releases: prependUnique(release, snapshot.releases),
      };
    }
    if (target.kind === "legacyRelease") {
      const release = await loadAccessibleRelease(snapshot.user.id, target.id);
      const project = await loadAccessibleProject(snapshot.user.id, release.projectId);
      return {
        ...snapshot,
        projects: prependUnique(project, snapshot.projects),
        releases: prependUnique(release, snapshot.releases),
      };
    }
  } catch (error) {
    if (error instanceof NotFoundError) return snapshot;
    throw error;
  }
  return snapshot;
}

function prependUnique<T extends { id: string }>(record: T, records: T[]) {
  return [record, ...records.filter((item) => item.id !== record.id)];
}

async function withAddressedTaskDetail(
  snapshot: AppSnapshot,
  target: ReturnType<typeof parseNavigationPath>,
): Promise<AppSnapshot> {
  if (!target || (target.kind !== "issue" && target.kind !== "legacyTask")) {
    return snapshot;
  }
  const task = await getTask(snapshot.user, target.id);
  const exists = snapshot.tasks.some((item) => item.id === task.id);
  return {
    ...snapshot,
    tasks: exists
      ? snapshot.tasks.map((item) => item.id === task.id ? task : item)
      : [task, ...snapshot.tasks],
  };
}

async function withSelectedTaskDetail(
  snapshot: AppSnapshot,
  navigation: ResolvedNavigation,
): Promise<AppSnapshot> {
  if (!navigation.taskId) return snapshot;
  const selected = snapshot.tasks.find((item) => item.id === navigation.taskId);
  if (selected?.description !== null) return snapshot;
  const task = await getTask(snapshot.user, navigation.taskId);
  return {
    ...snapshot,
    tasks: snapshot.tasks.map((item) => item.id === task.id ? task : item),
  };
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
