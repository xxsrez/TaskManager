import { listOAuthConnections } from "@/lib/oauth";
import { withUser } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  const response = await withUser((user) => listOAuthConnections(user));
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
