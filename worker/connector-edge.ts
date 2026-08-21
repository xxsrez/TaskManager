import { handleConnectorEdgeRequest } from "../lib/connector-edge";
import type { ConnectorEdgeEnvironment } from "../lib/connector-edge";

const worker = {
  async fetch(
    request: Request,
    environment: ConnectorEdgeEnvironment,
  ): Promise<Response> {
    const response = await handleConnectorEdgeRequest(request, environment);
    if (response) return response;
    return Response.json(
      {
        error: {
          code: "connector_edge_misconfigured",
          message: "Connector request failed",
        },
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Type": "application/json; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  },
};

export default worker;
