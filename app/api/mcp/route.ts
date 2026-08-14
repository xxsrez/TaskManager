import {
  createMcpHandler,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import {
  agentContextFromMcpAuthInfo,
  buildTaskManagerMcp,
} from "@/lib/task-manager-mcp";
import { oauthProtectedResourceMetadataUrl, oauthResource } from "@/lib/oauth-contract";
import { publicOrigin, verifyAgentTokenForMcp } from "@/lib/oauth";
import {
  decorateToolsListSecuritySchemes,
  isToolsListMcpRequest,
} from "@/lib/mcp-openai-auth";

export const dynamic = "force-dynamic";

const handler = createMcpHandler(
  ({ authInfo }) => {
    if (!authInfo) throw new Error("MCP request was not authenticated");
    return buildTaskManagerMcp(agentContextFromMcpAuthInfo(authInfo));
  },
  { legacy: "stateless", responseMode: "json" },
);

async function serve(request: Request) {
  const toolsListRequest = await isToolsListMcpRequest(request);
  const origin = publicOrigin(request);
  const resource = oauthResource(origin);
  const authenticate = requireBearerAuth({
    verifier: {
      verifyAccessToken: (token) => verifyAgentTokenForMcp(token, resource),
    },
    requiredScopes: ["api:read"],
    resourceMetadataUrl: oauthProtectedResourceMetadataUrl(origin),
  });
  const authInfo = await authenticate(request);
  if (authInfo instanceof Response) return authInfo;
  let response = await handler.fetch(request, { authInfo });
  if (toolsListRequest) {
    response = await decorateToolsListSecuritySchemes(response);
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const GET = serve;
export const POST = serve;
export const DELETE = serve;
