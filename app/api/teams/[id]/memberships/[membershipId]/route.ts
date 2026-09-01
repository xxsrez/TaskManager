import { readJson, withUser } from "@/lib/http";
import {
  deleteTeamMembership,
  setTeamMembershipStatus,
} from "@/lib/teams";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; membershipId: string }> },
) {
  const input = await readJson(request);
  const { id, membershipId } = await context.params;
  return withUser(async (user) => ({
    team: await setTeamMembershipStatus(user, id, membershipId, input),
  }));
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; membershipId: string }> },
) {
  const input = await readJson(request);
  const { id, membershipId } = await context.params;
  return withUser(async (user) => ({
    team: await deleteTeamMembership(user, id, membershipId, input),
  }));
}
