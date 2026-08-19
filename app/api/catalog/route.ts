import { withUser } from "@/lib/http";
import { getWorkspaceCatalogPage } from "@/lib/repository";
import type { WorkspaceCatalogKind } from "@/lib/types";
import { ValidationError } from "@/lib/domain";

export const dynamic = "force-dynamic";

const catalogKinds = new Set<WorkspaceCatalogKind>([
  "projects",
  "releases",
  "views",
]);

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  return withUser((user) => {
    const kind = parameters.get("kind") as WorkspaceCatalogKind | null;
    if (!kind || !catalogKinds.has(kind)) {
      throw new ValidationError("Catalog kind is invalid");
    }
    const unknown = [...parameters.keys()].find(
      (key) => ![
        "kind",
        "search",
        "cursor",
        "limit",
        "active_only",
        "order",
        "direction",
      ].includes(key),
    );
    if (unknown) throw new ValidationError(`Unknown catalog parameter: ${unknown}`);
    const rawLimit = parameters.get("limit");
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
      throw new ValidationError("Catalog limit must be between 1 and 50");
    }
    const activeOnly = parameters.get("active_only");
    if (activeOnly !== null && activeOnly !== "0" && activeOnly !== "1") {
      throw new ValidationError("active_only must be 0 or 1");
    }
    const order = parameters.get("order") ?? "updated";
    if (order !== "updated" && order !== "name") {
      throw new ValidationError("Catalog order is invalid");
    }
    const direction = parameters.get("direction") ?? (order === "name" ? "asc" : "desc");
    if (direction !== "asc" && direction !== "desc") {
      throw new ValidationError("Catalog direction is invalid");
    }
    return getWorkspaceCatalogPage(user, {
      kind,
      search: parameters.get("search"),
      cursor: parameters.get("cursor"),
      limit,
      activeOnly: activeOnly === "1",
      order,
      direction,
    });
  });
}
