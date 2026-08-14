import type { ApiScope } from "./api-credential-crypto";
import type { AgentAuthorizationContext } from "./agent-api-context";
import { AgentApiError } from "./agent-api-contract";
import { authenticatePersonalApiToken } from "./api-credentials";
import { authenticateOAuthAccessToken, bearerToken } from "./oauth";

export async function authenticateAgentRequest(
  request: Request,
  requiredScope: ApiScope,
): Promise<AgentAuthorizationContext> {
  const token = bearerToken(request);
  if (!token) {
    throw new AgentApiError(
      "unauthenticated",
      "A valid bearer token is required",
      401,
    );
  }
  if (token.startsWith("tm_oat_")) {
    return authenticateOAuthAccessToken(token, requiredScope);
  }
  if (token.startsWith("tm_pat_")) {
    return authenticatePersonalApiToken(token, requiredScope);
  }
  throw new AgentApiError(
    "unauthenticated",
    "A valid bearer token is required",
    401,
  );
}
