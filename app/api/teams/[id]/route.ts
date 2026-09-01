import { withUser } from "@/lib/http";
import { getTeam } from "@/lib/teams";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return withUser(async (user) => ({ team: await getTeam(user, id) }));
}
