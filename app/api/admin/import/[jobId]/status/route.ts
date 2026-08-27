import { withUserResponse } from "@/lib/http";
import {
  assertSystemBackupAction,
  getSystemBackupJobStatus,
} from "@/lib/system-backup-jobs";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  return withUserResponse(async (user) => {
    assertSystemBackupAction(request);
    const { jobId } = await context.params;
    return Response.json(
      await getSystemBackupJobStatus(user, decodeURIComponent(jobId)),
      { headers: { "cache-control": "no-store" } },
    );
  });
}
