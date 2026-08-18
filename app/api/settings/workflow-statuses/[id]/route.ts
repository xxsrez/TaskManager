import { readJson, withUser } from "@/lib/http";
import { ValidationError } from "@/lib/domain";
import {
  archiveWorkflowStatus,
  moveWorkflowStatus,
  restoreWorkflowStatus,
  updateWorkflowStatus,
} from "@/lib/workflow-statuses";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const input = await readJson(request);
  const { id } = await context.params;
  return noStore(await withUser(async (user) => {
    const action = input.action ?? "update";
    if (action === "update") return { statuses: await updateWorkflowStatus(user, id, input) };
    if (action === "move") return { statuses: await moveWorkflowStatus(user, id, input) };
    if (action === "archive") return { statuses: await archiveWorkflowStatus(user, id, input) };
    if (action === "restore") return { statuses: await restoreWorkflowStatus(user, id, input) };
    throw new ValidationError("Unsupported workflow status action");
  }));
}

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
