import { readJson, withUser } from "@/lib/http";
import { createLabelGroup, listOwnedLabelGroups } from "@/lib/repository";

export async function GET() {
  return withUser(async (user) => ({ labelGroups: await listOwnedLabelGroups(user) }));
}

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => ({ labelGroups: await createLabelGroup(user, input) }));
}
