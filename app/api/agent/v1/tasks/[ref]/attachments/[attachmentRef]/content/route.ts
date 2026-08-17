import { withAgentApiResponse } from "@/lib/agent-api-http";
import { getAgentTaskAttachmentContent } from "@/lib/agent-api-repository";
import { ValidationError } from "@/lib/domain";

export async function GET(
  request: Request,
  context: { params: Promise<{ ref: string; attachmentRef: string }> },
) {
  const { ref, attachmentRef } = await context.params;
  return withAgentApiResponse(request, "api:read", ({ user }) => {
    const url = new URL(request.url);
    for (const key of url.searchParams.keys()) {
      if (key !== "variant") {
        throw new ValidationError(`Unknown query parameter: ${key}`);
      }
    }
    const value = url.searchParams.get("variant") ?? "original";
    if (value !== "original" && value !== "thumbnail") {
      throw new ValidationError("variant must be original or thumbnail");
    }
    return getAgentTaskAttachmentContent(user, ref, attachmentRef, {
      rangeHeader: request.headers.get("range"),
      preview: value === "thumbnail",
      variant: value,
    });
  });
}
