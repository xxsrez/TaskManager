import { withAgentApi } from "@/lib/agent-api-http";
import { setAgentTaskParent } from "@/lib/agent-api-repository";
import { readJson } from "@/lib/http";

export async function PUT(
  request: Request,
  context: { params: Promise<{ ref: string }> },
) {
  const { ref } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => ({
    data: await setAgentTaskParent(user, ref, await readJson(request)),
  }));
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ ref: string }> },
) {
  const { ref } = await context.params;
  const input = await readJson(request);
  return withAgentApi(request, "api:write", async ({ user }) => ({
    data: await setAgentTaskParent(user, ref, {
      version: input.version,
      parentTaskRef: null,
    }),
  }));
}
