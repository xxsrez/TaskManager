import { withUser } from "@/lib/http";
import { getTeamDetail } from "@/lib/teams";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return noStore(await withUser((user) => getTeamDetail(user, id)));
}

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
