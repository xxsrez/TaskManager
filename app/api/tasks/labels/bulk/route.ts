import { readJson, withUser } from "@/lib/http";
import { bulkSetTaskLabel } from "@/lib/repository";

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => bulkSetTaskLabel(user, input));
}
