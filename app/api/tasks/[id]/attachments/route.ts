import {
  attachmentLimits,
  bindStoredFileToTask,
  createAttachment,
  listTaskAttachments,
  publicAttachment,
  readBoundedAttachmentBody,
  resolveTaskAttachments,
} from "@/lib/attachments";
import { ValidationError } from "@/lib/domain";
import { readJson, withUser, withUserResponse } from "@/lib/http";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const url = new URL(request.url);
  return withUser(async (user) => {
    const refs = url.searchParams.getAll("refs");
    if (refs.length > 0) {
      const attachments = await resolveTaskAttachments(user, id, refs);
      return { attachments: attachments.map(publicAttachment) };
    }
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
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json") {
      const input = await readJson(request);
      const fileRef = requiredText(input.fileRef, "fileRef", 200);
      const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 200);
      const displayName = input.displayName == null
        ? null
        : requiredText(input.displayName, "displayName", 512);
      const attachment = await bindStoredFileToTask(user, id, fileRef, {
        idempotencyKey,
        displayName,
      });
      return Response.json(
        { attachment: publicAttachment(attachment) },
        { status: 201 },
      );
    }
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

function requiredText(value: unknown, name: string, maximum: number) {
  if (typeof value !== "string") throw new ValidationError(`${name} is required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new ValidationError(`${name} is invalid`);
  }
  return normalized;
}
