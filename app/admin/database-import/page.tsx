import { env } from "cloudflare:workers";

import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { isAdminEmail } from "@/lib/admin";

export const dynamic = "force-dynamic";

export default async function DatabaseImportPage() {
  const user = await requireChatGPTUser("/admin/database-import");
  const configuredEmails = (
    env as unknown as { TASK_MANAGER_ADMIN_EMAILS?: string }
  ).TASK_MANAGER_ADMIN_EMAILS;

  if (!isAdminEmail(user.email, configuredEmails)) {
    return <main>Not found</main>;
  }

  return (
    <main>
      <h1>Database migration</h1>
      <form
        action="/admin/database-import/run"
        method="post"
        encType="multipart/form-data"
      >
        <label htmlFor="snapshot">Snapshot</label>
        <textarea id="snapshot" name="snapshot" required />
        <button type="submit">Import database</button>
      </form>
    </main>
  );
}
