import { readJson, withUser } from "@/lib/http";
import { createRelease, getSnapshot } from "@/lib/repository";

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    await createRelease(user, input);
    return getSnapshot(user);
  });
}
