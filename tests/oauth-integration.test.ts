import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getOrCreateUser } from "../lib/repository";
import {
  authenticateOAuthAccessToken,
  completeOAuthAuthorization,
  handleOAuthClientRegistrationRequest,
  handleOAuthTokenRequest,
  prepareOAuthAuthorization,
} from "../lib/oauth";
import { pkceS256 } from "../lib/oauth-contract";
import { createD1TestHarness } from "./helpers/d1";

const origin = "https://task-manager.example.test";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
let dispose: (() => Promise<void>) | undefined;

before(async () => {
  const harness = await createD1TestHarness({
    TASK_MANAGER_PUBLIC_ORIGIN: origin,
    TASK_MANAGER_OAUTH_CLIENT_ORIGINS: "https://chatgpt.com",
  });
  dispose = harness.dispose;
});

after(async () => dispose?.());

test("OAuth authorization code flow persists, exchanges, and scopes tokens", async () => {
  const user = await getOrCreateUser({
    provider: "chatgpt",
    providerAccountKey: "oauth-owner",
    displayName: "OAuth Owner",
    email: "oauth-owner@example.test",
  });
  const registrationResponse = await handleOAuthClientRegistrationRequest(
    new Request(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Codex integration test",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }),
  );
  assert.equal(registrationResponse.status, 201);
  const registration = await registrationResponse.json() as { client_id: string };
  const verifier = "a".repeat(64);
  const resource = `${origin}/api/mcp`;
  const authorizationUrl = new URL(`${origin}/oauth/authorize`);
  authorizationUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    resource,
    scope: "api:read",
    state: "state-1",
    code_challenge: await pkceS256(verifier),
    code_challenge_method: "S256",
  }).toString();
  const prompt = await prepareOAuthAuthorization(
    user,
    new Request(authorizationUrl),
  );
  const redirect = new URL(
    await completeOAuthAuthorization(user, prompt.requestId, true),
  );
  assert.equal(redirect.searchParams.get("state"), "state-1");

  const tokenResponse = await handleOAuthTokenRequest(
    new Request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: redirect.searchParams.get("code")!,
        client_id: registration.client_id,
        redirect_uri: redirectUri,
        resource,
        code_verifier: verifier,
      }),
    }),
  );
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json() as {
    access_token: string;
    refresh_token: string;
  };
  const context = await authenticateOAuthAccessToken(
    tokens.access_token,
    "api:read",
    resource,
  );
  assert.equal(context.user.id, user.id);
  assert.deepEqual(context.scopes, ["api:read"]);
  await assert.rejects(
    authenticateOAuthAccessToken(tokens.access_token, "api:write", resource),
    /requires api:write/,
  );
});
