import { withUser } from "@/lib/http";
import { getSnapshot } from "@/lib/repository";
import { RECENT_NAVIGATION_LIMIT } from "@/lib/recent-navigation";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUser((user) => getSnapshot(user, {
    navigationLimit: RECENT_NAVIGATION_LIMIT,
  }));
}
