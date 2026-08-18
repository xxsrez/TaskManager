import { readJson, withUser } from "@/lib/http";
import {
  deleteTaskRelation,
  updateTaskRelation,
} from "@/lib/task-relations";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; relationId: string }> },
) {
  const input = await readJson(request);
  const { id, relationId } = await context.params;
  return withUser(async (user) => ({
    relation: await updateTaskRelation(user, id, relationId, input),
  }));
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; relationId: string }> },
) {
  const input = await readJson(request);
  const { id, relationId } = await context.params;
  return withUser(async (user) =>
    deleteTaskRelation(user, id, relationId, input));
}
