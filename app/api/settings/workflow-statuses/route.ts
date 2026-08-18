import { readJson, withUser } from "@/lib/http";
import {
  createWorkflowStatus,
  listWorkflowStatuses,
} from "@/lib/workflow-statuses";

export const dynamic = "force-dynamic";

export async function GET() {
  return noStore(await withUser(async (user) => ({
    statuses: await listWorkflowStatuses(user),
  })));
}

export async function POST(request: Request) {
  const input = await readJson(request);
  return noStore(await withUser(async (user) => ({
    statuses: await createWorkflowStatus(user, input),
  })));
}

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
