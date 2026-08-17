import { withAgentApi } from "@/lib/agent-api-http";
import {
  deleteAgentTaskAttachment,
  getAgentTaskAttachment,
  restoreAgentTaskAttachment,
} from "@/lib/agent-api-repository";
import { ValidationError } from "@/lib/domain";
import { readJson } from "@/lib/http";
import { publicOrigin } from "@/lib/oauth";

type Context = {
  params: Promise<{ ref: string; attachmentRef: string }>;
};

export async function GET(request: Request, context: Context) {
  const { ref, attachmentRef } = await context.params;
  return withAgentApi(request, "api:read", async ({ user }) => ({
    data: await getAgentTaskAttachment(
      user,
      ref,
      attachmentRef,
      publicOrigin(request),
    ),
  }));
}

export async function DELETE(request: Request, context: Context) {
  const { ref, attachmentRef } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => {
    const version = requiredVersion(request.headers.get("x-attachment-version"));
    return {
      data: await deleteAgentTaskAttachment(
        user,
        ref,
        attachmentRef,
        version,
        publicOrigin(request),
      ),
    };
  });
}

export async function PATCH(request: Request, context: Context) {
  const { ref, attachmentRef } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => {
    const input = await readJson(request);
    if (input.deleted !== false) {
      throw new ValidationError("Only attachment restoration is supported");
    }
    const version = requiredVersion(input.version);
    return {
      data: await restoreAgentTaskAttachment(
        user,
        ref,
        attachmentRef,
        version,
        publicOrigin(request),
      ),
    };
  });
}

function requiredVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ValidationError("Attachment version is required");
  }
  return version;
}
