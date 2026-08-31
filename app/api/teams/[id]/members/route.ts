import { readJson, withUser } from "@/lib/http";
import {
  addTeamMember,
  listTeamMembers,
} from "@/lib/teams";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return noStore(await withUser((user) => listTeamMembers(user, id)));
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return noStore(await withUser((user) => addTeamMember(user, id, input)));
}

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
