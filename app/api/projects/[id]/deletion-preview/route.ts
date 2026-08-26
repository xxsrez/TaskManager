import { getProjectDeletionPreview } from "@/lib/deletion";
import { withUser } from "@/lib/http";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const version = Number(new URL(request.url).searchParams.get("version"));
  return withUser((user) => getProjectDeletionPreview(user, id, version));
}
