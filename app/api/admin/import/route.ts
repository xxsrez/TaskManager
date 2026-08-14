import { withUserResponse } from "@/lib/http";
import { applySystemBackup } from "@/lib/system-backup";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUserResponse(async (user) => {
    assertSystemBackupRequest(request);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid restore request" }, { status: 400 });
    }
    const input = body as Record<string, unknown>;
    return Response.json(await applySystemBackup(user, {
      importId: String(input.importId ?? ""),
      sha256: String(input.sha256 ?? ""),
      confirmation: String(input.confirmation ?? ""),
    }), { headers: { "cache-control": "no-store" } });
  });
}

function assertSystemBackupRequest(request: Request) {
  if (request.headers.get("x-task-manager-action") !== "system-backup") {
    throw Object.assign(new Error("Invalid system backup request"), { status: 403 });
  }
}
