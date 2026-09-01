import { readJson, withUser } from "@/lib/http";
import {
  deleteTeamMember,
  getTeamsCatalog,
  updateTeamMember,
} from "@/lib/teams";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; membershipId: string }> },
) {
  const input = await readJson(request);
  const { id, membershipId } = await context.params;
  return withUser(async (user) => {
    await updateTeamMember(user, id, membershipId, input);
    return getTeamsCatalog(user);
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; membershipId: string }> },
) {
  const input = await readJson(request);
  const { id, membershipId } = await context.params;
  return withUser(async (user) => {
    await deleteTeamMember(user, id, membershipId, input);
    return getTeamsCatalog(user);
  });
}
