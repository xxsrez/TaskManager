import { withUser } from "@/lib/http";
import { getProjectLabelCatalog } from "@/lib/repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const projectId = parameters.get("projectId");
  const includeArchived = parameters.get("includeArchived") === "true";
  return noStore(await withUser(async (user) => {
    if (!projectId) return { labels: [] };
    return getProjectLabelCatalog(user, projectId, includeArchived);
  }));
}

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
