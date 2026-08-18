import { listTaskActivity } from "@/lib/activity";
import { withUser } from "@/lib/http";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const url = new URL(request.url);
  return withUser((user) => listTaskActivity(user, id, {
    limit: url.searchParams.has("limit")
      ? Number(url.searchParams.get("limit"))
      : undefined,
    cursor: url.searchParams.get("cursor"),
  }));
}
