import type { ApiScope } from "./api-credential-crypto";
import type { UserRecord } from "./types";

export type AgentAuthorizationContext = {
  authorizationId: string;
  authorizationType: "oauth" | "personal_token";
  clientId: string;
  scopes: ApiScope[];
  user: UserRecord;
  expiresAt: number | null;
  resource: string | null;
};
