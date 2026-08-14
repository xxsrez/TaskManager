import { readJson, withUser } from "@/lib/http";
import { bulkUpdateTasks, getSnapshot } from "@/lib/repository";

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    await bulkUpdateTasks(user, input);
    return getSnapshot(user);
  });
}
