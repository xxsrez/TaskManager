import { readJson, withUser } from "@/lib/http";
import { createTask, getSnapshot } from "@/lib/repository";

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    await createTask(user, input);
    return getSnapshot(user);
  });
}
