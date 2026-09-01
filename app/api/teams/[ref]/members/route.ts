import { readJson, withUser } from "@/lib/http";
import { addTeamMember } from "@/lib/teams";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ ref: string }> }) {
  const input = await readJson(request);
  const { ref } = await context.params;
  const response = await withUser(async (user) => ({
    team: await addTeamMember(user, ref, input),
  }));
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
