import { withUser } from "@/lib/http";
import { linearOAuthConfigured, loadLinearInventory } from "@/lib/linear-oauth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get("session");
  if (!sessionId) return Response.json({ configured: linearOAuthConfigured() });
  return withUser(async (user) => ({
    configured: linearOAuthConfigured(),
    inventory: await loadLinearInventory(user, sessionId),
  }));
}
