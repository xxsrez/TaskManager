import { readJson, withUser } from "@/lib/http";
import { revokeTeamGrant, updateTeamGrant } from "@/lib/teams";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return noStore(await withUser((user) => updateTeamGrant(user, id, input)));
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return noStore(await withUser((user) => revokeTeamGrant(user, id, input)));
}

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
