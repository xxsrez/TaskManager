import { readJson, withUser } from "@/lib/http";
import { getTaskLabelState, setTaskLabelGroupValue } from "@/lib/repository";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return withUser((user) => getTaskLabelState(user, id));
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const input = await readJson(request);
  const { id } = await context.params;
  return withUser((user) => setTaskLabelGroupValue(user, id, input));
}
