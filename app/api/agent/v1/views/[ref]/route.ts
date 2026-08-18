import { withAgentApi } from "@/lib/agent-api-http";
import { getAgentSavedViewDetail } from "@/lib/agent-api-repository";

export async function GET(
  request: Request,
  context: { params: Promise<{ ref: string }> },
) {
  const { ref } = await context.params;
  return withAgentApi(request, "api:read", async ({ user }) => ({
    data: await getAgentSavedViewDetail(user, ref),
  }));
}
