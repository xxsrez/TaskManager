import { withUser } from "@/lib/http";
import {
  decodeLinearImportPayload,
  importLinearWorkspace,
  maxLinearImportBytes,
} from "@/lib/linear-import";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > maxLinearImportBytes) {
    return Response.json(
      { error: "Linear import payload is too large" },
      { status: 413 },
    );
  }
  const result = decodeLinearImportPayload(
    new Uint8Array(await request.arrayBuffer()),
  );
  if (result.tooLarge) {
    return Response.json(
      { error: "Linear import payload is too large" },
      { status: 413 },
    );
  }
  return withUser((user) => importLinearWorkspace(user, result.payload));
}
