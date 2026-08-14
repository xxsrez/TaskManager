import { chatGPTSignInPath } from "@/app/chatgpt-auth";
import { LinearImporter } from "@/components/linear-importer";
import { getCurrentActor } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LinearImportPage() {
  const actor = await getCurrentActor();
  if (!actor) {
    return (
      <main className="import-shell">
        <section className="import-card">
          <h1>Linear import</h1>
          <p>Sign in before importing a workspace snapshot.</p>
          <a className="button primary" href={chatGPTSignInPath("/import/linear")}>
            Continue with ChatGPT
          </a>
        </section>
      </main>
    );
  }

  return <LinearImporter />;
}
