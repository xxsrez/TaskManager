import { listRecentlyDeleted, purgeExpiredDeletedEntities } from "@/lib/deletion";
import { withUser } from "@/lib/http";
import type { DeletableEntityType } from "@/lib/types";

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  return withUser(async (user) => {
    // Maintenance is opportunistic and bounded. Failures are intentionally
    // non-fatal: rows whose object cleanup failed remain recoverable/retryable.
    await purgeExpiredDeletedEntities().catch(() => undefined);
    return listRecentlyDeleted(user, {
      limit: parameters.has("limit") ? Number(parameters.get("limit")) : undefined,
      cursor: parameters.get("cursor"),
      type: parameters.has("type")
        ? parameters.get("type") as DeletableEntityType
        : undefined,
    });
  });
}
