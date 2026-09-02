import { readJson, withUser } from "@/lib/http";
import {
  createTeamGrant,
  listTeamGrants,
  revokeTeamGrant,
  updateTeamGrant,
} from "@/lib/team-grants";
import { privateNoStore } from "../../teams/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  return privateNoStore(await withUser((user) =>
    listTeamGrants(user, {
      resourceType: url.searchParams.get("resource_type")
        ?? url.searchParams.get("resourceType"),
      resourceId: url.searchParams.get("resource_id")
        ?? url.searchParams.get("resourceId"),
    })));
}

export async function POST(request: Request) {
  const input = await readJson(request);
  return privateNoStore(await withUser((user) => createTeamGrant(user, input)));
}

export async function PATCH(request: Request) {
  const input = await readJson(request);
  return privateNoStore(await withUser((user) => updateTeamGrant(user, input)));
}

export async function DELETE(request: Request) {
  const input = await readJson(request);
  return privateNoStore(await withUser((user) => revokeTeamGrant(user, input)));
}
