import { withUser } from "@/lib/http";
import { getWorkspaceSync } from "@/lib/workspace-sync";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const cursor = new URL(request.url).searchParams.get("cursor") ?? "";
  return withUser((user) => getWorkspaceSync(user, cursor));
}
