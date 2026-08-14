import { handleOAuthRevocation } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleOAuthRevocation(request);
}
