import { readJson, withUser } from "@/lib/http";
import {
  getTeamGrantContext,
  grantTeamAccess,
  revokeTeamAccess,
} from "@/lib/teams";

export async function GET(request: Request) {
  const url = new URL(request.url);
  return withUser((user) => getTeamGrantContext(user, {
    resourceType: url.searchParams.get("resource_type") ?? "",
    resourceId: url.searchParams.get("resource_id") ?? "",
  }));
}

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    await grantTeamAccess(user, input);
    return getTeamGrantContext(user, {
      resourceType: String(input.resourceType ?? ""),
      resourceId: String(input.resourceId ?? ""),
    });
  });
}

export async function DELETE(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    await revokeTeamAccess(user, input);
    return getTeamGrantContext(user, {
      resourceType: String(input.resourceType ?? ""),
      resourceId: String(input.resourceId ?? ""),
    });
  });
}
