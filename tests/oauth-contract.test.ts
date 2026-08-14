import assert from "node:assert/strict";
import test from "node:test";
import {
  OAuthProtocolError,
  createOAuthSecret,
  oauthAuthorizationServerMetadata,
  oauthProtectedResourceMetadata,
  oauthProtectedResourceMetadataUrl,
  oauthResource,
  parseOAuthScopes,
  pkceS256,
  validateAuthorizationRequestParameters,
  validateClientMetadataDocument,
} from "../lib/oauth-contract";

const origin = "https://tasks.example.test";
const clientId = "https://chatgpt.com/.well-known/oauth-client/task-manager.json";
const redirectUri = "https://chatgpt.com/connector/oauth/callback-id";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

test("OAuth discovery binds the connector resource and advertises PKCE", () => {
  const authorization = oauthAuthorizationServerMetadata(origin);
  const resource = oauthProtectedResourceMetadata(origin);
  assert.equal(authorization.issuer, origin);
  assert.equal(authorization.authorization_endpoint, `${origin}/oauth/authorize`);
  assert.equal(authorization.token_endpoint, `${origin}/oauth/token`);
  assert.deepEqual(authorization.code_challenge_methods_supported, ["S256"]);
  assert.equal(authorization.client_id_metadata_document_supported, true);
  assert.equal(resource.resource, `${origin}/api/mcp`);
  assert.deepEqual(resource.authorization_servers, [origin]);
  assert.equal(
    oauthProtectedResourceMetadataUrl(origin),
    `${origin}/.well-known/oauth-protected-resource/api/mcp`,
  );
});

test("authorization requests require an exact resource, redirect, and S256 challenge", async () => {
  const challenge = await pkceS256(verifier);
  assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const url = new URL(`${origin}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: oauthResource(origin),
    scope: "api:write",
    state: "opaque-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const parsed = validateAuthorizationRequestParameters(url);
  assert.deepEqual(parsed.scopes, ["api:read", "api:write"]);
  assert.equal(parsed.resource, `${origin}/api/mcp`);
  assert.equal(parsed.redirectUri, redirectUri);

  url.searchParams.set("code_challenge_method", "plain");
  assert.throws(
    () => validateAuthorizationRequestParameters(url),
    (error: unknown) =>
      error instanceof OAuthProtocolError && error.code === "invalid_request",
  );
});

test("CIMD client metadata must register the exact callback and public auth method", () => {
  const metadata = {
    client_id: clientId,
    client_name: "Codex Desktop",
    redirect_uris: [redirectUri],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  assert.equal(
    validateClientMetadataDocument(clientId, redirectUri, metadata).clientName,
    "Codex Desktop",
  );
  assert.throws(
    () =>
      validateClientMetadataDocument(clientId, `${redirectUri}/other`, metadata),
    (error: unknown) =>
      error instanceof OAuthProtocolError && error.code === "invalid_client",
  );
  assert.throws(
    () =>
      validateClientMetadataDocument(clientId, redirectUri, {
        ...metadata,
        token_endpoint_auth_method: "client_secret_basic",
      }),
    (error: unknown) =>
      error instanceof OAuthProtocolError && error.code === "invalid_client",
  );
});

test("OAuth scopes and token formats are bounded", () => {
  assert.deepEqual(parseOAuthScopes(undefined), ["api:read"]);
  assert.deepEqual(parseOAuthScopes("api:write"), ["api:read", "api:write"]);
  assert.throws(
    () => parseOAuthScopes("admin"),
    (error: unknown) =>
      error instanceof OAuthProtocolError && error.code === "invalid_scope",
  );
  assert.match(createOAuthSecret("tm_oac_"), /^tm_oac_[A-Za-z0-9_-]{40,}$/);
  assert.match(createOAuthSecret("tm_oat_"), /^tm_oat_[A-Za-z0-9_-]{40,}$/);
  assert.match(createOAuthSecret("tm_ort_"), /^tm_ort_[A-Za-z0-9_-]{40,}$/);
});
