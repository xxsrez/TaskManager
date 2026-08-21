const PRIVATE_UAT_ORIGIN =
  "https://task-manager-uat.example.invalid";
const PRODUCTION_ORIGIN = "https://task-manager.example.invalid";
const SITES_AUTHORIZATION_HEADER = "OAI-Sites-Authorization";
const MAX_AUTHORIZATION_URL_BYTES = 8 * 1024;
const OAUTH_BODY_BYTES = 64 * 1024;
const MCP_BODY_BYTES = 4 * 1024 * 1024;
const FILE_BODY_BYTES = 25 * 1024 * 1024;
const METADATA_RESPONSE_BYTES = 256 * 1024;
const MCP_RESPONSE_BYTES = 4 * 1024 * 1024;
const FILE_RESPONSE_BYTES = 1024 * 1024;

type ConnectorEdgeRoute = {
  methods: readonly string[];
  requestBytes: number;
  responseBytes: number;
  timeoutMs: number;
  rateLimitGroup: "metadata" | "oauth" | "mcp" | "file";
  allowQuery?: boolean;
  authorizeRedirect?: boolean;
  metadataKind?: "authorization-server" | "protected-resource";
};

const CONNECTOR_ROUTES = new Map<string, ConnectorEdgeRoute>([
  [
    "/.well-known/oauth-protected-resource",
    {
      methods: ["GET"],
      requestBytes: 0,
      responseBytes: METADATA_RESPONSE_BYTES,
      timeoutMs: 10_000,
      rateLimitGroup: "metadata",
      metadataKind: "protected-resource",
    },
  ],
  [
    "/.well-known/oauth-protected-resource/api/mcp",
    {
      methods: ["GET"],
      requestBytes: 0,
      responseBytes: METADATA_RESPONSE_BYTES,
      timeoutMs: 10_000,
      rateLimitGroup: "metadata",
      metadataKind: "protected-resource",
    },
  ],
  [
    "/.well-known/oauth-authorization-server",
    {
      methods: ["GET"],
      requestBytes: 0,
      responseBytes: METADATA_RESPONSE_BYTES,
      timeoutMs: 10_000,
      rateLimitGroup: "metadata",
      metadataKind: "authorization-server",
    },
  ],
  [
    "/oauth/register",
    {
      methods: ["POST"],
      requestBytes: OAUTH_BODY_BYTES,
      responseBytes: METADATA_RESPONSE_BYTES,
      timeoutMs: 10_000,
      rateLimitGroup: "oauth",
    },
  ],
  [
    "/oauth/token",
    {
      methods: ["POST"],
      requestBytes: OAUTH_BODY_BYTES,
      responseBytes: METADATA_RESPONSE_BYTES,
      timeoutMs: 10_000,
      rateLimitGroup: "oauth",
    },
  ],
  [
    "/oauth/revoke",
    {
      methods: ["POST"],
      requestBytes: OAUTH_BODY_BYTES,
      responseBytes: METADATA_RESPONSE_BYTES,
      timeoutMs: 10_000,
      rateLimitGroup: "oauth",
    },
  ],
  [
    "/oauth/authorize",
    {
      methods: ["GET"],
      requestBytes: 0,
      responseBytes: 0,
      timeoutMs: 0,
      rateLimitGroup: "oauth",
      allowQuery: true,
      authorizeRedirect: true,
    },
  ],
  [
    "/api/mcp",
    {
      methods: ["GET", "POST", "DELETE"],
      requestBytes: MCP_BODY_BYTES,
      responseBytes: MCP_RESPONSE_BYTES,
      timeoutMs: 30_000,
      rateLimitGroup: "mcp",
    },
  ],
  [
    "/api/agent/v1/files",
    {
      methods: ["POST"],
      requestBytes: FILE_BODY_BYTES,
      responseBytes: FILE_RESPONSE_BYTES,
      timeoutMs: 60_000,
      rateLimitGroup: "file",
    },
  ],
]);

const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "authorization",
  "content-type",
  "idempotency-key",
  "mcp-protocol-version",
  "mcp-session-id",
  "x-file-filename",
]);

const FORWARDED_RESPONSE_HEADERS = new Set([
  "allow",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "retry-after",
  "www-authenticate",
]);

type ConnectorEdgeConfiguration = {
  publicOrigin: string;
  upstreamOrigin: typeof PRIVATE_UAT_ORIGIN;
  sitesBypassToken: string;
  rateLimiter: RateLimit;
};

export type ConnectorEdgeEnvironment = {
  TASK_MANAGER_CONNECTOR_EDGE_UPSTREAM_ORIGIN?: string;
  TASK_MANAGER_CONNECTOR_EDGE_PUBLIC_ORIGIN?: string;
  TASK_MANAGER_CONNECTOR_EDGE_SITES_BYPASS_TOKEN?: string;
  TASK_MANAGER_CONNECTOR_EDGE_RATE_LIMITER?: RateLimit;
};

export type ConnectorEdgeDependencies = {
  fetch?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
};

export async function handleConnectorEdgeRequest(
  request: Request,
  environment: ConnectorEdgeEnvironment,
  dependencies: ConnectorEdgeDependencies = {},
): Promise<Response | null> {
  const configured = connectorEdgeConfiguration(environment);
  if (configured === null) return null;
  if (configured instanceof Response) return configured;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== configured.publicOrigin) {
    return connectorError(421, "connector_origin_mismatch");
  }
  if (requestUrl.username || requestUrl.password) {
    return connectorError(400, "invalid_connector_request");
  }

  const route = CONNECTOR_ROUTES.get(requestUrl.pathname);
  if (!route || !route.methods.includes(request.method)) {
    return connectorError(404, "connector_route_not_found");
  }
  if (!route.allowQuery && requestUrl.search) {
    return connectorError(404, "connector_route_not_found");
  }
  if (
    route.authorizeRedirect &&
    new TextEncoder().encode(requestUrl.href).byteLength >
      MAX_AUTHORIZATION_URL_BYTES
  ) {
    return connectorError(414, "connector_request_uri_too_long");
  }

  const rateLimitResponse = await applyRateLimit(
    request,
    configured.rateLimiter,
    route.rateLimitGroup,
  );
  if (rateLimitResponse) return rateLimitResponse;

  if (route.authorizeRedirect) {
    const authorizationUrl = new URL(
      `${requestUrl.pathname}${requestUrl.search}`,
      configured.upstreamOrigin,
    );
    return new Response(null, {
      status: 302,
      headers: connectorResponseHeaders({ Location: authorizationUrl.href }),
    });
  }

  let body: ArrayBuffer | null;
  try {
    body = await readBoundedBody(request, route.requestBytes);
  } catch (error) {
    if (error instanceof ConnectorBodyTooLargeError) {
      return connectorError(413, "connector_request_too_large");
    }
    return connectorError(400, "invalid_connector_request");
  }

  const upstreamUrl = new URL(requestUrl.pathname, configured.upstreamOrigin);
  const headers = allowlistedHeaders(request.headers, FORWARDED_REQUEST_HEADERS);
  headers.set(
    SITES_AUTHORIZATION_HEADER,
    `Bearer ${configured.sitesBypassToken}`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), route.timeoutMs);
  let upstreamResponse: Response;
  try {
    upstreamResponse = await (dependencies.fetch ?? globalThis.fetch)(
      upstreamUrl,
      {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      },
    );
  } catch {
    return connectorError(
      controller.signal.aborted ? 504 : 502,
      controller.signal.aborted
        ? "connector_upstream_timeout"
        : "connector_upstream_unavailable",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
    return connectorError(502, "connector_upstream_redirect_rejected");
  }
  if (upstreamResponse.status < 200) {
    return connectorError(502, "connector_upstream_response_invalid");
  }

  let responseBody: ArrayBuffer | null;
  try {
    responseBody = await readBoundedBody(
      upstreamResponse,
      route.responseBytes,
    );
  } catch {
    return connectorError(502, "connector_upstream_response_invalid");
  }
  if (bodyContainsSecret(responseBody, configured.sitesBypassToken)) {
    return connectorError(502, "connector_upstream_response_invalid");
  }

  if (
    route.metadataKind &&
    !validConnectorMetadata(
      responseBody,
      configured.publicOrigin,
      route.metadataKind,
    )
  ) {
    return connectorError(502, "connector_metadata_origin_mismatch");
  }

  const responseHeaders = allowlistedHeaders(
    upstreamResponse.headers,
    FORWARDED_RESPONSE_HEADERS,
  );
  if (headersContainSecret(responseHeaders, configured.sitesBypassToken)) {
    return connectorError(502, "connector_upstream_response_invalid");
  }
  const bodyAllowed =
    upstreamResponse.status !== 204 && upstreamResponse.status !== 205;
  return new Response(bodyAllowed ? responseBody : null, {
    status: upstreamResponse.status,
    headers: connectorResponseHeaders(responseHeaders),
  });
}

function connectorEdgeConfiguration(
  environment: ConnectorEdgeEnvironment,
): ConnectorEdgeConfiguration | Response | null {
  const rawUpstream = environment.TASK_MANAGER_CONNECTOR_EDGE_UPSTREAM_ORIGIN;
  const rawPublic = environment.TASK_MANAGER_CONNECTOR_EDGE_PUBLIC_ORIGIN;
  const rawToken =
    environment.TASK_MANAGER_CONNECTOR_EDGE_SITES_BYPASS_TOKEN;
  const rateLimiter = environment.TASK_MANAGER_CONNECTOR_EDGE_RATE_LIMITER;
  if (!rawUpstream && !rawPublic && !rawToken && !rateLimiter) return null;

  const upstreamOrigin = exactHttpsOrigin(rawUpstream);
  const publicOrigin = exactHttpsOrigin(rawPublic);
  const sitesBypassToken = validHeaderSecret(rawToken);
  if (
    upstreamOrigin !== PRIVATE_UAT_ORIGIN ||
    !publicOrigin ||
    publicOrigin === PRIVATE_UAT_ORIGIN ||
    publicOrigin === PRODUCTION_ORIGIN ||
    !sitesBypassToken ||
    !rateLimiter
  ) {
    return connectorError(503, "connector_edge_misconfigured");
  }
  return {
    publicOrigin,
    upstreamOrigin,
    sitesBypassToken,
    rateLimiter,
  };
}

function exactHttpsOrigin(value: string | undefined): string | null {
  if (!value || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function validHeaderSecret(value: string | undefined): string | null {
  if (
    !value ||
    value !== value.trim() ||
    value.length < 16 ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    return null;
  }
  return value;
}

async function applyRateLimit(
  request: Request,
  rateLimiter: RateLimit,
  group: ConnectorEdgeRoute["rateLimitGroup"],
): Promise<Response | null> {
  const clientAddress = request.headers.get("cf-connecting-ip")?.trim();
  const key = `${group}:${clientAddress?.slice(0, 128) || "unknown"}`;
  try {
    const outcome = await rateLimiter.limit({ key });
    if (!outcome.success) {
      return connectorError(429, "connector_rate_limited", {
        "Retry-After": "60",
      });
    }
    return null;
  } catch {
    return connectorError(503, "connector_rate_limiter_unavailable");
  }
}

function allowlistedHeaders(source: Headers, names: Set<string>): Headers {
  const result = new Headers();
  source.forEach((value, name) => {
    if (names.has(name.toLowerCase())) result.set(name, value);
  });
  return result;
}

function connectorResponseHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function bodyContainsSecret(
  body: ArrayBuffer | null,
  secret: string,
): boolean {
  if (!body) return false;
  const haystack = new Uint8Array(body);
  const needle = new TextEncoder().encode(secret);
  outer: for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function headersContainSecret(headers: Headers, secret: string): boolean {
  let contains = false;
  headers.forEach((value) => {
    if (value.includes(secret)) contains = true;
  });
  return contains;
}

function connectorError(
  status: number,
  code: string,
  extraHeaders?: HeadersInit,
): Response {
  const headers = connectorResponseHeaders(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return Response.json(
    { error: { code, message: "Connector request failed" } },
    { status, headers },
  );
}

class ConnectorBodyTooLargeError extends Error {}

async function readBoundedBody(
  message: Request | Response,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  const contentLength = message.headers.get("content-length");
  if (contentLength) {
    if (!/^\d+$/.test(contentLength)) throw new Error("invalid content length");
    if (Number(contentLength) > maxBytes) {
      throw new ConnectorBodyTooLargeError();
    }
  }
  if (!message.body) return null;

  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ConnectorBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

function validConnectorMetadata(
  body: ArrayBuffer | null,
  publicOrigin: string,
  kind: NonNullable<ConnectorEdgeRoute["metadataKind"]>,
): boolean {
  if (!body) return false;
  let metadata: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    metadata = parsed as Record<string, unknown>;
  } catch {
    return false;
  }

  if (kind === "protected-resource") {
    return (
      metadata.resource === `${publicOrigin}/api/mcp` &&
      Array.isArray(metadata.authorization_servers) &&
      metadata.authorization_servers.length === 1 &&
      metadata.authorization_servers[0] === publicOrigin
    );
  }

  return (
    metadata.issuer === publicOrigin &&
    metadata.authorization_endpoint === `${publicOrigin}/oauth/authorize` &&
    metadata.token_endpoint === `${publicOrigin}/oauth/token` &&
    metadata.registration_endpoint === `${publicOrigin}/oauth/register` &&
    metadata.revocation_endpoint === `${publicOrigin}/oauth/revoke`
  );
}

export const connectorEdgeTestContract = {
  privateUatOrigin: PRIVATE_UAT_ORIGIN,
  productionOrigin: PRODUCTION_ORIGIN,
  sitesAuthorizationHeader: SITES_AUTHORIZATION_HEADER,
  fileBodyBytes: FILE_BODY_BYTES,
};
