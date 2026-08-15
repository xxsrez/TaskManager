import assert from "node:assert/strict";
import test from "node:test";
import { POST as mcpPost } from "../app/api/mcp/route";
import {
  configureRuntimeEnvironment,
  resetRuntimeEnvironmentForTests,
} from "../lib/runtime-environment";
import {
  decorateToolsListSecuritySchemes,
  isAnonymousMcpDiscoveryRequest,
  isToolsListMcpRequest,
  normalizeTaskManagerToolCallRequest,
} from "../lib/mcp-openai-auth";

test("tools/list responses expose top-level OAuth security schemes", async () => {
  const response = await decorateToolsListSecuritySchemes(
    Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "list_tasks", inputSchema: { type: "object" } },
          { name: "create_task", inputSchema: { type: "object" } },
          { name: "update_task", inputSchema: { type: "object" } },
        ],
      },
    }),
  );
  const body = (await response.json()) as {
    result: { tools: Array<{ name: string; securitySchemes: unknown }> };
  };
  assert.deepEqual(body.result.tools[0]?.securitySchemes, [
    { type: "oauth2", scopes: ["api:read"] },
  ]);
  assert.deepEqual(body.result.tools[1]?.securitySchemes, [
    { type: "oauth2", scopes: ["api:write"] },
  ]);
  assert.deepEqual(body.result.tools[2]?.securitySchemes, [
    { type: "oauth2", scopes: ["api:write"] },
  ]);
});

test("legacy SSE tools/list responses keep framing while adding auth policy", async () => {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    result: { tools: [{ name: "get_task", inputSchema: { type: "object" } }] },
  });
  const response = await decorateToolsListSecuritySchemes(
    new Response(`event: message\ndata: ${payload}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    }),
  );
  const text = await response.text();
  assert.match(text, /^event: message\ndata: /);
  const json = JSON.parse(text.split("\n")[1]!.slice("data: ".length)) as {
    result: { tools: Array<{ securitySchemes: unknown }> };
  };
  assert.deepEqual(json.result.tools[0]?.securitySchemes, [
    { type: "oauth2", scopes: ["api:read"] },
  ]);
});

test("tools/list detection accepts legacy and modern request envelopes", async () => {
  const headers = { "Content-Type": "application/json" };
  assert.equal(
    await isToolsListMcpRequest(
      new Request("https://tasks.example/api/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    ),
    true,
  );
  assert.equal(
    await isToolsListMcpRequest(
      new Request("https://tasks.example/api/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        }),
      }),
    ),
    true,
  );
});

test("anonymous MCP discovery is limited to handshake and tool schemas", async () => {
  const headers = { "Content-Type": "application/json" };
  for (const method of [
    "initialize",
    "notifications/initialized",
    "ping",
    "tools/list",
  ]) {
    assert.equal(
      await isAnonymousMcpDiscoveryRequest(
        new Request("https://tasks.example/api/mcp", {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
        }),
      ),
      true,
      method,
    );
  }

  for (const method of ["tools/call", "resources/list", "prompts/list"]) {
    assert.equal(
      await isAnonymousMcpDiscoveryRequest(
        new Request("https://tasks.example/api/mcp", {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
        }),
      ),
      false,
      method,
    );
  }
});

test("Codex namespaced Task Manager tool calls dispatch to the MCP tool name", async () => {
  const request = new Request("https://tasks.example/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "task_manager.get_workspace", arguments: {} },
    }),
  });

  const normalized = await normalizeTaskManagerToolCallRequest(request);
  const body = (await normalized.json()) as {
    params: { name: string };
  };
  assert.equal(body.params.name, "get_workspace");
});

test("MCP route exposes tool schemas but keeps tool calls behind bearer auth", async (t) => {
  configureRuntimeEnvironment({
    TASK_MANAGER_PUBLIC_ORIGIN: "https://tasks.example",
  });
  t.after(resetRuntimeEnvironmentForTests);
  const endpoint = "https://tasks.example/api/mcp";
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const listResponse = await mcpPost(
    new Request(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  assert.equal(listResponse.status, 200);
  const listText = await listResponse.text();
  const listPayload = listText.startsWith("event:")
    ? listText
        .split("\n")
        .find((line) => line.startsWith("data:"))!
        .slice("data:".length)
        .trim()
    : listText;
  const listBody = JSON.parse(listPayload) as {
    result: { tools: Array<{ name: string }> };
  };
  assert.ok(listBody.result.tools.some((tool) => tool.name === "list_tasks"));

  const callResponse = await mcpPost(
    new Request(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_tasks", arguments: {} },
      }),
    }),
  );
  assert.equal(callResponse.status, 401);
  assert.match(
    callResponse.headers.get("www-authenticate") ?? "",
    /resource_metadata=/,
  );
});
