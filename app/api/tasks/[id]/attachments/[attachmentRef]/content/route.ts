import { getAttachmentContent } from "@/lib/attachments";
import { withUserResponse } from "@/lib/http";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; attachmentRef: string }> },
) {
  const { id, attachmentRef } = await context.params;
  const url = new URL(request.url);
  const preview = url.searchParams.get("disposition") === "inline";
  const variant = url.searchParams.get("variant") === "thumbnail"
    ? "thumbnail" as const
    : "original" as const;
  return withUserResponse((user) =>
    getAttachmentContent(user, id, attachmentRef, {
      rangeHeader: request.headers.get("range"),
      preview,
      variant,
    }),
  );
}
