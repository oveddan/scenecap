import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  CapturePreviewCleanupError,
  CapturePreviewError,
  previewCaptureTarget,
} from "./capture-preview.js";
import { decodeCaptureTargetRef, readCaptureTargets } from "./capture-targets.js";
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

  server.registerTool(
    "list_capture_targets",
    {
      title: "List OBS capture targets",
      description:
        "List configured OBS capture inputs and currently selectable macOS windows, with explicit limitations for target kinds this OBS build cannot enumerate safely. This performs no OBS mutations.",
      annotations: {
        readOnlyHint: true,
      },
    },
    async (extra) => {
      try {
        const discovery = await readCaptureTargets(await loadObs(), createSocket, { signal: extra.signal });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ server: SERVER_INFO, status: "ok", ...discovery }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                server: SERVER_INFO,
                status: "unavailable",
                reason: curatedCaptureTargetFailureReason(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "preview_capture_target",
    {
      title: "Preview one OBS capture target",
      description:
        "Explicitly capture a bounded still preview for one target reference returned by list_capture_targets. Existing configured sources are read without changing OBS. An unconfigured available window is rendered through a temporary isolated scene in OBS Studio Mode Preview, then its prior Preview and Studio Mode state are restored and the resources removed; Program is never changed. Preview images may contain sensitive on-screen content.",
      inputSchema: {
        targetRef: z.string().min(1).max(2_100),
      },
      annotations: {
        destructiveHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
    },
    async ({ targetRef }, extra) => {
      try {
        if (!decodeCaptureTargetRef(targetRef)) {
          throw new CapturePreviewError("invalid_reference", "The capture target reference is invalid.");
        }
        const preview = await previewCaptureTarget(
          await loadObs(),
          targetRef,
          createSocket,
          { signal: extra.signal },
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                previewMethod: preview.previewMethod,
                server: SERVER_INFO,
                status: "ok",
                target: preview.target,
                image: {
                  byteLength: preview.image.byteLength,
                  height: preview.image.height,
                  mimeType: preview.image.mimeType,
                  width: preview.image.width,
                },
              }),
            },
            {
              data: preview.image.data,
              mimeType: preview.image.mimeType,
              type: "image",
            },
          ],
        };
      } catch (error) {
        return previewFailureResult(error);
      }
    },
  );

  return server;
}

export function curatedCaptureTargetFailureReason(error: unknown): string {
  return curatedObsFailureReason(error, {
    cancelled: "OBS capture target discovery was cancelled.",
    timeout: "OBS capture target discovery timed out.",
    unknown: "OBS capture target discovery failed for an unknown reason.",
  });
}

export function curatedFailureReason(error: unknown): string {
  return curatedObsFailureReason(error, {
    cancelled: "OBS preflight was cancelled.",
    timeout: "OBS preflight timed out.",
    unknown: "OBS preflight failed for an unknown reason.",
  });
}

function previewFailureResult(error: unknown) {
  const cleanup = error instanceof CapturePreviewCleanupError ? {
    cleanup: {
      failures: error.failures,
      identifiers: error.identifiers,
      manualRecovery: "Remove only the listed temporary preview input and scene in OBS.",
    },
  } : {};
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ...cleanup,
          server: SERVER_INFO,
          status: "unavailable",
          reason: curatedPreviewFailureReason(error),
        }),
      },
    ],
    isError: true,
  };
}

export function curatedPreviewFailureReason(error: unknown): string {
  if (error instanceof CapturePreviewError) {
    switch (error.kind) {
      case "cleanup_failed":
        return "OBS preview cleanup was incomplete.";
      case "invalid_reference":
        return "The capture target reference is invalid.";
      case "preview_unavailable":
        return "The requested capture target cannot be previewed right now.";
      case "stale_reference":
        return "The capture target is no longer available; list targets again.";
    }
  }
  return curatedObsFailureReason(error, {
    cancelled: "OBS capture preview was cancelled.",
    timeout: "OBS capture preview timed out.",
    unknown: "OBS capture preview failed for an unknown reason.",
  });
}

function curatedObsFailureReason(
  error: unknown,
  messages: { cancelled: string; timeout: string; unknown: string },
): string {
  if (error instanceof ConfigError) return "OBS configuration is unavailable.";
  switch (classifyObsFailure(error)) {
    case "authentication_failed":
      return "OBS authentication failed.";
    case "cancelled":
      return messages.cancelled;
    case "incompatible_protocol":
      return "OBS WebSocket protocol is incompatible.";
    case "obs_unavailable":
      return "OBS is unavailable or refused the connection.";
    case "timeout":
      return messages.timeout;
    case "unknown":
      return messages.unknown;
  }
}
