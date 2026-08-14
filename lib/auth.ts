import { getChatGPTUser } from "@/app/chatgpt-auth";

export type Actor = {
  provider: "chatgpt";
  providerAccountKey: string;
  displayName: string;
  email: string;
};

export async function getCurrentActor(): Promise<Actor | null> {
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
