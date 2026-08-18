import { withUserResponse } from "@/lib/http";
import { reconcileAttachmentStorage } from "@/lib/attachment-operations";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUserResponse(async (user) => {
    if (
      request.headers.get("x-task-manager-action") !==
      "attachment-reconciliation"
    ) {
      throw Object.assign(new Error("Invalid attachment reconciliation request"), {
        status: 403,
      });
    }
    const input = await request.json().catch(() => ({}));
    const options =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    return Response.json(
      await reconcileAttachmentStorage(user, {
        verifyChecksums: options.verifyChecksums === true,
        maxObjects:
          typeof options.maxObjects === "number" ? options.maxObjects : undefined,
      }),
      { headers: { "cache-control": "no-store" } },
    );
  });
}
