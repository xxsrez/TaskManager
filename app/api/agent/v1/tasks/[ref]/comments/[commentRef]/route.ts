import { withAgentApi } from "@/lib/agent-api-http";
import {
  deleteAgentTaskComment,
  editAgentTaskComment,
  getAgentTaskThread,
} from "@/lib/agent-api-repository";
import { readJson } from "@/lib/http";

export async function GET(
  request: Request,
  context: { params: Promise<{ ref: string; commentRef: string }> },
) {
  const { ref, commentRef } = await context.params;
  return withAgentApi(request, "api:read", async ({ user }) => ({
    data: await getAgentTaskThread(user, ref, commentRef),
  }));
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ ref: string; commentRef: string }> },
) {
  const { ref, commentRef } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => ({
    data: await editAgentTaskComment(user, ref, commentRef, await readJson(request)),
  }));
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ ref: string; commentRef: string }> },
) {
  const { ref, commentRef } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => ({
    data: await deleteAgentTaskComment(user, ref, commentRef, await readJson(request)),
  }));
}
