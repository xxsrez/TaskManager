import { withUser } from "@/lib/http";
import { getSnapshot } from "@/lib/repository";
import { RECENT_NAVIGATION_LIMIT } from "@/lib/recent-navigation";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const workspaceScope = parameters.has("workspace_scope")
    ? parameters.get("workspace_scope")
    : undefined;
  return withUser((user) => getSnapshot(user, {
    navigationLimit: RECENT_NAVIGATION_LIMIT,
    workspaceScope,
  }));
}
