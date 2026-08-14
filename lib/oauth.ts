import { env } from "cloudflare:workers";
import { getD1 } from "@/db";
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import type { AgentAuthorizationContext } from "./agent-api-context";
import { AgentApiError } from "./agent-api-contract";
import {
  apiTokenFromAuthorization,
  hashApiToken,
  type ApiScope,
} from "./api-credential-crypto";
import {
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_AUTHORIZATION_CODE_TTL_SECONDS,
  OAUTH_AUTHORIZATION_REQUEST_TTL_SECONDS,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  OAuthProtocolError,
  createOAuthSecret,
  oauthErrorResponse,
  oauthResource,
  parseOAuthScopes,
  parseStoredOAuthScopes,
  pkceS256,
  validateAuthorizationRequestParameters,
  validateClientMetadataDocument,
  validateCodeVerifier,
} from "./oauth-contract";
import { ensureDatabase } from "./repository";
import type { UserRecord } from "./types";
import { authenticatePersonalApiToken } from "./api-credentials";

type DbRow = Record<string, unknown>;

export type OAuthAuthorizationPrompt = {
  requestId: string;
  clientName: string;
  scopes: ApiScope[];
  user: UserRecord;
};

export type OAuthConnectionSummary = {
  id: string;
  clientName: string;
  clientId: string;
  scopes: ApiScope[];
  lastUsedAt: string | null;
  createdAt: string;
};

export function publicOrigin(request: Request): string {
  const configured = (
    env as unknown as { TASK_MANAGER_PUBLIC_ORIGIN?: string }
  ).TASK_MANAGER_PUBLIC_ORIGIN?.trim();
  const candidate = configured || new URL(request.url).origin;
  const url = new URL(candidate);
  if (url.protocol !== "https:" && process.env.NODE_ENV !== "development") {
    throw new Error("TASK_MANAGER_PUBLIC_ORIGIN must use HTTPS");
  }
  return url.origin;
}

export async function prepareOAuthAuthorization(
  currentUser: UserRecord,
  request: Request,
): Promise<OAuthAuthorizationPrompt> {
  await ensureDatabase();
  const origin = publicOrigin(request);
  const parameters = validateAuthorizationRequestParameters(new URL(request.url));
  if (parameters.resource !== oauthResource(origin)) {
    throw new OAuthProtocolError(
      "invalid_target",
      "The requested resource is not this Task Manager connector",
    );
  }
  const client = await fetchAndValidateClientMetadata(
    parameters.clientId,
    parameters.redirectUri,
  );
  const requestId = `oauth_request_${crypto.randomUUID()}`;
  const now = Date.now();
  await cleanExpiredOAuthArtifacts();
  await getD1()
    .prepare(
      `INSERT INTO oauth_authorization_requests
        (id, owner_user_id, client_id, client_name, redirect_uri, resource,
         scopes_json, state, code_challenge, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      requestId,
      currentUser.id,
      client.clientId,
      client.clientName,
      parameters.redirectUri,
      parameters.resource,
      JSON.stringify(parameters.scopes),
      parameters.state,
      parameters.codeChallenge,
      new Date(now + OAUTH_AUTHORIZATION_REQUEST_TTL_SECONDS * 1000).toISOString(),
      new Date(now).toISOString(),
    )
    .run();
  return {
    requestId,
    clientName: client.clientName,
    scopes: parameters.scopes,
    user: currentUser,
  };
}

export async function completeOAuthAuthorization(
  currentUser: UserRecord,
  requestId: string,
  approved: boolean,
): Promise<string> {
  if (!/^oauth_request_[0-9a-f-]{36}$/i.test(requestId)) {
    throw new OAuthProtocolError(
      "invalid_request",
      "Authorization request is invalid",
    );
  }
  await ensureDatabase();
  const pending = await getD1()
    .prepare(
      `DELETE FROM oauth_authorization_requests
       WHERE id = ? AND owner_user_id = ?
         AND datetime(expires_at) > datetime('now')
       RETURNING *`,
    )
    .bind(requestId, currentUser.id)
    .first<DbRow>();
  if (!pending) {
    throw new OAuthProtocolError(
      "invalid_request",
      "Authorization request is missing or expired",
    );
  }

  const redirect = new URL(String(pending.redirect_uri));
  const state = nullableString(pending.state);
  if (!approved) {
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set(
      "error_description",
      "The user declined Task Manager access",
    );
    if (state) redirect.searchParams.set("state", state);
    return redirect.toString();
  }

  const requestedScopes = parseStoredOAuthScopes(pending.scopes_json);
  const existingGrant = await getD1()
    .prepare(
      `SELECT id, scopes_json FROM oauth_grants
       WHERE owner_user_id = ? AND client_id = ? AND resource = ? LIMIT 1`,
    )
    .bind(currentUser.id, pending.client_id, pending.resource)
    .first<DbRow>();
  const grantId = existingGrant
    ? String(existingGrant.id)
    : `oauth_grant_${crypto.randomUUID()}`;
  const scopes = mergeScopes(
    parseStoredOAuthScopes(existingGrant?.scopes_json),
    requestedScopes,
  );
  const code = createOAuthSecret("tm_oac_");
  const codeHash = await hashApiToken(code);
  const codeId = `oauth_code_${crypto.randomUUID()}`;
  const expiresAt = new Date(
    Date.now() + OAUTH_AUTHORIZATION_CODE_TTL_SECONDS * 1000,
  ).toISOString();
  const db = getD1();
  await db.batch([
    db
      .prepare(
        `INSERT INTO oauth_grants
          (id, owner_user_id, client_id, client_name, resource, scopes_json,
           revoked_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)
         ON CONFLICT(owner_user_id, client_id, resource) DO UPDATE SET
           client_name = excluded.client_name,
           scopes_json = excluded.scopes_json,
           revoked_at = NULL,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(
        grantId,
        currentUser.id,
        pending.client_id,
        pending.client_name,
        pending.resource,
        JSON.stringify(scopes),
      ),
    db
      .prepare(
        `INSERT INTO oauth_authorization_codes
          (id, code_hash, grant_id, owner_user_id, client_id, redirect_uri,
           resource, scopes_json, code_challenge, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        codeId,
        codeHash,
        grantId,
        currentUser.id,
        pending.client_id,
        pending.redirect_uri,
        pending.resource,
        JSON.stringify(requestedScopes),
        pending.code_challenge,
        expiresAt,
      ),
  ]);

  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  return redirect.toString();
}

export async function handleOAuthTokenRequest(request: Request): Promise<Response> {
  try {
    requireFormUrlEncoded(request);
    const form = await request.formData();
    rejectClientSecret(form);
    const grantType = formString(form, "grant_type");
    if (grantType === "authorization_code") {
      return tokenResponse(await exchangeAuthorizationCode(form));
    }
    if (grantType === "refresh_token") {
      return tokenResponse(await rotateRefreshToken(form));
    }
    throw new OAuthProtocolError(
      "unsupported_grant_type",
      "Only authorization_code and refresh_token grants are supported",
    );
  } catch (error) {
    if (!(error instanceof OAuthProtocolError)) console.error(error);
    return oauthErrorResponse(error);
  }
}

export async function handleOAuthRevocation(request: Request): Promise<Response> {
  try {
    requireFormUrlEncoded(request);
    const form = await request.formData();
    rejectClientSecret(form);
    const token = formString(form, "token");
    const clientId = formString(form, "client_id");
    await ensureDatabase();
    const tokenHash = await hashApiToken(token);
    const db = getD1();
    if (token.startsWith("tm_ort_")) {
      const row = await db
        .prepare(
          `SELECT grant_id, family_id FROM oauth_refresh_tokens
           WHERE token_hash = ? AND client_id = ? LIMIT 1`,
        )
        .bind(tokenHash, clientId)
        .first<{ grant_id: string; family_id: string }>();
      if (row) await revokeGrantAndFamily(row.grant_id, row.family_id);
    } else if (token.startsWith("tm_oat_")) {
      await db
        .prepare(
          `UPDATE oauth_access_tokens SET revoked_at = CURRENT_TIMESTAMP
           WHERE token_hash = ? AND client_id = ?`,
        )
        .bind(tokenHash, clientId)
        .run();
    }
  } catch (error) {
    if (!(error instanceof OAuthProtocolError)) console.error(error);
  }
  return new Response(null, {
    status: 200,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}

export async function authenticateOAuthAccessToken(
  token: string,
  requiredScope?: ApiScope,
  expectedResource?: string,
): Promise<AgentAuthorizationContext> {
  if (!token.startsWith("tm_oat_")) {
    throw unauthenticatedOAuthToken();
  }
  await ensureDatabase();
  const tokenHash = await hashApiToken(token);
  const row = await getD1()
    .prepare(
      `SELECT t.id AS token_id, t.grant_id, t.client_id, t.resource,
              t.scopes_json, t.expires_at,
              u.id, u.display_name, u.email, u.timezone
       FROM oauth_access_tokens t
       JOIN oauth_grants g ON g.id = t.grant_id
       JOIN users u ON u.id = t.owner_user_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL
         AND g.revoked_at IS NULL
         AND datetime(t.expires_at) > datetime('now')
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<DbRow>();
  if (!row) throw unauthenticatedOAuthToken();
  const resource = String(row.resource);
  if (expectedResource && resource !== expectedResource) {
    throw unauthenticatedOAuthToken();
  }
  const scopes = parseStoredOAuthScopes(row.scopes_json);
  if (requiredScope && !scopes.includes(requiredScope)) {
    throw new AgentApiError(
      "insufficient_scope",
      `The OAuth connection requires ${requiredScope}`,
      403,
    );
  }
  const db = getD1();
  await db.batch([
    db
      .prepare(
        `UPDATE oauth_access_tokens SET last_used_at = CURRENT_TIMESTAMP
         WHERE id = ? AND (
           last_used_at IS NULL OR datetime(last_used_at) < datetime('now', '-5 minutes')
         )`,
      )
      .bind(row.token_id),
    db
      .prepare(
        `UPDATE oauth_grants SET last_used_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND (
           last_used_at IS NULL OR datetime(last_used_at) < datetime('now', '-5 minutes')
         )`,
      )
      .bind(row.grant_id),
  ]);
  return {
    authorizationId: String(row.grant_id),
    authorizationType: "oauth",
    clientId: String(row.client_id),
    scopes,
    user: {
      id: String(row.id),
      displayName: String(row.display_name),
      email: String(row.email),
      timezone: String(row.timezone),
    },
    expiresAt: Math.floor(new Date(String(row.expires_at)).getTime() / 1000),
    resource,
  };
}

export async function verifyOAuthAccessTokenForMcp(
  token: string,
  expectedResource: string,
): Promise<AuthInfo> {
  try {
    const context = await authenticateOAuthAccessToken(
      token,
      "api:read",
      expectedResource,
    );
    return {
      token,
      clientId: context.clientId,
      scopes: context.scopes,
      expiresAt: context.expiresAt ?? undefined,
      resource: new URL(expectedResource),
      extra: {
        authorizationId: context.authorizationId,
        authorizationType: context.authorizationType,
        user: context.user,
      },
    };
  } catch (error) {
    if (error instanceof AgentApiError && error.code === "insufficient_scope") {
      throw new OAuthError(OAuthErrorCode.InsufficientScope, error.message);
    }
    throw new OAuthError(
      OAuthErrorCode.InvalidToken,
      "The access token is missing, expired, revoked, or for another resource",
    );
  }
}

export async function verifyAgentTokenForMcp(
  token: string,
  expectedResource: string,
): Promise<AuthInfo> {
  if (token.startsWith("tm_oat_")) {
    return verifyOAuthAccessTokenForMcp(token, expectedResource);
  }
  if (token.startsWith("tm_pat_")) {
    try {
      const context = await authenticatePersonalApiToken(token, "api:read");
      return {
        token,
        clientId: context.clientId,
        scopes: context.scopes,
        expiresAt: context.expiresAt ?? undefined,
        resource: new URL(expectedResource),
        extra: {
          authorizationId: context.authorizationId,
          authorizationType: context.authorizationType,
          user: context.user,
        },
      };
    } catch {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "The bearer token is invalid");
    }
  }
  throw new OAuthError(OAuthErrorCode.InvalidToken, "The bearer token is invalid");
}

export async function listOAuthConnections(
  currentUser: UserRecord,
): Promise<OAuthConnectionSummary[]> {
  await ensureDatabase();
  const rows = await getD1()
    .prepare(
      `SELECT id, client_name, client_id, scopes_json, last_used_at, created_at
       FROM oauth_grants
       WHERE owner_user_id = ? AND revoked_at IS NULL
       ORDER BY COALESCE(last_used_at, created_at) DESC`,
    )
    .bind(currentUser.id)
    .all<DbRow>();
  return rows.results.map((row) => ({
    id: String(row.id),
    clientName: String(row.client_name),
    clientId: String(row.client_id),
    scopes: parseStoredOAuthScopes(row.scopes_json),
    lastUsedAt: nullableString(row.last_used_at),
    createdAt: String(row.created_at),
  }));
}

export async function revokeOAuthConnection(
  currentUser: UserRecord,
  grantId: string,
): Promise<void> {
  await ensureDatabase();
  const db = getD1();
  const grant = await db
    .prepare(
      `SELECT id FROM oauth_grants
       WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL LIMIT 1`,
    )
    .bind(grantId, currentUser.id)
    .first<{ id: string }>();
  if (!grant) {
    throw new OAuthProtocolError("invalid_request", "Connection not found", 404);
  }
  await db.batch([
    db
      .prepare(
        `UPDATE oauth_grants SET revoked_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .bind(grantId),
    db
      .prepare(
        `UPDATE oauth_access_tokens SET revoked_at = CURRENT_TIMESTAMP
         WHERE grant_id = ? AND revoked_at IS NULL`,
      )
      .bind(grantId),
    db
      .prepare(
        `UPDATE oauth_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP
         WHERE grant_id = ? AND revoked_at IS NULL`,
      )
      .bind(grantId),
  ]);
}

export function bearerToken(request: Request): string | null {
  return apiTokenFromAuthorization(request.headers.get("authorization"));
}

async function exchangeAuthorizationCode(form: FormData) {
  const code = formString(form, "code");
  const clientId = formString(form, "client_id");
  const redirectUri = formString(form, "redirect_uri");
  const resource = formString(form, "resource");
  const verifier = validateCodeVerifier(formString(form, "code_verifier"));
  await ensureDatabase();
  const codeHash = await hashApiToken(code);
  const row = await getD1()
    .prepare(
      `SELECT * FROM oauth_authorization_codes
       WHERE code_hash = ? AND consumed_at IS NULL
         AND datetime(expires_at) > datetime('now') LIMIT 1`,
    )
    .bind(codeHash)
    .first<DbRow>();
  if (
    !row ||
    String(row.client_id) !== clientId ||
    String(row.redirect_uri) !== redirectUri ||
    String(row.resource) !== resource ||
    (await pkceS256(verifier)) !== String(row.code_challenge)
  ) {
    throw new OAuthProtocolError(
      "invalid_grant",
      "Authorization code is invalid, expired, or does not match the request",
    );
  }
  const consumed = await getD1()
    .prepare(
      `UPDATE oauth_authorization_codes SET consumed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND consumed_at IS NULL RETURNING id`,
    )
    .bind(row.id)
    .first<{ id: string }>();
  if (!consumed) {
    throw new OAuthProtocolError(
      "invalid_grant",
      "Authorization code has already been used",
    );
  }
  return issueOAuthTokens({
    grantId: String(row.grant_id),
    ownerUserId: String(row.owner_user_id),
    clientId,
    resource,
    scopes: parseStoredOAuthScopes(row.scopes_json),
  });
}

async function rotateRefreshToken(form: FormData) {
  const refreshToken = formString(form, "refresh_token");
  const clientId = formString(form, "client_id");
  const requestedResource = optionalFormString(form, "resource");
  await ensureDatabase();
  const tokenHash = await hashApiToken(refreshToken);
  const row = await getD1()
    .prepare(
      `SELECT t.* FROM oauth_refresh_tokens t
       JOIN oauth_grants g ON g.id = t.grant_id
       WHERE t.token_hash = ? AND g.revoked_at IS NULL LIMIT 1`,
    )
    .bind(tokenHash)
    .first<DbRow>();
  if (!row || String(row.client_id) !== clientId) {
    throw new OAuthProtocolError(
      "invalid_grant",
      "Refresh token is invalid or revoked",
    );
  }
  if (row.used_at || row.revoked_at) {
    await revokeGrantAndFamily(String(row.grant_id), String(row.family_id));
    throw new OAuthProtocolError(
      "invalid_grant",
      "Refresh token reuse was detected and the connection was revoked",
    );
  }
  if (new Date(String(row.expires_at)).getTime() <= Date.now()) {
    throw new OAuthProtocolError("invalid_grant", "Refresh token has expired");
  }
  const resource = String(row.resource);
  if (requestedResource && requestedResource !== resource) {
    throw new OAuthProtocolError(
      "invalid_target",
      "Refresh token is bound to another resource",
    );
  }
  const originalScopes = parseStoredOAuthScopes(row.scopes_json);
  const requestedScope = optionalFormString(form, "scope");
  const scopes = requestedScope
    ? parseOAuthScopes(requestedScope)
    : originalScopes;
  if (!scopes.every((scope) => originalScopes.includes(scope))) {
    throw new OAuthProtocolError(
      "invalid_scope",
      "Refresh cannot add scopes that were not originally granted",
    );
  }
  const consumed = await getD1()
    .prepare(
      `UPDATE oauth_refresh_tokens SET used_at = CURRENT_TIMESTAMP
       WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL RETURNING id`,
    )
    .bind(row.id)
    .first<{ id: string }>();
  if (!consumed) {
    await revokeGrantAndFamily(String(row.grant_id), String(row.family_id));
    throw new OAuthProtocolError(
      "invalid_grant",
      "Refresh token reuse was detected and the connection was revoked",
    );
  }
  return issueOAuthTokens({
    grantId: String(row.grant_id),
    ownerUserId: String(row.owner_user_id),
    clientId,
    resource,
    scopes,
    familyId: String(row.family_id),
    parentId: String(row.id),
  });
}

async function issueOAuthTokens(input: {
  grantId: string;
  ownerUserId: string;
  clientId: string;
  resource: string;
  scopes: ApiScope[];
  familyId?: string;
  parentId?: string;
}) {
  const accessToken = createOAuthSecret("tm_oat_");
  const refreshToken = createOAuthSecret("tm_ort_");
  const [accessHash, refreshHash] = await Promise.all([
    hashApiToken(accessToken),
    hashApiToken(refreshToken),
  ]);
  const accessId = `oauth_access_${crypto.randomUUID()}`;
  const refreshId = `oauth_refresh_${crypto.randomUUID()}`;
  const familyId = input.familyId ?? `oauth_family_${crypto.randomUUID()}`;
  const now = Date.now();
  const accessExpiresAt = new Date(
    now + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000,
  ).toISOString();
  const refreshExpiresAt = new Date(
    now + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000,
  ).toISOString();
  const db = getD1();
  await db.batch([
    db
      .prepare(
        `INSERT INTO oauth_access_tokens
          (id, token_hash, grant_id, owner_user_id, client_id, resource,
           scopes_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        accessId,
        accessHash,
        input.grantId,
        input.ownerUserId,
        input.clientId,
        input.resource,
        JSON.stringify(input.scopes),
        accessExpiresAt,
      ),
    db
      .prepare(
        `INSERT INTO oauth_refresh_tokens
          (id, token_hash, grant_id, family_id, parent_id, owner_user_id,
           client_id, resource, scopes_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        refreshId,
        refreshHash,
        input.grantId,
        familyId,
        input.parentId ?? null,
        input.ownerUserId,
        input.clientId,
        input.resource,
        JSON.stringify(input.scopes),
        refreshExpiresAt,
      ),
    db
      .prepare(
        `UPDATE oauth_grants SET last_used_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL`,
      )
      .bind(input.grantId),
  ]);
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: input.scopes.join(" "),
    resource: input.resource,
  };
}

async function fetchAndValidateClientMetadata(
  clientId: string,
  redirectUri: string,
) {
  let clientUrl: URL;
  try {
    clientUrl = new URL(clientId);
  } catch {
    throw new OAuthProtocolError(
      "invalid_client",
      "client_id must be an HTTPS Client ID Metadata Document URL",
    );
  }
  if (clientUrl.username || clientUrl.password || clientUrl.hash) {
    throw new OAuthProtocolError(
      "invalid_client",
      "client_id metadata URL is invalid",
    );
  }
  const localDevelopment =
    process.env.NODE_ENV === "development" &&
    clientUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(clientUrl.hostname);
  if (clientUrl.protocol !== "https:" && !localDevelopment) {
    throw new OAuthProtocolError(
      "invalid_client",
      "client_id metadata URL must use HTTPS",
    );
  }
  if (!allowedClientOrigins().has(clientUrl.origin) && !localDevelopment) {
    throw new OAuthProtocolError(
      "invalid_client",
      "This OAuth client origin is not allowed",
    );
  }
  const response = await fetch(clientUrl, {
    headers: { Accept: "application/json" },
    redirect: "error",
  }).catch(() => null);
  if (!response?.ok) {
    throw new OAuthProtocolError(
      "invalid_client",
      "Client metadata document could not be verified",
    );
  }
  const text = await response.text();
  if (text.length > 64 * 1024) {
    throw new OAuthProtocolError(
      "invalid_client",
      "Client metadata document is too large",
    );
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(text);
  } catch {
    throw new OAuthProtocolError(
      "invalid_client",
      "Client metadata document is not valid JSON",
    );
  }
  return validateClientMetadataDocument(clientId, redirectUri, metadata);
}

function allowedClientOrigins(): Set<string> {
  const configured = (
    env as unknown as { TASK_MANAGER_OAUTH_CLIENT_ORIGINS?: string }
  ).TASK_MANAGER_OAUTH_CLIENT_ORIGINS;
  return new Set(
    (configured || "https://chatgpt.com")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => new URL(entry).origin),
  );
}

async function cleanExpiredOAuthArtifacts() {
  const db = getD1();
  await db.batch([
    db.prepare(
      `DELETE FROM oauth_authorization_requests
       WHERE datetime(expires_at) <= datetime('now')`,
    ),
    db.prepare(
      `DELETE FROM oauth_authorization_codes
       WHERE datetime(expires_at) <= datetime('now', '-1 day')`,
    ),
    db.prepare(
      `DELETE FROM oauth_access_tokens
       WHERE datetime(expires_at) <= datetime('now', '-1 day')`,
    ),
    db.prepare(
      `DELETE FROM oauth_refresh_tokens
       WHERE datetime(expires_at) <= datetime('now', '-7 days')`,
    ),
  ]);
}

async function revokeGrantAndFamily(grantId: string, familyId: string) {
  const db = getD1();
  await db.batch([
    db
      .prepare(
        `UPDATE oauth_grants SET revoked_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .bind(grantId),
    db
      .prepare(
        `UPDATE oauth_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP
         WHERE family_id = ? AND revoked_at IS NULL`,
      )
      .bind(familyId),
    db
      .prepare(
        `UPDATE oauth_access_tokens SET revoked_at = CURRENT_TIMESTAMP
         WHERE grant_id = ? AND revoked_at IS NULL`,
      )
      .bind(grantId),
  ]);
}

function tokenResponse(value: Record<string, unknown>): Response {
  return Response.json(value, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
  });
}

function requireFormUrlEncoded(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    throw new OAuthProtocolError(
      "invalid_request",
      "Content-Type must be application/x-www-form-urlencoded",
    );
  }
}

function rejectClientSecret(form: FormData) {
  if (form.has("client_secret") || form.has("client_assertion")) {
    throw new OAuthProtocolError(
      "invalid_client",
      "This public PKCE client must not send a client secret",
      401,
    );
  }
}

function formString(form: FormData, name: string): string {
  const values = form.getAll(name);
  if (values.length !== 1 || typeof values[0] !== "string" || !values[0]) {
    throw new OAuthProtocolError(
      "invalid_request",
      `${name} is required exactly once`,
    );
  }
  return values[0];
}

function optionalFormString(form: FormData, name: string): string | null {
  const values = form.getAll(name);
  if (values.length > 1 || (values[0] !== undefined && typeof values[0] !== "string")) {
    throw new OAuthProtocolError(
      "invalid_request",
      `${name} must not be repeated`,
    );
  }
  return typeof values[0] === "string" && values[0] ? values[0] : null;
}

function mergeScopes(left: ApiScope[], right: ApiScope[]): ApiScope[] {
  const values = new Set<ApiScope>([...left, ...right]);
  return (["api:read", "api:write"] as const).filter((scope) => values.has(scope));
}

function unauthenticatedOAuthToken() {
  return new AgentApiError(
    "unauthenticated",
    "A valid OAuth bearer token is required",
    401,
  );
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}
