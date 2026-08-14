import { withUser } from "@/lib/http";
import { getTaskExternalSource } from "@/lib/repository";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return withUser((user) => getTaskExternalSource(user, id));
}
