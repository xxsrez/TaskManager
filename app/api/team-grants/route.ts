import { readJson, withUser } from "@/lib/http";
import { listTeamGrants, upsertTeamGrant } from "@/lib/teams";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const teamReference = params.get("teamId") ?? params.get("team") ?? "";
  return noStore(await withUser((user) => listTeamGrants(user, teamReference)));
}

export async function POST(request: Request) {
  const input = await readJson(request);
  return noStore(await withUser((user) => upsertTeamGrant(user, input)));
}

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
