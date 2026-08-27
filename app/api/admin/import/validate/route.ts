import { withUserResponse } from "@/lib/http";
import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import {
  assertSystemBackupAction,
  createSystemBackupImportJob,
} from "@/lib/system-backup-jobs";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUserResponse(async (user) => {
    assertSystemBackupAction(request);
    const header = await readBoundedJsonRequest(request, 64_000);
    return Response.json(await createSystemBackupImportJob(user, header), {
      headers: { "cache-control": "no-store" },
    });
  });
}
