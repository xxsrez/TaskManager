import { withUserResponse } from "@/lib/http";
import {
  assertSystemBackupAction,
  createSystemBackupExportJob,
  systemBackupRequestOrigin,
} from "@/lib/system-backup-jobs";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUserResponse(async (user) => {
    assertSystemBackupAction(request);
    return Response.json(await createSystemBackupExportJob(user, {
      siteOrigin: systemBackupRequestOrigin(request),
    }), {
      headers: { "cache-control": "no-store, max-age=0" },
    });
  });
}
