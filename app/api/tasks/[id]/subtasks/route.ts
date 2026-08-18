import { readJson, withUser } from "@/lib/http";
import { createSubtask, getSnapshot } from "@/lib/repository";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return withUser(async (user) => {
    const created = await createSubtask(user, id, input);
    return { ...(await getSnapshot(user)), createdTask: created };
  });
}
