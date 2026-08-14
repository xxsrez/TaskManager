import { withUserResponse } from "@/lib/http";
import { exportProjectBackup } from "@/lib/project-backup";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (request.headers.get("x-task-manager-action") !== "project-backup") {
    return Response.json({ error: "Project backup action header is required" }, { status: 400 });
  }
  const { id } = await context.params;
  return withUserResponse(async (user) => {
    const backup = await exportProjectBackup(user, id, new URL(request.url).origin);
    const safeName = backup.projectName.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "project";
    return new Response(JSON.stringify(backup, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="task-manager-${safeName}-${backup.exportedAt.slice(0, 10)}.json"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
