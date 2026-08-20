import { withAgentApi } from "@/lib/agent-api-http";
import {
  deleteAgentStoredFile,
  getAgentStoredFile,
} from "@/lib/agent-api-repository";
import { ValidationError } from "@/lib/domain";

type Context = { params: Promise<{ fileRef: string }> };

export async function GET(request: Request, context: Context) {
  const { fileRef } = await context.params;
  return withAgentApi(request, "api:read", async ({ user }) => ({
    data: await getAgentStoredFile(user, fileRef),
  }));
}

export async function DELETE(request: Request, context: Context) {
  const { fileRef } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => ({
    data: await deleteAgentStoredFile(
      user,
      fileRef,
      requiredVersion(request.headers.get("x-file-version")),
    ),
  }));
}

function requiredVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ValidationError("Stored file version is required");
  }
  return version;
}
