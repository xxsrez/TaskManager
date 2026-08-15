import type { ApiScope } from "./api-credential-crypto";

export async function isToolsListMcpRequest(request: Request): Promise<boolean> {
  return (await mcpRequestMethod(request)) === "tools/list";
}

export async function isAnonymousMcpDiscoveryRequest(
  request: Request,
): Promise<boolean> {
  const method = await mcpRequestMethod(request);
  return Boolean(
    method &&
      [
        "initialize",
        "notifications/initialized",
        "ping",
        "tools/list",
      ].includes(method),
  );
}

export async function normalizeTaskManagerToolCallRequest(
  request: Request,
): Promise<Request> {
  if (request.method !== "POST") return request;
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return request;
  const value = await request.clone().json().catch(() => null);
  const messages = Array.isArray(value) ? value : [value];
  let changed = false;
  for (const entry of messages) {
    if (!isRecord(entry)) continue;
    const message = isRecord(entry.message) ? entry.message : entry;
    if (message.method !== "tools/call" || !isRecord(message.params)) {
      continue;
    }
    const name = message.params.name;
    if (typeof name !== "string" || !name.startsWith("task_manager.")) {
      continue;
    }
    const normalizedName = name.slice("task_manager.".length);
    if (!normalizedName) continue;
    message.params.name = normalizedName;
    changed = true;
  }
  if (!changed) return request;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(value),
    signal: request.signal,
  });
}

export async function decorateToolsListSecuritySchemes(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  let decorated = text;
  if (contentType.includes("application/json")) {
    decorated = decorateJsonText(text);
  } else if (contentType.includes("text/event-stream")) {
    decorated = text
      .split("\n")
      .map((line) => {
        if (!line.startsWith("data:")) return line;
        const prefix = line.startsWith("data: ") ? "data: " : "data:";
        return `${prefix}${decorateJsonText(line.slice(prefix.length))}`;
      })
      .join("\n");
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(decorated, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function decorateJsonText(text: string): string {
  try {
    const value = JSON.parse(text) as unknown;
    decorateJsonValue(value);
    return JSON.stringify(value);
  } catch {
    return text;
  }
}

async function mcpRequestMethod(request: Request): Promise<string | null> {
  if (request.method !== "POST") return null;
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  const value = await request.clone().json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.method === "string") return body.method;
  const message = body.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const method = (message as Record<string, unknown>).method;
  return typeof method === "string" ? method : null;
}

function decorateJsonValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const object = value as Record<string, unknown>;
  const result = object.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return;
  const tools = (result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return;
  for (const value of tools) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const tool = value as Record<string, unknown>;
    const scope: ApiScope =
      tool.name === "create_task" || tool.name === "update_task"
        ? "api:write"
        : "api:read";
    tool.securitySchemes = [{ type: "oauth2", scopes: [scope] }];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
