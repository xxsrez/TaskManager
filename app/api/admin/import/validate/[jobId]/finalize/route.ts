import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import { withUserResponse } from "@/lib/http";
import {
  assertSystemBackupAction,
  finalizeSystemBackupImport,
} from "@/lib/system-backup-jobs";
import { maxSystemBackupPartBytes } from "@/lib/system-backup-package";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  return withUserResponse(async (user) => {
    assertSystemBackupAction(request);
    const { jobId } = await context.params;
    const manifest = await readBoundedJsonRequest(request, maxSystemBackupPartBytes);
    return Response.json(
      await finalizeSystemBackupImport(user, decodeURIComponent(jobId), manifest),
      { headers: { "cache-control": "no-store" } },
    );
  });
}
