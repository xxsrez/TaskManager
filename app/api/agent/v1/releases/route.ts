import { parseAgentReleaseListQuery } from "@/lib/agent-api-contract";
import { withAgentApi } from "@/lib/agent-api-http";
import { listAgentReleases } from "@/lib/agent-api-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withAgentApi(request, "api:read", async ({ user }) => {
    const query = await parseAgentReleaseListQuery(new URL(request.url).searchParams);
    const result = await listAgentReleases(user, query);
    return { data: result.data, page: result.page };
  });
}
