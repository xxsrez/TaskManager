import { readJson, withUser } from "@/lib/http";
import { createTeam, listTeams } from "@/lib/teams";
import { privateNoStore } from "./http";

export async function GET() {
  return privateNoStore(await withUser((user) => listTeams(user)));
}

export async function POST(request: Request) {
  const input = await readJson(request);
  return privateNoStore(await withUser((user) => createTeam(user, input)));
}
