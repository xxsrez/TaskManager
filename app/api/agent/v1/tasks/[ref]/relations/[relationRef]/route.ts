import { withAgentApi } from "@/lib/agent-api-http";
import {
  deleteAgentTaskRelation,
  updateAgentTaskRelation,
} from "@/lib/agent-api-repository";
import { readJson } from "@/lib/http";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ ref: string; relationRef: string }> },
) {
  const { ref, relationRef } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => ({
    data: await updateAgentTaskRelation(
      user,
      ref,
      relationRef,
      await readJson(request),
    ),
  }));
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ ref: string; relationRef: string }> },
) {
  const { ref, relationRef } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => ({
    data: await deleteAgentTaskRelation(
      user,
      ref,
      relationRef,
      await readJson(request),
    ),
  }));
}
