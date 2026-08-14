import { withAgentApi } from "@/lib/agent-api-http";
import { getAgentWorkspace } from "@/lib/agent-api-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withAgentApi(request, "api:read", async (context) => ({
    data: await getAgentWorkspace(context),
  }));
}
