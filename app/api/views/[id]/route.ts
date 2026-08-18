import { readJson, withUser } from "@/lib/http";
import { getSnapshot, updateSavedView } from "@/lib/repository";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return withUser(async (user) => {
    await updateSavedView(user, id, input);
    return getSnapshot(user);
  });
}
