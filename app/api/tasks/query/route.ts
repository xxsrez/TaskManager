import { readJson, withUser } from "@/lib/http";
import { queryTaskSummaries, type TaskQueryInput } from "@/lib/repository";

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser((user) => queryTaskSummaries(user, input as TaskQueryInput));
}
