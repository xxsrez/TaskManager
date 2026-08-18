import { withAgentApi } from "@/lib/agent-api-http";
import { listAgentLabels } from "@/lib/agent-api-repository";

export async function GET(request: Request) {
  return withAgentApi(request, "api:read", async ({ user }) => {
    const archived = new URL(request.url).searchParams.get("archived") === "true";
    return { data: await listAgentLabels(user, archived) };
  });
}
