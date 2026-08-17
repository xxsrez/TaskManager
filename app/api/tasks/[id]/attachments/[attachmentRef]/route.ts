import {
  deleteAttachment,
  publicAttachment,
  restoreAttachment,
} from "@/lib/attachments";
import { ValidationError } from "@/lib/domain";
import { readJson, withUser } from "@/lib/http";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; attachmentRef: string }> },
) {
  const { id, attachmentRef } = await context.params;
  return withUser(async (user) => {
    const version = Number(request.headers.get("x-attachment-version"));
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new ValidationError("X-Attachment-Version is required");
    }
    return {
      attachment: publicAttachment(
        await deleteAttachment(user, id, attachmentRef, version),
      ),
    };
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; attachmentRef: string }> },
) {
  const input = await readJson(request);
  const { id, attachmentRef } = await context.params;
  return withUser(async (user) => {
    if (input.deleted !== false) {
      throw new ValidationError("Only attachment restoration is supported");
    }
    const version = Number(input.version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new ValidationError("Attachment version is required");
    }
    return {
      attachment: publicAttachment(
        await restoreAttachment(user, id, attachmentRef, version),
      ),
    };
  });
}
