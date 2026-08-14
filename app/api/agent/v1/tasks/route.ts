import { parseAgentTaskListQuery } from "@/lib/agent-api-contract";
import { withAgentApi } from "@/lib/agent-api-http";
import {
  createAgentTask,
  listAgentTasks,
} from "@/lib/agent-api-repository";
import { readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withAgentApi(request, "api:read", async ({ user }) => {
    const query = await parseAgentTaskListQuery(new URL(request.url).searchParams);
    const result = await listAgentTasks(user, query);
    return { data: result.data, page: result.page };
  });
}

export async function POST(request: Request) {
  return withAgentApi(request, "api:write", async ({ user }) => {
    const input = await readJson(request);
    return {
      data: await createAgentTask(user, input),
      status: 201,
    };
  });
}
