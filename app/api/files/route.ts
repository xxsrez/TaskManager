import {
  attachmentLimits,
  createStoredFile,
  publicStoredFile,
  readBoundedAttachmentBody,
} from "@/lib/attachments";
import { ValidationError } from "@/lib/domain";
import { withUserResponse } from "@/lib/http";

export async function POST(request: Request) {
  return withUserResponse(async (user) => {
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
    const file = await createStoredFile(user, {
      body,
      filename,
      claimedMediaType: contentType,
      idempotencyKey,
    });
    return Response.json({ file: publicStoredFile(file) }, { status: 201 });
  });
}
