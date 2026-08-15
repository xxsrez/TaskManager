export type Actor = {
  provider: "chatgpt";
  providerAccountKey: string;
  displayName: string;
  email: string;
};

let actorResolverForTests: (() => Promise<Actor | null>) | null = null;

export function configureActorResolverForTests(
  resolver: (() => Promise<Actor | null>) | null,
) {
  actorResolverForTests = resolver;
}

export async function getCurrentActor(): Promise<Actor | null> {
  if (actorResolverForTests) return actorResolverForTests();
  const { getChatGPTUser } = await import("@/app/chatgpt-auth");
  const user = await getChatGPTUser();
  if (user) {
    return {
      provider: "chatgpt",
      providerAccountKey: user.userId,
      displayName: user.displayName,
      email: user.email,
    };
  }
  if (process.env.NODE_ENV === "development") {
    return {
      provider: "chatgpt",
      providerAccountKey: "local-development-user",
      displayName: "Local developer",
      email: "local@example.test",
    };
  }
  return null;
}
