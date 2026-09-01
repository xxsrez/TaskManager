import { readJson, withUser } from "@/lib/http";
import { getTeamDetail, updateTeam } from "@/lib/teams";
import { privateNoStore } from "../http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return privateNoStore(await withUser((user) => getTeamDetail(user, id)));
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return privateNoStore(await withUser((user) => updateTeam(user, id, input)));
}
