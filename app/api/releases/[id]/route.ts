import { readJson, withUser } from "@/lib/http";
import { deleteEntity } from "@/lib/deletion";
import { getSnapshot, updateRelease } from "@/lib/repository";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return withUser(async (user) => {
    await updateRelease(user, id, input);
    return getSnapshot(user, {
      workspaceScope: new URL(request.url).searchParams.get("workspace_scope"),
    });
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return withUser(async (user) => ({
    entity: await deleteEntity(user, "release", id, Number(input.version)),
  }));
}
