import { applyProjectBackup } from "@/lib/project-backup";
import { readJson, withUser } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (request.headers.get("x-task-manager-action") !== "project-backup") {
    return Response.json({ error: "Project backup action header is required" }, { status: 400 });
  }
  const input = await readJson(request);
  return withUser((user) => applyProjectBackup(user, {
    importId: String(input.importId ?? ""),
    sha256: String(input.sha256 ?? ""),
    confirmation: String(input.confirmation ?? ""),
    currentBackupDownloaded: input.currentBackupDownloaded === true,
    restoreSharing: input.restoreSharing === true,
    externalRelationsAcknowledged: input.externalRelationsAcknowledged === true,
  }));
}
