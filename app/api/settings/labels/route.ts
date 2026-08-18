import { readJson, withUser } from "@/lib/http";
import { createLabel, listOwnedLabels } from "@/lib/repository";

export const dynamic = "force-dynamic";

export async function GET() {
  return noStore(await withUser(async (user) => ({
    labels: await listOwnedLabels(user),
  })));
}

export async function POST(request: Request) {
  const input = await readJson(request);
  return noStore(await withUser(async (user) => ({
    labels: await createLabel(user, input),
  })));
}

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
