import { readJson, withUser } from "@/lib/http";
import { bulkUpdateTasks } from "@/lib/repository";

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    return { taskUpdates: await bulkUpdateTasks(user, input) };
  });
}
