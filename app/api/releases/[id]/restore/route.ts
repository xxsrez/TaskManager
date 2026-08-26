import { restoreEntity } from "@/lib/deletion";
import { readJson, withUser } from "@/lib/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return withUser(async (user) => ({
    entity: await restoreEntity(user, "release", id, Number(input.version)),
  }));
}
