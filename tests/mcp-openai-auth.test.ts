import assert from "node:assert/strict";
import test from "node:test";
import {
  decorateToolsListSecuritySchemes,
  isToolsListMcpRequest,
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
