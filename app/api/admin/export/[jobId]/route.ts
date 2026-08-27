import { withUserResponse } from "@/lib/http";
import { streamSystemBackupPackage } from "@/lib/system-backup-jobs";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  return withUserResponse(async (user) => {
    const { jobId } = await context.params;
    const rawFromPart = new URL(request.url).searchParams.get("fromPart") ?? "0";
    return streamSystemBackupPackage(user, decodeURIComponent(jobId), Number(rawFromPart));
  });
}
