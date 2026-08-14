import { parseAgentExternalContextQuery } from "@/lib/agent-api-contract";
import { withAgentApi } from "@/lib/agent-api-http";
import { getAgentTaskExternalContext } from "@/lib/agent-api-repository";

export async function GET(
  request: Request,
  context: { params: Promise<{ ref: string }> },
) {
  const { ref } = await context.params;
  return withAgentApi(request, "api:read", async ({ user }) => {
    const query = await parseAgentExternalContextQuery(
      new URL(request.url).searchParams,
      ref,
    );
    const result = await getAgentTaskExternalContext(user, ref, query);
    return { data: result.data, page: result.page };
  });
}
