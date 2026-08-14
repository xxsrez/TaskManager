import { withUserResponse } from "@/lib/http";
import { beginLinearOAuth } from "@/lib/linear-oauth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withUserResponse(async (user) => {
    const authorizationUrl = await beginLinearOAuth(user, new URL(request.url).origin);
    return Response.redirect(authorizationUrl, 302);
  });
}
