import { agentApiOpenApi } from "@/lib/agent-api-openapi";

export async function GET() {
  const response = Response.json(agentApiOpenApi);
  response.headers.set("Cache-Control", "public, max-age=300");
  return response;
}
