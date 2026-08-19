import { readJson, withUser } from "@/lib/http";
import { updateLabelGroup } from "@/lib/repository";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const input = await readJson(request);
  const { id } = await context.params;
  return withUser(async (user) => ({ labelGroups: await updateLabelGroup(user, id, input) }));
}
