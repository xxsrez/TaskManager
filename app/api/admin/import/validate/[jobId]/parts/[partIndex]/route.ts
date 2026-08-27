import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import { withUserResponse } from "@/lib/http";
import {
  assertSystemBackupAction,
  systemBackupUploadContract,
  uploadSystemBackupImportPart,
} from "@/lib/system-backup-jobs";

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: { params: Promise<{ jobId: string; partIndex: string }> },
) {
  return withUserResponse(async (user) => {
    assertSystemBackupAction(request);
    const { jobId, partIndex } = await context.params;
    const value = await readBoundedJsonRequest(
      request,
      systemBackupUploadContract.maxPartBytes + 900_000,
    );
    return Response.json(
      await uploadSystemBackupImportPart(
        user,
        decodeURIComponent(jobId),
        Number(partIndex),
        value,
      ),
      { headers: { "cache-control": "no-store" } },
    );
  });
}
