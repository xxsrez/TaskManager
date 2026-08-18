import { readJson, withUser } from "@/lib/http";
import { updateLabel } from "@/lib/repository";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return noStore(await withUser(async (user) => ({
    labels: await updateLabel(user, id, input),
  })));
}

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
