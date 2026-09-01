import { withUser } from "@/lib/http";
import { getTeam } from "@/lib/teams";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ ref: string }> }) {
  const { ref } = await context.params;
  const response = await withUser(async (user) => ({ team: await getTeam(user, ref) }));
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
