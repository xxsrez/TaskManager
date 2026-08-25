import { readJson, withUser } from "@/lib/http";
import { getSnapshot, transferProjectOwnership } from "@/lib/repository";

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    await transferProjectOwnership(
      user,
      String(input.projectId ?? ""),
      String(input.targetUserId ?? ""),
    );
    return getSnapshot(user, {
      workspaceScope: new URL(request.url).searchParams.get("workspace_scope"),
    });
  });
}
