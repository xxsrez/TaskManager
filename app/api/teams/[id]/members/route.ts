import { readJson, withUser } from "@/lib/http";
import { addTeamMember, listTeamMembers } from "@/lib/teams";
import { privateNoStore } from "../../http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return privateNoStore(await withUser((user) => listTeamMembers(user, id)));
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return privateNoStore(await withUser((user) => addTeamMember(user, id, input)));
}
