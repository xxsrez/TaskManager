import {
  issueApiCredential,
  listApiCredentials,
} from "@/lib/api-credentials";
import { readJson, withUser } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return noStore(await withUser((user) => listApiCredentials(user)));
}

export async function POST(request: Request) {
  const input = await readJson(request);
  return noStore(await withUser((user) => issueApiCredential(user, input)));
}

function noStore(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
