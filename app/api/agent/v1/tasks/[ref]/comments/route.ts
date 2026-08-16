import { withAgentApi } from "@/lib/agent-api-http";
import {
  createAgentTaskComment,
  listAgentTaskComments,
} from "@/lib/agent-api-repository";
import { readJson } from "@/lib/http";

export async function GET(
  request: Request,
  context: { params: Promise<{ ref: string }> },
) {
  const { ref } = await context.params;
  const url = new URL(request.url);
  return withAgentApi(request, "api:read", async ({ user }) => {
    const result = await listAgentTaskComments(user, ref, {
      limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
      cursor: url.searchParams.get("cursor"),
    });
    return { data: { threads: result.data, totalCount: result.totalCount }, page: result.page };
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ ref: string }> },
) {
  const { ref } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => ({
    data: await createAgentTaskComment(user, ref, await readJson(request)),
    status: 201,
  }));
}
