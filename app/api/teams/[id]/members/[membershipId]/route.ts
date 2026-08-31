import { readJson, withUser } from "@/lib/http";
import {
  deleteTeamMembership,
  updateTeamMembership,
} from "@/lib/teams";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; membershipId: string }> },
) {
  const input = await readJson(request);
  const { id, membershipId } = await context.params;
  return noStore(
    await withUser((user) => updateTeamMembership(user, id, membershipId, input)),
  );
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; membershipId: string }> },
) {
  const input = await readJson(request);
  const { id, membershipId } = await context.params;
  return noStore(
    await withUser((user) => deleteTeamMembership(user, id, membershipId, input)),
  );
}

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
