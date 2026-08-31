import { readJson, withUser } from "@/lib/http";
import { createTeam, listTeams } from "@/lib/teams";

export const dynamic = "force-dynamic";

export async function GET() {
  return noStore(await withUser((user) => listTeams(user)));
}

export async function POST(request: Request) {
  const input = await readJson(request);
  return noStore(await withUser((user) => createTeam(user, input)));
}

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
