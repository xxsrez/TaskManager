import { readJson, withUser } from "@/lib/http";
import { createTask, getSnapshot, searchTaskIds } from "@/lib/repository";

export async function GET(request: Request) {
  const search = new URL(request.url).searchParams.get("search") ?? "";
  return withUser(async (user) => ({ taskIds: await searchTaskIds(user, search) }));
}

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    await createTask(user, input);
    return getSnapshot(user);
  });
}
