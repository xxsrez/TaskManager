import { withUser } from "@/lib/http";
import { searchWorkspace } from "@/lib/repository";

export async function GET(request: Request) {
  const url = new URL(request.url);
  return withUser((user) => searchWorkspace(user, {
    query: url.searchParams.get("query") ?? "",
    cursor: url.searchParams.get("cursor"),
    limit: url.searchParams.has("limit")
      ? Number(url.searchParams.get("limit"))
      : undefined,
  }));
}
