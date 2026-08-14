import { chatGPTSignInPath } from "@/app/chatgpt-auth";
/* eslint-disable @next/next/no-html-link-for-pages */
import { getCurrentActor } from "@/lib/auth";
import { Download, MoveRight, Upload } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ImportExportPage() {
  const actor = await getCurrentActor();
  if (!actor) {
    return (
      <main className="import-shell"><section className="import-card">
        <h1>Import &amp; export</h1>
        <p>Sign in before moving project data.</p>
        <a className="button primary" href={chatGPTSignInPath("/import")}>Continue with ChatGPT</a>
      </section></main>
    );
  }
  return (
    <main className="import-shell"><section className="import-card import-hub">
      <div><span className="eyebrow">TASK MANAGER</span><h1>Import &amp; export</h1><p>Back up one project or migrate selected work from Linear.</p></div>
      <div className="import-options">
        <a href="/import/project"><span className="import-option-icon"><Download size={18} /></span><span><b>Project backup</b><small>Owner-only export and exact restore</small></span><MoveRight size={16} /></a>
        <a href="/import/linear"><span className="import-option-icon"><Upload size={18} /></span><span><b>Import from Linear</b><small>Workspace, projects, or assignees</small></span><MoveRight size={16} /></a>
      </div>
      <a className="button secondary" href="/">Back to Task Manager</a>
    </section></main>
  );
}
