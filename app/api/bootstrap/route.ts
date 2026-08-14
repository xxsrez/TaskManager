import { withUser } from "@/lib/http";
import { getSnapshot } from "@/lib/repository";

export const dynamic = "force-dynamic";

export async function GET() {
  return withUser((user) => getSnapshot(user));
}
