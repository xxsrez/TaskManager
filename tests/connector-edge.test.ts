import assert from "node:assert/strict";
import test from "node:test";
import {
  connectorEdgeTestContract,
  handleConnectorEdgeRequest,
  type ConnectorEdgeEnvironment,
  type ConnectorEdgeDependencies,
} from "../lib/connector-edge";
import connectorEdgeWorker from "../worker/connector-edge";

const publicOrigin = "https://task-manager-connector.example";
const sitesBypassToken = "sites-bypass-test-secret";

function rateLimiter(
  success = true,
  keys: string[] = [],
): RateLimit {
  return {
    async limit({ key }) {
      keys.push(key);
      return { success };
    },
  };
}

function edgeEnvironment(
  overrides: Partial<ConnectorEdgeEnvironment> = {},
): ConnectorEdgeEnvironment {
  return {
    TASK_MANAGER_CONNECTOR_EDGE_UPSTREAM_ORIGIN:
      connectorEdgeTestContract.privateUatOrigin,
    TASK_MANAGER_CONNECTOR_EDGE_PUBLIC_ORIGIN: publicOrigin,
    TASK_MANAGER_CONNECTOR_EDGE_SITES_BYPASS_TOKEN: sitesBypassToken,
    TASK_MANAGER_CONNECTOR_EDGE_RATE_LIMITER: rateLimiter(),
    ...overrides,
  };
}

function fetchDependency(
  implementation: NonNullable<ConnectorEdgeDependencies["fetch"]>,
): ConnectorEdgeDependencies {
  return { fetch: implementation };
}

test("ordinary application runtime leaves connector edge disabled", async () => {
  let fetchCalls = 0;
  const response = await handleConnectorEdgeRequest(
    new Request("https://task-manager-uat.example/workspace"),
    {},
    fetchDependency(async () => {
      fetchCalls += 1;
      return new Response();
    }),
  );
  assert.equal(response, null);
  assert.equal(fetchCalls, 0);
});

test("standalone connector deployment fails closed without its full hosted configuration", async () => {
  const response = await connectorEdgeWorker.fetch(
    new Request(`${publicOrigin}/api/mcp`),
    {},
  );
  assert.equal(response.status, 503);
  assert.equal(
    (await response.json() as { error: { code: string } }).error.code,
    "connector_edge_misconfigured",
  );
});

test("partial or unsafe connector configuration fails closed without disclosure", async () => {
  const configurations: ConnectorEdgeEnvironment[] = [
    { TASK_MANAGER_CONNECTOR_EDGE_PUBLIC_ORIGIN: publicOrigin },
    edgeEnvironment({
      TASK_MANAGER_CONNECTOR_EDGE_UPSTREAM_ORIGIN:
        connectorEdgeTestContract.productionOrigin,
    }),
    edgeEnvironment({
      TASK_MANAGER_CONNECTOR_EDGE_UPSTREAM_ORIGIN: "https://foreign.example",
    }),
    edgeEnvironment({
      TASK_MANAGER_CONNECTOR_EDGE_PUBLIC_ORIGIN:
        connectorEdgeTestContract.privateUatOrigin,
    }),
    edgeEnvironment({
      TASK_MANAGER_CONNECTOR_EDGE_SITES_BYPASS_TOKEN: "short",
    }),
    edgeEnvironment({ TASK_MANAGER_CONNECTOR_EDGE_RATE_LIMITER: undefined }),
  ];

  for (const environment of configurations) {
    const response = await handleConnectorEdgeRequest(
      new Request(`${publicOrigin}/api/mcp`),
      environment,
    );
    assert.equal(response?.status, 503);
    const body = await response?.text();
    assert.doesNotMatch(body ?? "", /sites-bypass-test-secret|foreign\.example/);
  }
});

test("connector surface rejects UI, query variants, wrong methods and host aliases", async () => {
  const environment = edgeEnvironment();
  for (const url of [
    `${publicOrigin}/`,
    `${publicOrigin}/workspace`,
    `${publicOrigin}/_vinext/image`,
    `${publicOrigin}/api/mcp?target=other`,
    `${publicOrigin}/oauth/token?debug=1`,
  ]) {
    const response = await handleConnectorEdgeRequest(
      new Request(url),
      environment,
    );
    assert.equal(response?.status, 404, url);
  }

  const wrongMethod = await handleConnectorEdgeRequest(
    new Request(`${publicOrigin}/oauth/token`),
    environment,
  );
  assert.equal(wrongMethod?.status, 404);

  const wrongOrigin = await handleConnectorEdgeRequest(
    new Request("https://connector-alias.example/api/mcp"),
    environment,
  );
  assert.equal(wrongOrigin?.status, 421);
});

test("authorization entry redirects browser to private UAT without proxying HTML", async () => {
  let fetchCalls = 0;
  const keys: string[] = [];
  const environment = edgeEnvironment({
    TASK_MANAGER_CONNECTOR_EDGE_RATE_LIMITER: rateLimiter(true, keys),
  });
  const query = new URLSearchParams({
    client_id: "client-test",
    resource: `${publicOrigin}/api/mcp`,
    state: "state-test",
  });
  const response = await handleConnectorEdgeRequest(
    new Request(`${publicOrigin}/oauth/authorize?${query}`),
    environment,
    fetchDependency(async () => {
      fetchCalls += 1;
      return new Response();
    }),
  );

  assert.equal(response?.status, 302);
  assert.equal(
    response?.headers.get("location"),
    `${connectorEdgeTestContract.privateUatOrigin}/oauth/authorize?${query}`,
  );
  assert.equal(response?.headers.get("cache-control"), "private, no-store");
  assert.equal(fetchCalls, 0);
  assert.deepEqual(keys, ["oauth:unknown"]);
});

test("protected-resource discovery is bounded, origin-consistent and header-safe", async () => {
  const upstreamRequests: Request[] = [];
  const keys: string[] = [];
  const environment = edgeEnvironment({
    TASK_MANAGER_CONNECTOR_EDGE_RATE_LIMITER: rateLimiter(true, keys),
  });
  const metadata = {
    resource: `${publicOrigin}/api/mcp`,
    authorization_servers: [publicOrigin],
  };
  const response = await handleConnectorEdgeRequest(
    new Request(
      `${publicOrigin}/.well-known/oauth-protected-resource/api/mcp`,
      {
        headers: {
          Accept: "application/json",
          Cookie: "must-not-cross=edge-cookie",
          "CF-Connecting-IP": "203.0.113.9",
          "OAI-Sites-Authorization": "Bearer attacker-value",
        },
      },
    ),
    environment,
    fetchDependency(async (input, init) => {
      upstreamRequests.push(new Request(input, init));
      return Response.json(metadata, {
        headers: {
          "Set-Cookie": "private=must-not-cross",
          "X-Upstream-Debug": sitesBypassToken,
        },
      });
    }),
  );

  const upstreamRequest = upstreamRequests.at(0);
  assert.ok(upstreamRequest);
  assert.equal(response?.status, 200);
  assert.equal(
    upstreamRequest.url,
    `${connectorEdgeTestContract.privateUatOrigin}/.well-known/oauth-protected-resource/api/mcp`,
  );
  assert.equal(upstreamRequest.headers.get("accept"), "application/json");
  assert.equal(upstreamRequest.headers.get("cookie"), null);
  assert.equal(
    upstreamRequest.headers.get(
      connectorEdgeTestContract.sitesAuthorizationHeader,
    ),
    `Bearer ${sitesBypassToken}`,
  );
  assert.equal(response?.headers.get("set-cookie"), null);
  assert.equal(response?.headers.get("x-upstream-debug"), null);
  assert.doesNotMatch(await response!.text(), /sites-bypass-test-secret/);
  assert.deepEqual(keys, ["metadata:203.0.113.9"]);
});

test("discovery fails closed when private UAT does not publish the edge origin", async () => {
  const response = await handleConnectorEdgeRequest(
    new Request(`${publicOrigin}/.well-known/oauth-authorization-server`),
    edgeEnvironment(),
    fetchDependency(async () =>
      Response.json({
        issuer: connectorEdgeTestContract.privateUatOrigin,
        authorization_endpoint: `${connectorEdgeTestContract.privateUatOrigin}/oauth/authorize`,
        token_endpoint: `${connectorEdgeTestContract.privateUatOrigin}/oauth/token`,
        registration_endpoint: `${connectorEdgeTestContract.privateUatOrigin}/oauth/register`,
        revocation_endpoint: `${connectorEdgeTestContract.privateUatOrigin}/oauth/revoke`,
      }),
    ),
  );
  assert.equal(response?.status, 502);
  assert.equal(
    (await response?.json() as { error: { code: string } }).error.code,
    "connector_metadata_origin_mismatch",
  );
});

test("MCP forwarding preserves only protocol headers and rejects upstream redirects", async () => {
  const upstreamRequests: Request[] = [];
  const environment = edgeEnvironment();
  const response = await handleConnectorEdgeRequest(
    new Request(`${publicOrigin}/api/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tm_oat_test",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
        "Mcp-Session-Id": "session-test",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    environment,
    fetchDependency(async (input, init) => {
      upstreamRequests.push(new Request(input, init));
      return new Response(null, {
        status: 307,
        headers: { Location: "https://private.example/leak" },
      });
    }),
  );

  const upstreamRequest = upstreamRequests.at(0);
  assert.ok(upstreamRequest);
  assert.equal(upstreamRequest.headers.get("authorization"), "Bearer tm_oat_test");
  assert.equal(upstreamRequest.headers.get("origin"), null);
  assert.equal(upstreamRequest.headers.get("mcp-session-id"), "session-test");
  assert.equal(response?.status, 502);
  assert.equal(response?.headers.get("location"), null);
  assert.doesNotMatch(await response!.text(), /private\.example|sites-bypass/);
});

test("upstream cannot reflect the hosted Sites credential", async () => {
  const response = await handleConnectorEdgeRequest(
    new Request(`${publicOrigin}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
    edgeEnvironment(),
    fetchDependency(async () =>
      Response.json({ reflected: sitesBypassToken }),
    ),
  );
  assert.equal(response?.status, 502);
  assert.doesNotMatch(await response!.text(), /sites-bypass-test-secret/);
});

test("staged file ingress forwards exact bytes and only the upload contract", async () => {
  const sourceBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  const upstreamRequests: Request[] = [];
  const response = await handleConnectorEdgeRequest(
    new Request(`${publicOrigin}/api/agent/v1/files`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tm_oat_upload",
        "Content-Type": "application/pdf",
        "Idempotency-Key": "upload-test-key",
        "X-File-Filename": "evidence.pdf",
        Cookie: "must-not-cross=edge-cookie",
      },
      body: sourceBytes,
    }),
    edgeEnvironment(),
    fetchDependency(async (input, init) => {
      upstreamRequests.push(new Request(input, init));
      return Response.json(
        { data: { fileRef: "file_test", byteSize: sourceBytes.byteLength } },
        { status: 201 },
      );
    }),
  );

  const upstreamRequest = upstreamRequests.at(0);
  assert.ok(upstreamRequest);
  assert.equal(
    upstreamRequest.url,
    `${connectorEdgeTestContract.privateUatOrigin}/api/agent/v1/files`,
  );
  assert.equal(upstreamRequest.headers.get("authorization"), "Bearer tm_oat_upload");
  assert.equal(upstreamRequest.headers.get("idempotency-key"), "upload-test-key");
  assert.equal(upstreamRequest.headers.get("x-file-filename"), "evidence.pdf");
  assert.equal(upstreamRequest.headers.get("cookie"), null);
  assert.deepEqual(
    new Uint8Array(await upstreamRequest.arrayBuffer()),
    sourceBytes,
  );
  assert.equal(response?.status, 201);
  assert.deepEqual(await response?.json(), {
    data: { fileRef: "file_test", byteSize: sourceBytes.byteLength },
  });
});

test("oversized upload and unavailable rate limiter fail before upstream fetch", async () => {
  let fetchCalls = 0;
  const dependencies = fetchDependency(async () => {
    fetchCalls += 1;
    return new Response();
  });
  const oversized = await handleConnectorEdgeRequest(
    new Request(`${publicOrigin}/api/agent/v1/files`, {
      method: "POST",
      headers: {
        "Content-Length": String(connectorEdgeTestContract.fileBodyBytes + 1),
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array([1]),
    }),
    edgeEnvironment(),
    dependencies,
  );
  assert.equal(oversized?.status, 413);

  const unavailable = await handleConnectorEdgeRequest(
    new Request(`${publicOrigin}/api/mcp`, { method: "POST", body: "{}" }),
    edgeEnvironment({
      TASK_MANAGER_CONNECTOR_EDGE_RATE_LIMITER: {
        async limit() {
          throw new Error("binding unavailable");
        },
      },
    }),
    dependencies,
  );
  assert.equal(unavailable?.status, 503);

  const limited = await handleConnectorEdgeRequest(
    new Request(`${publicOrigin}/api/mcp`, { method: "POST", body: "{}" }),
    edgeEnvironment({
      TASK_MANAGER_CONNECTOR_EDGE_RATE_LIMITER: rateLimiter(false),
    }),
    dependencies,
  );
  assert.equal(limited?.status, 429);
  assert.equal(limited?.headers.get("retry-after"), "60");
  assert.equal(fetchCalls, 0);
});

test("oversized upstream response is not exposed to the connector client", async () => {
  const response = await handleConnectorEdgeRequest(
    new Request(`${publicOrigin}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
    edgeEnvironment(),
    fetchDependency(async () =>
      new Response("small", {
        headers: {
          "Content-Length": String(4 * 1024 * 1024 + 1),
          "Content-Type": "application/json",
        },
      }),
    ),
  );
  assert.equal(response?.status, 502);
  assert.equal(
    (await response?.json() as { error: { code: string } }).error.code,
    "connector_upstream_response_invalid",
  );
});
