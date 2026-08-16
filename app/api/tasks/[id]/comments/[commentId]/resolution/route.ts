import { resolveCommentThread } from "@/lib/comments";
import { readJson, withUser } from "@/lib/http";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string; commentId: string }> },
) {
  const input = await readJson(request);
  const { id, commentId } = await context.params;
  return withUser((user) => resolveCommentThread(user, id, commentId, input));
}
