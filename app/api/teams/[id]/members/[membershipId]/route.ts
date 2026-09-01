import { readJson, withUser } from "@/lib/http";
import { deleteTeamMember, setTeamMemberStatus } from "@/lib/teams";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; membershipId: string }> },
) {
  const input = await readJson(request);
  const { id, membershipId } = await context.params;
  return withUser(async (user) => ({
    team: await setTeamMemberStatus(user, id, membershipId, input),
  }));
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; membershipId: string }> },
) {
  const input = await readJson(request);
  const { id, membershipId } = await context.params;
  return withUser(async (user) => ({
    team: await deleteTeamMember(user, id, membershipId, input),
  }));
}
