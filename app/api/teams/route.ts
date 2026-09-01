import { readJson, withUser } from "@/lib/http";
import { createTeam, listTeams } from "@/lib/teams";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUser((user) => listTeams(user));
}

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => ({ team: await createTeam(user, input) }));
}
