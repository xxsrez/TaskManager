import { withUserResponse } from "@/lib/http";
import { maxSystemBackupBytes, stageSystemBackup } from "@/lib/system-backup";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUserResponse(async (user) => {
    assertSystemBackupRequest(request);
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > maxSystemBackupBytes) {
      return Response.json({ error: "Backup file is larger than 10 MB" }, { status: 413 });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(buffer)) as unknown;
    } catch {
      return Response.json({ error: "Backup file is not valid JSON" }, { status: 400 });
    }
    return Response.json(await stageSystemBackup(user, payload), {
      headers: { "cache-control": "no-store" },
    });
  });
}

function assertSystemBackupRequest(request: Request) {
  if (request.headers.get("x-task-manager-action") !== "system-backup") {
    throw Object.assign(new Error("Invalid system backup request"), { status: 403 });
  }
}
