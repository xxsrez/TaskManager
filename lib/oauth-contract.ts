import {
  API_SCOPES,
  normalizeApiScopes,
  type ApiScope,
} from "./api-credential-crypto";

export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const OAUTH_AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
export const OAUTH_AUTHORIZATION_REQUEST_TTL_SECONDS = 10 * 60;
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export type OAuthClientMetadata = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
};

export type OAuthClientRegistration = {
  clientName: string;
  redirectUris: string[];
  grantTypes: Array<"authorization_code" | "refresh_token">;
  responseTypes: ["code"];
  tokenEndpointAuthMethod: "none";
};

export class OAuthProtocolError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "invalid_client"
      | "invalid_grant"
      | "invalid_scope"
      | "invalid_target"
      | "unsupported_grant_type"
      | "unsupported_response_type"
      | "access_denied"
      | "server_error",
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function oauthResource(origin: string): string {
  return `${normalizeOrigin(origin)}/api/mcp`;
}

export function oauthProtectedResourceMetadataUrl(origin: string): string {
  return `${normalizeOrigin(origin)}/.well-known/oauth-protected-resource/api/mcp`;
}

export function oauthAuthorizationServerMetadata(origin: string) {
  const issuer = normalizeOrigin(origin);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    scopes_supported: [...API_SCOPES],
    resource_parameter_supported: true,
  } as const;
}

export function parseOAuthClientRegistration(
  value: unknown,
  allowedRedirectOrigins: ReadonlySet<string>,
): OAuthClientRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OAuthProtocolError(
      "invalid_client",
      "Client registration must be a JSON object",
    );
  }
  const metadata = value as Record<string, unknown>;
  if (
    !Array.isArray(metadata.redirect_uris) ||
    metadata.redirect_uris.length === 0 ||
    metadata.redirect_uris.length > 10 ||
    !metadata.redirect_uris.every((entry) => typeof entry === "string")
  ) {
    throw new OAuthProtocolError(
      "invalid_client",
      "redirect_uris must contain between one and ten URLs",
    );
  }
  const redirectUris = metadata.redirect_uris.map((entry) =>
    validateRegisteredRedirectUri(entry as string, allowedRedirectOrigins),
  );
  if (new Set(redirectUris).size !== redirectUris.length) {
    throw new OAuthProtocolError(
      "invalid_client",
      "redirect_uris must not contain duplicates",
    );
  }

  const grantTypes = stringArray(
    metadata.grant_types,
    ["authorization_code", "refresh_token"],
    "grant_types",
  );
  if (
    !grantTypes.includes("authorization_code") ||
    grantTypes.some(
      (entry) => entry !== "authorization_code" && entry !== "refresh_token",
    )
  ) {
    throw new OAuthProtocolError(
      "invalid_client",
      "Only authorization_code and refresh_token grants are supported",
    );
  }
  const responseTypes = stringArray(
    metadata.response_types,
    ["code"],
    "response_types",
  );
  if (responseTypes.length !== 1 || responseTypes[0] !== "code") {
    throw new OAuthProtocolError(
      "invalid_client",
      "Only response_type=code is supported",
    );
  }
  if (
    metadata.token_endpoint_auth_method !== undefined &&
    metadata.token_endpoint_auth_method !== "none"
  ) {
    throw new OAuthProtocolError(
      "invalid_client",
      "Only public clients with token_endpoint_auth_method=none are supported",
    );
  }
  const clientName =
    typeof metadata.client_name === "string" && metadata.client_name.trim()
      ? metadata.client_name.trim().slice(0, 120)
      : "Codex or ChatGPT";
  return {
    clientName,
    redirectUris,
    grantTypes: grantTypes as Array<"authorization_code" | "refresh_token">,
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
  };
}

export function oauthClientRegistrationResponse(
  clientId: string,
  registration: OAuthClientRegistration,
  issuedAt = Math.floor(Date.now() / 1000),
) {
  return {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: registration.clientName,
    redirect_uris: registration.redirectUris,
    grant_types: registration.grantTypes,
    response_types: registration.responseTypes,
    token_endpoint_auth_method: registration.tokenEndpointAuthMethod,
  } as const;
}

export function oauthProtectedResourceMetadata(origin: string) {
  const issuer = normalizeOrigin(origin);
  return {
    resource: oauthResource(issuer),
    authorization_servers: [issuer],
    scopes_supported: [...API_SCOPES],
    resource_name: "Task Manager",
    resource_documentation: `${issuer}/api/agent/v1/openapi.json`,
  } as const;
}

export function parseOAuthScopes(
  value: string | null | undefined,
  defaultScopes: ApiScope[] = ["api:read"],
): ApiScope[] {
  const raw = value?.trim()
    ? value.trim().split(/\s+/)
    : defaultScopes;
  try {
    return normalizeApiScopes(raw);
  } catch {
    throw new OAuthProtocolError(
      "invalid_scope",
      "Requested scopes are not supported",
    );
  }
}

export function parseStoredOAuthScopes(value: unknown): ApiScope[] {
  if (typeof value !== "string") return [];
  try {
    return normalizeApiScopes(JSON.parse(value));
  } catch {
    return [];
  }
}

export function validateAuthorizationRequestParameters(url: URL): {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: ApiScope[];
  state: string | null;
  codeChallenge: string;
} {
  const responseType = requiredSingle(url.searchParams, "response_type");
  if (responseType !== "code") {
    throw new OAuthProtocolError(
      "unsupported_response_type",
      "Only response_type=code is supported",
    );
  }

  const clientId = requiredSingle(url.searchParams, "client_id");
  const redirectUri = validateRedirectUri(
    requiredSingle(url.searchParams, "redirect_uri"),
  );
  const resource = validateAbsoluteHttpsUrl(
    requiredRepeatedSame(url.searchParams, "resource"),
    "resource",
  );
  const codeChallenge = requiredSingle(url.searchParams, "code_challenge");
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    throw new OAuthProtocolError(
      "invalid_request",
      "code_challenge must be an S256 base64url digest",
    );
  }
  if (requiredSingle(url.searchParams, "code_challenge_method") !== "S256") {
    throw new OAuthProtocolError(
      "invalid_request",
      "Only code_challenge_method=S256 is supported",
    );
  }
  const state = optionalSingle(url.searchParams, "state", 2048);
  const scopes = parseOAuthScopes(optionalSingle(url.searchParams, "scope", 500));
  return { clientId, redirectUri, resource, scopes, state, codeChallenge };
}

export function validateClientMetadataDocument(
  clientId: string,
  redirectUri: string,
  value: unknown,
): OAuthClientMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OAuthProtocolError(
      "invalid_client",
      "Client metadata document must be a JSON object",
    );
  }
  const metadata = value as Record<string, unknown>;
  if (metadata.client_id !== undefined && metadata.client_id !== clientId) {
    throw new OAuthProtocolError(
      "invalid_client",
      "Client metadata client_id does not match its URL",
    );
  }
  if (
    !Array.isArray(metadata.redirect_uris) ||
    !metadata.redirect_uris.every((entry) => typeof entry === "string") ||
    !metadata.redirect_uris.includes(redirectUri)
  ) {
    throw new OAuthProtocolError(
      "invalid_client",
      "redirect_uri is not registered by the client metadata document",
    );
  }
  if (
    Array.isArray(metadata.response_types) &&
    !metadata.response_types.includes("code")
  ) {
    throw new OAuthProtocolError(
      "invalid_client",
      "Client does not support the authorization code flow",
    );
  }
  const tokenMethods = Array.isArray(
    metadata.token_endpoint_auth_methods_supported,
  )
    ? metadata.token_endpoint_auth_methods_supported
    : metadata.token_endpoint_auth_method
      ? [metadata.token_endpoint_auth_method]
      : ["none"];
  if (!tokenMethods.includes("none")) {
    throw new OAuthProtocolError(
      "invalid_client",
      "Client must support public PKCE token exchange",
    );
  }
  return {
    clientId,
    clientName:
      typeof metadata.client_name === "string" && metadata.client_name.trim()
        ? metadata.client_name.trim().slice(0, 120)
        : "Codex or ChatGPT",
    redirectUris: metadata.redirect_uris as string[],
  };
}

export function validateCodeVerifier(value: string): string {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(value)) {
    throw new OAuthProtocolError(
      "invalid_grant",
      "code_verifier is invalid",
    );
  }
  return value;
}

export async function pkceS256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

export function createOAuthSecret(prefix: "tm_oac_" | "tm_oat_" | "tm_ort_") {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}${base64UrlEncode(bytes)}`;
}

export function oauthErrorResponse(error: unknown): Response {
  const protocolError =
    error instanceof OAuthProtocolError
      ? error
      : new OAuthProtocolError(
          "server_error",
          "The authorization server could not complete the request",
          500,
        );
  return Response.json(
    {
      error: protocolError.code,
      error_description: protocolError.message,
    },
    {
      status: protocolError.status,
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    },
  );
}

function requiredSingle(searchParams: URLSearchParams, name: string): string {
  const values = searchParams.getAll(name);
  if (values.length !== 1 || !values[0]?.trim()) {
    throw new OAuthProtocolError(
      "invalid_request",
      `${name} is required exactly once`,
    );
  }
  return values[0];
}

function requiredRepeatedSame(
  searchParams: URLSearchParams,
  name: string,
): string {
  const values = searchParams.getAll(name);
  if (
    values.length === 0 ||
    !values[0]?.trim() ||
    values.some((value) => value !== values[0])
  ) {
    throw new OAuthProtocolError(
      "invalid_request",
      `${name} is required and repeated values must match`,
    );
  }
  return values[0];
}

function optionalSingle(
  searchParams: URLSearchParams,
  name: string,
  maxLength: number,
): string | null {
  const values = searchParams.getAll(name);
  if (values.length > 1) {
    throw new OAuthProtocolError(
      "invalid_request",
      `${name} must not be repeated`,
    );
  }
  const value = values[0] ?? null;
  if (value !== null && value.length > maxLength) {
    throw new OAuthProtocolError(
      "invalid_request",
      `${name} is too long`,
    );
  }
  return value;
}

function validateRedirectUri(value: string): string {
  const normalized = validateAbsoluteHttpsUrl(value, "redirect_uri");
  const url = new URL(normalized);
  if (url.hash || url.username || url.password) {
    throw new OAuthProtocolError(
      "invalid_request",
      "redirect_uri must not contain credentials or a fragment",
    );
  }
  return url.toString();
}

function validateRegisteredRedirectUri(
  value: string,
  allowedOrigins: ReadonlySet<string>,
): string {
  let normalized: string;
  try {
    normalized = validateRedirectUri(value);
  } catch {
    throw new OAuthProtocolError(
      "invalid_client",
      "Each redirect_uri must be HTTPS or a loopback HTTP URL",
    );
  }
  const url = new URL(normalized);
  const loopback =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!loopback && !allowedOrigins.has(url.origin)) {
    throw new OAuthProtocolError(
      "invalid_client",
      "This redirect_uri origin is not allowed",
    );
  }
  return normalized;
}

function stringArray(
  value: unknown,
  fallback: string[],
  field: string,
): string[] {
  if (value === undefined) return fallback;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 4 ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new OAuthProtocolError(
      "invalid_client",
      `${field} must be a non-empty string array`,
    );
  }
  return [...new Set(value as string[])];
}

function validateAbsoluteHttpsUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthProtocolError(
      "invalid_request",
      `${field} must be an absolute URL`,
    );
  }
  const localDevelopment =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localDevelopment) {
    throw new OAuthProtocolError(
      "invalid_request",
      `${field} must use HTTPS`,
    );
  }
  return url.toString();
}

function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  return url.origin;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
