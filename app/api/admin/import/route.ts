import { withUserResponse } from "@/lib/http";
import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import {
  applySystemBackupImport,
  assertSystemBackupAction,
} from "@/lib/system-backup-jobs";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUserResponse(async (user) => {
    assertSystemBackupAction(request);
    const body = await readBoundedJsonRequest(request, 64_000);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid restore request" }, { status: 400 });
    }
    const input = body as Record<string, unknown>;
    return Response.json(await applySystemBackupImport(user, {
      importId: String(input.importId ?? ""),
      sha256: String(input.sha256 ?? ""),
      confirmation: String(input.confirmation ?? ""),
    }), { headers: { "cache-control": "no-store" } });
  });
}
