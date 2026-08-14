import { withAgentApi } from "@/lib/agent-api-http";
import {
  getAgentTaskDetail,
  updateAgentTask,
} from "@/lib/agent-api-repository";
import { readJson } from "@/lib/http";

export async function GET(
  request: Request,
  context: { params: Promise<{ ref: string }> },
) {
  const { ref } = await context.params;
  return withAgentApi(request, "api:read", async ({ user }) => ({
    data: await getAgentTaskDetail(user, ref),
  }));
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ ref: string }> },
) {
  const { ref } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => {
    const input = await readJson(request);
    return { data: await updateAgentTask(user, ref, input) };
  });
}
