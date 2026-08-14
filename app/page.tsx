import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
} from "./chatgpt-auth";
import { getCurrentActor } from "@/lib/auth";
import { getOrCreateUser, getSnapshot } from "@/lib/repository";
import { TaskTracker } from "@/components/task-tracker";

export const dynamic = "force-dynamic";

export default async function Home() {
  const actor = await getCurrentActor();
  if (!actor) {
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
          <a className="button primary auth-button" href={chatGPTSignInPath("/")}>
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

  const user = await getOrCreateUser(actor);
  const snapshot = await getSnapshot(user);
  return (
    <TaskTracker
      initialData={snapshot}
      signOutPath={chatGPTSignOutPath("/")}
    />
  );
}
