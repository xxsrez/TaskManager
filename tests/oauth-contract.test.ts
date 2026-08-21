import assert from "node:assert/strict";
import test from "node:test";
import {
  OAuthProtocolError,
  createOAuthSecret,
  oauthAuthorizationServerMetadata,
  oauthClientRegistrationResponse,
  oauthConsentContentSecurityPolicy,
  oauthProtectedResourceMetadata,
  oauthProtectedResourceMetadataUrl,
  oauthResource,
  parseOAuthClientRegistration,
  parseOAuthScopes,
  pkceS256,
  validateAuthorizationRequestParameters,
  validateClientMetadataDocument,
} from "../lib/oauth-contract";

const origin = "https://tasks.example.test";
const clientId = "https://chatgpt.com/.well-known/oauth-client/task-manager.json";
const redirectUri = "https://chatgpt.com/connector/oauth/callback-id";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

test("OAuth consent allows the registered callback origin after POST", () => {
  const csp = oauthConsentContentSecurityPolicy(redirectUri);
  assert.match(csp, /form-action 'self' https:\/\/chatgpt\.com;/);
  assert.doesNotMatch(csp, /connector\/oauth\/callback-id/);

  const loopback = oauthConsentContentSecurityPolicy(
    "http://127.0.0.1:49152/callback",
  );
  assert.match(loopback, /form-action 'self' http:\/\/127\.0\.0\.1:49152;/);
});

test("OAuth discovery binds the connector resource and directs native clients to DCR", () => {
  const authorization = oauthAuthorizationServerMetadata(origin);
  const resource = oauthProtectedResourceMetadata(origin);
  assert.equal(authorization.issuer, origin);
  assert.equal(authorization.authorization_endpoint, `${origin}/oauth/authorize`);
  assert.equal(authorization.token_endpoint, `${origin}/oauth/token`);
  assert.equal(authorization.registration_endpoint, `${origin}/oauth/register`);
  assert.deepEqual(authorization.code_challenge_methods_supported, ["S256"]);
  assert.equal(authorization.client_id_metadata_document_supported, false);
  assert.equal(resource.resource, `${origin}/api/mcp`);
  assert.deepEqual(resource.authorization_servers, [origin]);
  assert.equal(
    oauthProtectedResourceMetadataUrl(origin),
    `${origin}/.well-known/oauth-protected-resource/api/mcp`,
  );
});

test("dynamic client registration accepts Codex public clients and rejects unsafe callbacks", () => {
  const registration = parseOAuthClientRegistration(
    {
      client_name: "Codex Desktop",
      redirect_uris: ["http://127.0.0.1:49152/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    new Set(["https://chatgpt.com"]),
  );
  assert.deepEqual(registration.redirectUris, [
    "http://127.0.0.1:49152/callback",
  ]);
  assert.equal(registration.clientName, "Codex Desktop");
  assert.deepEqual(
    oauthClientRegistrationResponse("tm_oauth_client_123", registration, 123),
    {
      client_id: "tm_oauth_client_123",
      client_id_issued_at: 123,
      client_name: "Codex Desktop",
      redirect_uris: ["http://127.0.0.1:49152/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  );

  assert.throws(
    () =>
      parseOAuthClientRegistration(
        {
          redirect_uris: ["https://attacker.example/callback"],
          token_endpoint_auth_method: "none",
        },
        new Set(["https://chatgpt.com"]),
      ),
    (error: unknown) =>
      error instanceof OAuthProtocolError && error.code === "invalid_client",
  );
  assert.throws(
    () =>
      parseOAuthClientRegistration(
        {
          redirect_uris: ["http://127.0.0.1:49152/callback"],
          token_endpoint_auth_method: "client_secret_basic",
        },
        new Set(["https://chatgpt.com"]),
      ),
    (error: unknown) =>
      error instanceof OAuthProtocolError && error.code === "invalid_client",
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

  url.searchParams.append("resource", oauthResource(origin));
  assert.equal(
    validateAuthorizationRequestParameters(url).resource,
    oauthResource(origin),
  );
  url.searchParams.set("resource", "https://other.example/api/mcp");
  url.searchParams.append("resource", oauthResource(origin));
  assert.throws(
    () => validateAuthorizationRequestParameters(url),
    (error: unknown) =>
      error instanceof OAuthProtocolError && error.code === "invalid_request",
  );
  url.searchParams.set("resource", oauthResource(origin));

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
