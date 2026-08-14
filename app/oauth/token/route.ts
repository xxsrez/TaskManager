import { handleOAuthTokenRequest } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleOAuthTokenRequest(request);
}
