import { readJson, withUser } from "@/lib/http";
import { getTeam, updateTeam } from "@/lib/teams";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return withUser(async (user) => ({ team: await getTeam(user, id) }));
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return withUser(async (user) => ({ team: await updateTeam(user, id, input) }));
}
