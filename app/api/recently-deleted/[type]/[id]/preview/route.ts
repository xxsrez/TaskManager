import { getDeletionPreview } from "@/lib/deletion";
import { withUser } from "@/lib/http";
import type { DeletableEntityType } from "@/lib/types";

export async function GET(
  request: Request,
  context: { params: Promise<{ type: string; id: string }> },
) {
  const { type, id } = await context.params;
  const version = Number(new URL(request.url).searchParams.get("version"));
  return withUser((user) => getDeletionPreview(
    user,
    type as DeletableEntityType,
    id,
    version,
  ));
}
