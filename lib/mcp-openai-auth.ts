import type { ApiScope } from "./api-credential-crypto";

export async function isToolsListMcpRequest(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return false;
  const value = await request.clone().json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.method === "tools/list") return true;
  const message = body.message;
  return Boolean(
    message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>).method === "tools/list",
  );
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
