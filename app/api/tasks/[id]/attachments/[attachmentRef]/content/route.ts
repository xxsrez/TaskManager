import { getAttachmentContent } from "@/lib/attachments";
import { withUserResponse } from "@/lib/http";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; attachmentRef: string }> },
) {
  const { id, attachmentRef } = await context.params;
  const preview = new URL(request.url).searchParams.get("disposition") === "inline";
  return withUserResponse((user) =>
    getAttachmentContent(user, id, attachmentRef, {
      rangeHeader: request.headers.get("range"),
      preview,
    }),
  );
}
