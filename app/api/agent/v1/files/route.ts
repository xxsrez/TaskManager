import {
  attachmentLimits,
  readBoundedAttachmentBody,
} from "@/lib/attachments";
import { withAgentApi } from "@/lib/agent-api-http";
import { createAgentStoredFile } from "@/lib/agent-api-repository";
import { ValidationError } from "@/lib/domain";

export async function POST(request: Request) {
  return withAgentApi(request, "api:write", async ({ user }) => {
    const encodedFilename = request.headers.get("x-file-filename");
    const idempotencyKey = request.headers.get("idempotency-key");
    const contentType = request.headers.get("content-type");
    if (!encodedFilename) throw new ValidationError("X-File-Filename is required");
    if (!idempotencyKey) throw new ValidationError("Idempotency-Key is required");
    if (!contentType) throw new ValidationError("Content-Type is required");
    let filename: string;
    try {
      filename = decodeURIComponent(encodedFilename);
    } catch {
      throw new ValidationError("X-File-Filename is invalid");
    }
    const body = await readBoundedAttachmentBody(
      request,
      attachmentLimits().maxBytes,
    );
    return {
      data: await createAgentStoredFile(user, {
        body,
        filename,
        claimedMediaType: contentType,
        idempotencyKey,
      }),
      status: 201,
    };
  });
}
