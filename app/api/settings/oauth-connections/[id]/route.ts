import { withUser } from "@/lib/http";
import { revokeOAuthConnection } from "@/lib/oauth";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const response = await withUser(async (user) => {
    await revokeOAuthConnection(user, id);
    return { revoked: true };
  });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
