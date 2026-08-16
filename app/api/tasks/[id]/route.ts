import { readJson, withUser } from "@/lib/http";
import { getTaskDetail, updateTask } from "@/lib/repository";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return withUser(async (user) => getTaskDetail(user, id));
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return withUser(async (user) => {
    const task = await updateTask(user, id, input);
    return { task };
  });
}
