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
  return noStore(await withUser(async (user) => ({
    teamGrants: await listTeamGrants(user, {
      resourceType: url.searchParams.get("resource_type"),
      resourceId: url.searchParams.get("resource_id"),
    }),
  })));
}

export async function POST(request: Request) {
  const input = await readJson(request);
  return noStore(await withUser(async (user) => ({
    teamGrants: await grantTeamAccess(user, input),
  })));
}

export async function PATCH(request: Request) {
  const input = await readJson(request);
  return noStore(await withUser(async (user) => ({
    teamGrants: await updateTeamAccess(user, String(input.grantId ?? ""), input),
  })));
}

export async function DELETE(request: Request) {
  const input = await readJson(request);
  return noStore(await withUser(async (user) => ({
    teamGrants: await revokeTeamAccess(user, String(input.grantId ?? ""), input),
  })));
}

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
