import { withAgentApi } from "@/lib/agent-api-http";
import { setAgentTaskLabelGroupValue } from "@/lib/agent-api-repository";
import { readJson } from "@/lib/http";

export async function PUT(request: Request, context: { params: Promise<{ ref: string; groupRef: string }> }) {
  const { ref, groupRef } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => {
    const body = await readJson(request);
    return { data: await setAgentTaskLabelGroupValue(user, ref, groupRef, body.labelRef == null ? null : String(body.labelRef)) };
  });
}

export async function DELETE(request: Request, context: { params: Promise<{ ref: string; groupRef: string }> }) {
  const { ref, groupRef } = await context.params;
  return withAgentApi(request, "api:write", async ({ user }) => ({
    data: await setAgentTaskLabelGroupValue(user, ref, groupRef, null),
  }));
}
