import { readJson, withUser } from "@/lib/http";
import { bulkSetTaskLabelGroupValue } from "@/lib/repository";

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser((user) => bulkSetTaskLabelGroupValue(user, input));
}
