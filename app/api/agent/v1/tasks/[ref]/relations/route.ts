import { withAgentApi } from "@/lib/agent-api-http";
import { createAgentTaskRelation } from "@/lib/agent-api-repository";
import { readJson } from "@/lib/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ ref: string }> },
) {
  const { ref } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => ({
    data: await createAgentTaskRelation(user, ref, await readJson(request)),
  }));
}
