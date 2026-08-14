import { withUserResponse } from "@/lib/http";
import { completeLinearOAuth } from "@/lib/linear-oauth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withUserResponse(async (user) => {
    const sessionId = await completeLinearOAuth(user, request.url);
    const target = new URL("/import/linear", request.url);
    target.searchParams.set("session", sessionId);
    return Response.redirect(target, 302);
  });
}
