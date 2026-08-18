import { readJson, withUser } from "@/lib/http";
import { createTaskRelation } from "@/lib/task-relations";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return withUser(async (user) => ({
    relation: await createTaskRelation(user, id, input),
  }));
}
