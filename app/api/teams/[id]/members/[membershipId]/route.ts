import { readJson, withUser } from "@/lib/http";
import { deleteTeamMembership, updateTeamMembership } from "@/lib/teams";
import { privateNoStore } from "../../../http";

type MembershipContext = {
  params: Promise<{ id: string; membershipId: string }>;
};

export async function PATCH(request: Request, context: MembershipContext) {
  const input = await readJson(request);
  const { id, membershipId } = await context.params;
  return privateNoStore(await withUser((user) =>
    updateTeamMembership(user, id, membershipId, input)));
}

export async function DELETE(request: Request, context: MembershipContext) {
  const input = await readJson(request);
  const { id, membershipId } = await context.params;
  return privateNoStore(await withUser((user) =>
    deleteTeamMembership(user, id, membershipId, input)));
}
