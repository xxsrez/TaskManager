import { readJson, withUser } from "@/lib/http";
import { reorderTask } from "@/lib/repository";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return withUser(async (user) => ({ task: await reorderTask(user, id, input) }));
}
