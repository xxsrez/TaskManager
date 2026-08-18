import { readJson, withUser } from "@/lib/http";
import { bulkMoveTasks, bulkUpdateTasks } from "@/lib/repository";

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    return {
      taskUpdates: input.field === "projectId"
        ? await bulkMoveTasks(user, {
            ...input,
            targetProjectId: input.value,
          })
        : await bulkUpdateTasks(user, input),
    };
  });
}
