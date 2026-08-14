import { readJson, withUser } from "@/lib/http";
import { createSavedView, getSnapshot } from "@/lib/repository";

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    await createSavedView(user, input);
    return getSnapshot(user);
  });
}
