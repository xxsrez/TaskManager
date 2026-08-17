import {
  attachmentLimits,
  createAttachment,
  listTaskAttachments,
  publicAttachment,
  readBoundedAttachmentBody,
} from "@/lib/attachments";
import { ValidationError } from "@/lib/domain";
import { withUser, withUserResponse } from "@/lib/http";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const url = new URL(request.url);
  return withUser(async (user) => {
    const page = await listTaskAttachments(user, id, {
      includeDeleted: url.searchParams.get("includeDeleted") === "true",
      limit: url.searchParams.has("limit")
        ? Number(url.searchParams.get("limit"))
        : undefined,
    });
    return {
      attachments: page.items.map(publicAttachment),
      totalCount: page.totalCount,
    };
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return withUserResponse(async (user) => {
    const encodedFilename = request.headers.get("x-attachment-filename");
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!encodedFilename) throw new ValidationError("X-Attachment-Filename is required");
    if (!idempotencyKey) throw new ValidationError("Idempotency-Key is required");
    let filename: string;
    try {
      filename = decodeURIComponent(encodedFilename);
    } catch {
      throw new ValidationError("X-Attachment-Filename is invalid");
    }
    const body = await readBoundedAttachmentBody(request, attachmentLimits().maxBytes);
    const attachment = await createAttachment(user, id, {
      body,
      filename,
      claimedMediaType: request.headers.get("content-type"),
      idempotencyKey,
    });
    return Response.json({ attachment: publicAttachment(attachment) }, { status: 201 });
  });
}
