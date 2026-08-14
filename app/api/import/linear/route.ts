import { withUser } from "@/lib/http";
import { importLinearWorkspace } from "@/lib/linear-import";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 10_000_000) {
    return Response.json(
      { error: "Linear import payload is too large" },
      { status: 413 },
    );
  }
  const payload = await request.json().catch(() => null);
  return withUser((user) => importLinearWorkspace(user, payload));
}
