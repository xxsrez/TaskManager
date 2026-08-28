import { withUserResponse } from "@/lib/http";
import {
  assertSystemBackupAction,
  getCurrentSystemBackupExportJob,
} from "@/lib/system-backup-jobs";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withUserResponse(async (user) => {
    assertSystemBackupAction(request);
    return Response.json(await getCurrentSystemBackupExportJob(user), {
      headers: { "cache-control": "no-store, max-age=0" },
    });
  });
}
