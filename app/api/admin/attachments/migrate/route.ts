import { withUserResponse } from "@/lib/http";
import { reconcileImportedAttachments } from "@/lib/imported-attachments";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withUserResponse(async (user) => {
    if (request.headers.get("x-task-manager-action") !== "attachment-migration") {
      throw Object.assign(new Error("Invalid attachment migration request"), {
        status: 403,
      });
    }
    const input = await request.json().catch(() => ({}));
    const value = input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    const mode = value.mode === "apply" ? "apply" : "inventory";
    return Response.json(await reconcileImportedAttachments(user, {
      mode,
      sourceRecordId: typeof value.sourceRecordId === "string" ? value.sourceRecordId : undefined,
      sourceIndex: typeof value.sourceIndex === "number" ? value.sourceIndex : undefined,
      maxRecords: typeof value.maxRecords === "number" ? value.maxRecords : undefined,
      maxAttachments: typeof value.maxAttachments === "number" ? value.maxAttachments : undefined,
      verifiedNonBinary: value.verifiedNonBinary === true,
    }), { headers: { "cache-control": "no-store" } });
  });
}
