import { getCurrentActor } from "./auth";
import { getOrCreateUser } from "./repository";

export async function withUser<T>(
  action: (user: Awaited<ReturnType<typeof getOrCreateUser>>) => Promise<T>,
) {
  const actor = await getCurrentActor();
  if (!actor) return Response.json({ error: "Authentication required" }, { status: 401 });
  try {
    const user = await getOrCreateUser(actor);
    return Response.json(await action(user));
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? Number(error.status)
        : 500;
    const message =
      error instanceof Error && status < 500
        ? error.message
        : "Something went wrong";
    if (status >= 500) console.error(error);
    return Response.json({ error: message }, { status });
  }
}

export async function withUserResponse(
  action: (user: Awaited<ReturnType<typeof getOrCreateUser>>) => Promise<Response>,
) {
  const actor = await getCurrentActor();
  if (!actor) return Response.json({ error: "Authentication required" }, { status: 401 });
  try {
    const user = await getOrCreateUser(actor);
    return await action(user);
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? Number(error.status)
        : 500;
    const message =
      error instanceof Error && status < 500
        ? error.message
        : "Something went wrong";
    if (status >= 500) console.error(error);
    return Response.json({ error: message }, { status });
  }
}

export async function readJson(request: Request) {
  const value = await request.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
