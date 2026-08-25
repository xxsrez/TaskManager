import { readJson, withUser } from "@/lib/http";
import { createProject, getSnapshot } from "@/lib/repository";

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    await createProject(user, input);
    // A Project is always created for the authenticated user, even while the
    // UI is viewing another owner's scope. Return that destination scope.
    const isUiScoped = new URL(request.url).searchParams.has("workspace_scope");
    return getSnapshot(user, isUiScoped ? { workspaceScope: null } : {});
  });
}
