import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ObsSocketFactory } from "./obs.js";
import { readObsStatus } from "./obs.js";
import type { SidecarConfig } from "./config.js";

export const SERVER_INFO = { name: "scenecap", version: "0.1.0" } as const;

export function createMcpServer(
  config: SidecarConfig,
  createSocket?: ObsSocketFactory,
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
        const status = await readObsStatus(config.obs, createSocket, extra.signal);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ server: SERVER_INFO, status: "ok", ...status }),
            },
          ],
        };
      } catch {
        // OBS errors may include implementation-specific details. Do not return
        // or log them: a password supplied by a third party must never escape.
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                server: SERVER_INFO,
                status: "unavailable",
                reason: "OBS preflight failed.",
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
