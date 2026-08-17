import { readJson, withUser } from "@/lib/http";
import { createTask, getSnapshot, searchTaskSummaries } from "@/lib/repository";

export async function GET(request: Request) {
  const search = new URL(request.url).searchParams.get("search") ?? "";
  return withUser(async (user) => {
    const tasks = await searchTaskSummaries(user, search);
    return { taskIds: tasks.map((task) => task.id), tasks };
  });
}

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    const createdTask = await createTask(user, input);
    return { ...(await getSnapshot(user)), createdTask };
  });
}
