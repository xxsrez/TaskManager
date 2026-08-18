import { withAgentApi } from "@/lib/agent-api-http";
import { listAgentTaskActivity } from "@/lib/agent-api-repository";

export async function GET(
  request: Request,
  context: { params: Promise<{ ref: string }> },
) {
  const { ref } = await context.params;
  const url = new URL(request.url);
  return withAgentApi(request, "api:read", async ({ user }) => {
    const result = await listAgentTaskActivity(user, ref, {
      limit: url.searchParams.has("limit")
        ? Number(url.searchParams.get("limit"))
        : undefined,
      cursor: url.searchParams.get("cursor"),
    });
    return {
      data: { events: result.data, totalCount: result.totalCount },
      page: result.page,
    };
  });
}
