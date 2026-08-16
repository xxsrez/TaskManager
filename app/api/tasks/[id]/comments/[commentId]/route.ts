import { deleteComment, editComment, getCommentThread } from "@/lib/comments";
import { readJson, withUser } from "@/lib/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; commentId: string }> },
) {
  const { id, commentId } = await context.params;
  return withUser((user) => getCommentThread(user, id, commentId));
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; commentId: string }> },
) {
  const input = await readJson(request);
  const { id, commentId } = await context.params;
  return withUser((user) => editComment(user, id, commentId, input));
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; commentId: string }> },
) {
  const input = await readJson(request);
  const { id, commentId } = await context.params;
  return withUser((user) => deleteComment(user, id, commentId, input));
}
