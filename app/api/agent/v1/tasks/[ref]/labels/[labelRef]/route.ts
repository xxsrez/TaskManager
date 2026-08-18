import { withAgentApi } from "@/lib/agent-api-http";
import { setAgentTaskLabel } from "@/lib/agent-api-repository";

export async function PUT(
  request: Request,
  context: { params: Promise<{ ref: string; labelRef: string }> },
) {
  const { ref, labelRef } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => ({
    data: await setAgentTaskLabel(user, ref, labelRef, true),
  }));
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ ref: string; labelRef: string }> },
) {
  const { ref, labelRef } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => ({
    data: await setAgentTaskLabel(user, ref, labelRef, false),
  }));
}
