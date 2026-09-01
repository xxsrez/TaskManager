import { readJson, withUser } from "@/lib/http";
import {
  grantTeamAccess,
  listTeamGrants,
  revokeTeamAccess,
  updateTeamAccess,
} from "@/lib/team-grants";

export const dynamic = "force-dynamic";

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
  return withUser((user) => grantTeamAccess(user, input));
}

export async function PATCH(request: Request) {
  const input = await readJson(request);
  return withUser((user) => updateTeamAccess(user, input.grantId, input));
}

export async function DELETE(request: Request) {
  const input = await readJson(request);
  return withUser((user) => revokeTeamAccess(user, input.grantId, input));
}
