import { readJson, withUser } from "@/lib/http";
import { createProject, getSnapshot } from "@/lib/repository";

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    await createProject(user, input);
    return getSnapshot(user);
  });
}
