import { readJson, withUser } from "@/lib/http";
import { getUserProfile, updateUserProfile } from "@/lib/repository";

export const dynamic = "force-dynamic";

export async function GET() {
  return noStore(await withUser((user) => getUserProfile(user)));
}

export async function PATCH(request: Request) {
  const input = await readJson(request);
  return noStore(await withUser((user) => updateUserProfile(user, input)));
}

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
