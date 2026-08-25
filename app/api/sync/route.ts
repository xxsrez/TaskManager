import { withUser } from "@/lib/http";
import { getWorkspaceSync } from "@/lib/workspace-sync";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const cursor = parameters.get("cursor") ?? "";
  return withUser((user) => getWorkspaceSync(
    user,
    cursor,
    parameters.get("workspace_scope"),
  ));
}
