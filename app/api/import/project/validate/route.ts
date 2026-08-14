import { withUser } from "@/lib/http";
import { maxProjectBackupBytes } from "@/lib/project-backup-format";
import { stageProjectBackup } from "@/lib/project-backup";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (request.headers.get("x-task-manager-action") !== "project-backup") {
    return Response.json({ error: "Project backup action header is required" }, { status: 400 });
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxProjectBackupBytes) return Response.json({ error: "Project backup is too large" }, { status: 413 });
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maxProjectBackupBytes) {
    return Response.json({ error: "Project backup is too large" }, { status: 413 });
  }
  const payload = (() => { try { return JSON.parse(body) as unknown; } catch { return null; } })();
  return withUser((user) => stageProjectBackup(user, payload, new URL(request.url).origin));
}
