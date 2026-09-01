import { readJson, withUser } from "@/lib/http";
import { addTeamMember, getTeamsCatalog } from "@/lib/teams";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return withUser(async (user) => {
    await addTeamMember(user, id, input);
    return getTeamsCatalog(user);
  });
}
