import { readJson, withUser } from "@/lib/http";
import { moveTask } from "@/lib/repository";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return withUser(async (user) => ({ task: await moveTask(user, id, input) }));
}
