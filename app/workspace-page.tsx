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
  INITIAL_UI_SNAPSHOT_TASKS,
} from "@/lib/repository";
import type { AppSnapshot } from "@/lib/types";

const loadWorkspaceSnapshot = cache(async (includeAdminOverview: boolean) => {
  const actor = await getCurrentActor();
  if (!actor) return null;
  const user = await getOrCreateUser(actor);
  return getSnapshot(user, {
    includeAdminOverview,
    taskLimit: INITIAL_UI_SNAPSHOT_TASKS,
  });
});

export async function WorkspacePage({ pathname }: { pathname: string }) {
  const target = parseNavigationPath(pathname);
  if (!target) notFound();

  const baseSnapshot = await loadWorkspaceSnapshot(target.kind === "admin");
  if (!baseSnapshot) return <SignInPage returnTo={pathname} />;

  const addressableSnapshot = await withAddressedTaskDetail(baseSnapshot, target);
  const navigation = resolveNavigationTarget(target, addressableSnapshot);
  if (!navigation) notFound();
  const redirectTo = legacyRedirectPath(target, addressableSnapshot);
  if (redirectTo) redirect(redirectTo);
  const snapshot = await withSelectedTaskDetail(addressableSnapshot, navigation);

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

  const baseSnapshot = await loadWorkspaceSnapshot(target.kind === "admin");
  if (!baseSnapshot) return signedOutMetadata();
  const addressableSnapshot = await withAddressedTaskDetail(baseSnapshot, target);
  const navigation = resolveNavigationTarget(target, addressableSnapshot);
  if (!navigation) return notFoundMetadata();
  const snapshot = await withSelectedTaskDetail(addressableSnapshot, navigation);
  return metadataForNavigation(navigation, snapshot);
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
