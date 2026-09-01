import { readJson, withUser } from "@/lib/http";
import {
  createTeamGrant,
  listTeamGrants,
  revokeTeamGrant,
  updateTeamGrant,
} from "@/lib/team-grants";

export async function GET(request: Request) {
  const url = new URL(request.url);
  return withUser((user) => listTeamGrants(
    user,
    url.searchParams.get("resourceType"),
    url.searchParams.get("resourceId"),
  ));
}

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser((user) => createTeamGrant(user, input));
}

export async function PATCH(request: Request) {
  const input = await readJson(request);
  return withUser((user) => updateTeamGrant(user, String(input.grantId ?? ""), input));
}

export async function DELETE(request: Request) {
  const input = await readJson(request);
  return withUser((user) => revokeTeamGrant(user, String(input.grantId ?? ""), input));
}
