import { oauthProtectedResourceMetadata } from "@/lib/oauth-contract";
import { publicOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return Response.json(oauthProtectedResourceMetadata(publicOrigin(request)), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
