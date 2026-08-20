import {
  attachmentLimits,
  readBoundedAttachmentBody,
} from "@/lib/attachments";
import {
  parseAgentAttachmentListQuery,
} from "@/lib/agent-api-contract";
import { withAgentApi } from "@/lib/agent-api-http";
import {
  attachAgentStoredFileToTask,
  assertAgentTaskAttachmentWriteAccess,
  createAgentTaskAttachment,
  listAgentTaskAttachments,
} from "@/lib/agent-api-repository";
import { ValidationError } from "@/lib/domain";
import { readJson } from "@/lib/http";
import { publicOrigin } from "@/lib/oauth";

export async function GET(
  request: Request,
  context: { params: Promise<{ ref: string }> },
) {
  const { ref } = await context.params;
  return withAgentApi(request, "api:read", async ({ user }) => {
    const query = await parseAgentAttachmentListQuery(
      new URL(request.url).searchParams,
      ref,
    );
    return listAgentTaskAttachments(user, ref, query, publicOrigin(request));
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ ref: string }> },
) {
  const { ref } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => {
    await assertAgentTaskAttachmentWriteAccess(user, ref);
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json") {
      const input = await readJson(request);
      const fileRef = requiredText(input.fileRef, "fileRef", 200);
      const idempotencyKey = requiredText(
        input.idempotencyKey,
        "idempotencyKey",
        200,
      );
      const displayName = input.displayName == null
        ? null
        : requiredText(input.displayName, "displayName", 512);
      return {
        data: await attachAgentStoredFileToTask(
          user,
          ref,
          fileRef,
          { idempotencyKey, displayName },
          publicOrigin(request),
        ),
        status: 201,
      };
    }
    const encodedFilename = request.headers.get("x-attachment-filename");
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!encodedFilename) {
      throw new ValidationError("X-Attachment-Filename is required");
    }
    if (!idempotencyKey) {
      throw new ValidationError("Idempotency-Key is required");
    }
    let filename: string;
    try {
      filename = decodeURIComponent(encodedFilename);
    } catch {
      throw new ValidationError("X-Attachment-Filename is invalid");
    }
    const body = await readBoundedAttachmentBody(
      request,
      attachmentLimits().maxBytes,
    );
    return {
      data: await createAgentTaskAttachment(
        user,
        ref,
        {
          body,
          filename,
          claimedMediaType: request.headers.get("content-type"),
          idempotencyKey,
        },
        publicOrigin(request),
      ),
      status: 201,
    };
  });
}

function requiredText(value: unknown, name: string, maximum: number) {
  if (typeof value !== "string") {
    throw new ValidationError(`${name} is required`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new ValidationError(`${name} is invalid`);
  }
  return normalized;
}
