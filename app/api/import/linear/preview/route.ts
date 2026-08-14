import { readJson, withUser } from "@/lib/http";
import { previewLinearMigration } from "@/lib/linear-migration";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (request.headers.get("x-task-manager-action") !== "linear-import") {
    return Response.json({ error: "Linear import action header is required" }, { status: 400 });
  }
  const input = await readJson(request);
  return withUser((user) => previewLinearMigration(user, {
    sessionId: String(input.sessionId ?? ""),
    scope: input.scope,
    userMapping: input.userMapping,
  }));
}
