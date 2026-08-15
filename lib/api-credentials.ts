import { getD1 } from "@/db";
import {
  apiTokenFromAuthorization,
  createApiToken,
  hashApiToken,
  normalizeApiScopes,
  parseStoredApiScopes,
  type ApiScope,
} from "./api-credential-crypto";
import type { AgentAuthorizationContext } from "./agent-api-context";
import { AgentApiError } from "./agent-api-contract";
import { NotFoundError, ValidationError } from "./domain";
import type { UserRecord } from "./types";

type DbRow = Record<string, unknown>;

export type ApiCredentialSummary = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export async function issueApiCredential(
  currentUser: UserRecord,
  input: Record<string, unknown>,
): Promise<{ token: string; credential: ApiCredentialSummary }> {
  const name = credentialName(input.name);
  let scopes: ApiScope[];
  try {
    scopes = normalizeApiScopes(input.scopes);
  } catch (error) {
    throw new ValidationError(
      error instanceof Error ? error.message : "Invalid API scopes",
    );
  }
  const expiresAt = credentialExpiry(input.expiresInDays);
  const { token, prefix } = createApiToken();
  const tokenHash = await hashApiToken(token);
  const id = `api_credential_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();

  await getD1()
    .prepare(
      `INSERT INTO api_credentials
        (id, owner_user_id, name, token_prefix, token_hash, scopes_json,
         expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      currentUser.id,
      name,
      prefix,
      tokenHash,
      JSON.stringify(scopes),
      expiresAt,
      createdAt,
    )
    .run();

  return {
    token,
    credential: {
      id,
      name,
      prefix,
      scopes,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      createdAt,
    },
  };
}

export async function listApiCredentials(
  currentUser: UserRecord,
): Promise<ApiCredentialSummary[]> {
  const rows = await getD1()
    .prepare(
      `SELECT id, name, token_prefix, scopes_json, expires_at, last_used_at,
              revoked_at, created_at
       FROM api_credentials
       WHERE owner_user_id = ?
       ORDER BY created_at DESC`,
    )
    .bind(currentUser.id)
    .all<DbRow>();
  return rows.results.map(mapCredential);
}

export async function revokeApiCredential(
  currentUser: UserRecord,
  credentialId: string,
): Promise<void> {
  const result = await getD1()
    .prepare(
      `UPDATE api_credentials
       SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
       WHERE id = ? AND owner_user_id = ?`,
    )
    .bind(credentialId, currentUser.id)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new NotFoundError("API credential not found");
  }
}

export async function authenticateApiCredential(
  request: Request,
  requiredScope: ApiScope,
): Promise<AgentAuthorizationContext> {
  const token = apiTokenFromAuthorization(request.headers.get("authorization"));
  if (!token) {
    throw new AgentApiError(
      "unauthenticated",
      "A valid bearer API token is required",
      401,
    );
  }
  return authenticatePersonalApiToken(token, requiredScope);
}

export async function authenticatePersonalApiToken(
  token: string,
  requiredScope?: ApiScope,
): Promise<AgentAuthorizationContext> {
  if (!token.startsWith("tm_pat_")) {
    throw new AgentApiError(
      "unauthenticated",
      "A valid bearer API token is required",
      401,
    );
  }

  const tokenHash = await hashApiToken(token);
  const row = await getD1()
    .prepare(
      `SELECT c.id AS credential_id, c.scopes_json, c.expires_at,
              u.id, u.display_name, u.email, u.timezone
       FROM api_credentials c
       JOIN users u ON u.id = c.owner_user_id
       WHERE c.token_hash = ? AND c.revoked_at IS NULL
         AND datetime(c.expires_at) > datetime('now')
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<DbRow>();
  if (!row) {
    throw new AgentApiError(
      "unauthenticated",
      "A valid bearer API token is required",
      401,
    );
  }

  const scopes = parseStoredApiScopes(row.scopes_json);
  if (requiredScope && !scopes.includes(requiredScope)) {
    throw new AgentApiError(
      "insufficient_scope",
      `The API token requires ${requiredScope}`,
      403,
    );
  }

  await getD1()
    .prepare(
      `UPDATE api_credentials SET last_used_at = CURRENT_TIMESTAMP
       WHERE id = ? AND (
         last_used_at IS NULL OR datetime(last_used_at) < datetime('now', '-5 minutes')
       )`,
    )
    .bind(String(row.credential_id))
    .run();

  return {
    authorizationId: String(row.credential_id),
    authorizationType: "personal_token",
    clientId: "task-manager-personal-token",
    scopes,
    user: {
      id: String(row.id),
      displayName: String(row.display_name),
      email: String(row.email),
      timezone: String(row.timezone),
    },
    expiresAt: row.expires_at
      ? Math.floor(new Date(String(row.expires_at)).getTime() / 1000)
      : null,
    resource: null,
  };
}

function credentialName(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError("Credential name is required");
  }
  const name = value.trim();
  if (!name || name.length > 100) {
    throw new ValidationError(
      "Credential name must be between 1 and 100 characters",
    );
  }
  return name;
}

function credentialExpiry(value: unknown): string {
  const days = value === undefined ? 90 : Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new ValidationError("expiresInDays must be between 1 and 365");
  }
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function mapCredential(row: DbRow): ApiCredentialSummary {
  return {
    id: String(row.id),
    name: String(row.name),
    prefix: String(row.token_prefix),
    scopes: parseStoredApiScopes(row.scopes_json),
    expiresAt: String(row.expires_at),
    lastUsedAt: nullableString(row.last_used_at),
    revokedAt: nullableString(row.revoked_at),
    createdAt: String(row.created_at),
  };
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}
