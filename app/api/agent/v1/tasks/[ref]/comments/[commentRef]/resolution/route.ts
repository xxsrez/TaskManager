import { withAgentApi } from "@/lib/agent-api-http";
import { resolveAgentTaskThread } from "@/lib/agent-api-repository";
import { readJson } from "@/lib/http";

export async function PUT(
  request: Request,
  context: { params: Promise<{ ref: string; commentRef: string }> },
) {
  const { ref, commentRef } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => ({
    data: await resolveAgentTaskThread(user, ref, commentRef, await readJson(request)),
  }));
}
