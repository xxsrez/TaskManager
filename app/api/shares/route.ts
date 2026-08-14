import { readJson, withUser } from "@/lib/http";
import {
  getSnapshot,
  grantAccess,
  revokeAccess,
  updateAccessRole,
} from "@/lib/repository";

export async function POST(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    await grantAccess(user, input);
    return getSnapshot(user);
  });
}

export async function DELETE(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    await revokeAccess(user, String(input.grantId ?? ""));
    return getSnapshot(user);
  });
}

export async function PATCH(request: Request) {
  const input = await readJson(request);
  return withUser(async (user) => {
    await updateAccessRole(user, String(input.grantId ?? ""), input);
    return getSnapshot(user);
  });
}
