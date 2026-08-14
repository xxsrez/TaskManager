import { chatGPTSignInPath } from "@/app/chatgpt-auth";
import { ProjectBackupManager } from "@/components/project-backup-manager";
import { getCurrentActor } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function ProjectBackupPage() {
  const actor = await getCurrentActor();
  if (!actor) {
    return <main className="import-shell"><section className="import-card"><h1>Project backup</h1><p>Sign in before exporting or restoring a project.</p><a className="button primary" href={chatGPTSignInPath("/import/project")}>Continue with ChatGPT</a></section></main>;
  }
  return <ProjectBackupManager />;
}
