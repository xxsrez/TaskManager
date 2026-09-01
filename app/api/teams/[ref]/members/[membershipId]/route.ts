import { readJson, withUser } from "@/lib/http";
import {
  deleteTeamMembership,
  setTeamMembershipStatus,
} from "@/lib/teams";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ ref: string; membershipId: string }> };

export async function PATCH(request: Request, context: Context) {
  const input = await readJson(request);
  const { ref, membershipId } = await context.params;
  return noStore(await withUser(async (user) => ({
    team: await setTeamMembershipStatus(user, ref, membershipId, input),
  })));
}

export async function DELETE(request: Request, context: Context) {
  const input = await readJson(request);
  const { ref, membershipId } = await context.params;
  return noStore(await withUser(async (user) => ({
    team: await deleteTeamMembership(user, ref, membershipId, input),
  })));
}

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
