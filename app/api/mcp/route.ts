import {
  createMcpHandler,
  requireBearerAuth,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import {
  agentContextFromMcpAuthInfo,
  buildTaskManagerMcp,
} from "@/lib/task-manager-mcp";
import { oauthProtectedResourceMetadataUrl, oauthResource } from "@/lib/oauth-contract";
import { publicOrigin, verifyAgentTokenForMcp } from "@/lib/oauth";
import {
  decorateToolsListSecuritySchemes,
  isAnonymousMcpDiscoveryRequest,
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
  const discoveryRequest = await isAnonymousMcpDiscoveryRequest(request);
  const origin = publicOrigin(request);
  const resource = oauthResource(origin);
  let authInfo: AuthInfo;
  if (discoveryRequest) {
    authInfo = discoveryAuthInfo(resource);
  } else {
    const authenticate = requireBearerAuth({
      verifier: {
        verifyAccessToken: (token) => verifyAgentTokenForMcp(token, resource),
      },
      requiredScopes: ["api:read"],
      resourceMetadataUrl: oauthProtectedResourceMetadataUrl(origin),
    });
    const authenticated = await authenticate(request);
    if (authenticated instanceof Response) return authenticated;
    authInfo = authenticated;
  }
  let response = await handler.fetch(request, { authInfo });
  if (toolsListRequest) {
    response = await decorateToolsListSecuritySchemes(response);
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function discoveryAuthInfo(resource: string): AuthInfo {
  return {
    token: "mcp-discovery",
    clientId: "mcp-discovery",
    scopes: [],
    resource: new URL(resource),
    extra: {
      authorizationId: "mcp-discovery",
      authorizationType: "oauth",
      user: {
        id: "mcp-discovery",
        displayName: "MCP discovery",
        email: "mcp-discovery@invalid",
        timezone: "UTC",
      },
    },
  };
}

export const GET = serve;
export const POST = serve;
export const DELETE = serve;
