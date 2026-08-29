import { withUserResponse } from "@/lib/http";
import {
  advanceSystemBackupJob,
  assertSystemBackupAction,
} from "@/lib/system-backup-jobs";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  return withUserResponse(async (user, actor) => {
    assertSystemBackupAction(request);
    const { jobId } = await context.params;
    return Response.json(
      await advanceSystemBackupJob(user, decodeURIComponent(jobId), actor),
      { headers: { "cache-control": "no-store" } },
    );
  });
}
