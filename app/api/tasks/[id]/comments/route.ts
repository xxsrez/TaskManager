import { createComment, listTaskComments } from "@/lib/comments";
import { readJson, withUser } from "@/lib/http";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const url = new URL(request.url);
  return withUser((user) => listTaskComments(user, id, {
    limit: url.searchParams.has("limit")
      ? Number(url.searchParams.get("limit"))
      : undefined,
    cursor: url.searchParams.get("cursor"),
  }));
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return withUser((user) => createComment(user, id, input));
}
