import { readJson, withUser } from "@/lib/http";
import { createTeam, getTeamsCatalog } from "@/lib/teams";

export async function GET() {
  return withUser((user) => getTeamsCatalog(user));
}

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    await createTeam(user, input);
    return getTeamsCatalog(user);
  });
}
