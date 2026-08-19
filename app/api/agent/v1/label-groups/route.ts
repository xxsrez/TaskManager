import { withAgentApi } from "@/lib/agent-api-http";
import { listAgentLabelGroups } from "@/lib/agent-api-repository";

export async function GET(request: Request) {
  return withAgentApi(request, "api:read", async ({ user }) => ({
    data: await listAgentLabelGroups(user, new URL(request.url).searchParams.get("archived") === "true"),
  }));
}
