import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ConfigError, loadObsConfig, type ObsConfig, type SidecarConfig } from "./config.js";
import { classifyObsFailure, readObsStatus, type ObsSocketFactory } from "./obs.js";

export const SERVER_INFO = { name: "scenecap", version: "0.1.0" } as const;

export function createMcpServer(
  config: SidecarConfig,
  createSocket?: ObsSocketFactory,
  loadObs: () => Promise<ObsConfig> = config.obs ? async () => config.obs as ObsConfig : loadObsConfig,
): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "get_status",
    {
      title: "Get OBS status",
      description:
        "Read OBS version and supported input/filter kinds. This preflight performs no OBS mutations.",
      annotations: {
        readOnlyHint: true,
      },
    },
    async (extra) => {
      try {
        const status = await readObsStatus(await loadObs(), createSocket, { signal: extra.signal });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ server: SERVER_INFO, status: "ok", ...status }),
            },
          ],
        };
      } catch (error) {
        // OBS errors may include implementation-specific details. Do not return
        // or log them: a password supplied by a third party must never escape.
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                server: SERVER_INFO,
                status: "unavailable",
                reason: curatedFailureReason(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

export function curatedFailureReason(error: unknown): string {
  if (error instanceof ConfigError) return "OBS configuration is unavailable.";
  switch (classifyObsFailure(error)) {
    case "authentication_failed":
      return "OBS authentication failed.";
    case "cancelled":
      return "OBS preflight was cancelled.";
    case "incompatible_protocol":
      return "OBS WebSocket protocol is incompatible.";
    case "obs_unavailable":
      return "OBS is unavailable or refused the connection.";
    case "timeout":
      return "OBS preflight timed out.";
    case "unknown":
      return "OBS preflight failed for an unknown reason.";
  }
}
