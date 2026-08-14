export const API_SCOPES = ["api:read", "api:write"] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function normalizeApiScopes(value: unknown): ApiScope[] {
  const source = value === undefined ? ["api:read"] : value;
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error("At least one API scope is required");
  }
  const scopes = new Set<ApiScope>();
  for (const item of source) {
    if (item !== "api:read" && item !== "api:write") {
      throw new Error("Unknown API scope");
    }
    scopes.add(item);
  }
  if (scopes.has("api:write")) scopes.add("api:read");
  return API_SCOPES.filter((scope) => scopes.has(scope));
}

export function parseStoredApiScopes(value: unknown): ApiScope[] {
  if (typeof value !== "string") return [];
  try {
    return normalizeApiScopes(JSON.parse(value));
  } catch {
    return [];
  }
}

export function createApiToken(): { token: string; prefix: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = base64UrlEncode(bytes);
  return {
    token: `tm_pat_${secret}`,
    prefix: `tm_pat_${secret.slice(0, 8)}`,
  };
}

export async function hashApiToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

export function apiTokenFromAuthorization(value: string | null): string | null {
  if (!value) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(value);
  return match?.[1] ?? null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
