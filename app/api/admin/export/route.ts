import { withUserResponse } from "@/lib/http";
import { exportSystemBackup } from "@/lib/system-backup";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUserResponse(async (user) => {
    assertSystemBackupRequest(request);
    const backup = await exportSystemBackup(user);
    const date = backup.exportedAt.slice(0, 10);
    return new Response(JSON.stringify(backup), {
      headers: {
        "cache-control": "no-store, max-age=0",
        "content-disposition": `attachment; filename="task-manager-backup-${date}.json"`,
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  });
}

function assertSystemBackupRequest(request: Request) {
  if (request.headers.get("x-task-manager-action") !== "system-backup") {
    throw Object.assign(new Error("Invalid system backup request"), { status: 403 });
  }
}
