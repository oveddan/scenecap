import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  CaptureConfigurationAmbiguousCreationError,
  CaptureConfigurationError,
  CaptureConfigurationPartialError,
  configureCaptureTarget,
} from "./capture-config.js";
import {
  CapturePreviewCleanupError,
  CapturePreviewError,
  previewCaptureTarget,
} from "./capture-preview.js";
import { CaptureSessionStore } from "./capture-session.js";
import { decodeCaptureTargetRef, readCaptureTargets } from "./capture-targets.js";
import { ConfigError, loadObsConfig, type ObsConfig, type SidecarConfig } from "./config.js";
import { classifyObsFailure, readObsStatus, type ObsSocketFactory } from "./obs.js";

export const SERVER_INFO = { name: "scenecap", version: "0.1.0" } as const;

export function createMcpServer(
  config: SidecarConfig,
  createSocket?: ObsSocketFactory,
  loadObs: () => Promise<ObsConfig> = config.obs ? async () => config.obs as ObsConfig : loadObsConfig,
  sessionStore: CaptureSessionStore = new CaptureSessionStore(),
): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "get_session",
    {
      title: "Get configured capture session",
      description:
        "Read the sidecar-owned configured capture session and recovery summary. This does not connect to or mutate OBS.",
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ server: SERVER_INFO, session: sessionStore.read(), status: "ok" }),
        },
      ],
    }),
  );

  server.registerTool(
    "configure_capture_target",
    {
      title: "Persistently configure one OBS capture target",
      description:
        "Point one allowlisted OBS capture input at a current target returned by list_capture_targets, creating a named capture input only when requested. The source is added to the chosen existing scene, or the current Program scene by default. This persists in OBS and records non-secret recovery metadata in the shared sidecar session.",
      inputSchema: {
        targetRef: z.string().min(1).max(2_100),
        sourceRef: z.string().min(1).max(1_100).optional(),
        newSource: z.object({
          inputName: z.string().min(1).max(300),
          inputKind: z.enum(["screen_capture", "av_capture_input_v2", "macos-avcapture"]).optional(),
        }).strict().optional(),
        sceneName: z.string().min(1).max(300).optional(),
        encoderDimensions: z.object({
          width: z.number().int().min(1).max(16_384),
          height: z.number().int().min(1).max(16_384),
        }).strict().optional(),
      },
      annotations: {
        destructiveHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
    },
    async (request, extra) => {
      let partialSession: ReturnType<CaptureSessionStore["read"]> | undefined;
      let partialConfiguration: CaptureConfigurationPartialError["configuration"] | undefined;
      try {
        const result = await sessionStore.runExclusive(async () => {
          try {
            const configuration = await configureCaptureTarget(
              await loadObs(),
              request,
              createSocket,
              { signal: extra.signal },
            );
            const session = sessionStore.record(configuration.configuredSource, configuration.restoreSnapshot);
            return { configuration, session };
          } catch (error) {
            if (error instanceof CaptureConfigurationPartialError) {
              partialConfiguration = error.configuration;
              partialSession = sessionStore.record(error.configuration.configuredSource, error.configuration.restoreSnapshot);
            }
            if (error instanceof CaptureConfigurationAmbiguousCreationError) {
              partialSession = sessionStore.recordUnresolvedCreation(error.creation);
            }
            throw error;
          }
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                configuredSource: result.configuration.configuredSource,
                ...(result.configuration.encoderSafeDimensions
                  ? { encoderSafeDimensions: result.configuration.encoderSafeDimensions }
                  : {}),
                server: SERVER_INFO,
                session: result.session,
                status: "ok",
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...(partialConfiguration ? { configuredSource: partialConfiguration.configuredSource } : {}),
                ...(partialSession ? { session: partialSession } : {}),
                reason: curatedCaptureConfigurationFailureReason(error),
                server: SERVER_INFO,
                status: "unavailable",
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

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
        "Explicitly capture a bounded still preview for one target reference returned by list_capture_targets. Existing configured sources are read without changing OBS. A temporary window preview requires Studio Mode off and all OBS outputs inactive, then uses only Studio Mode Preview; scenecap never sends a Program mutation. Cleanup compares current state before restoring it and reports external conflicts for manual recovery. Preview images may contain sensitive on-screen content.",
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

export function curatedCaptureConfigurationFailureReason(error: unknown): string {
  if (error instanceof CaptureConfigurationAmbiguousCreationError) {
    return "OBS input creation may be partially applied; inspect get_session before retrying or removing the named input manually.";
  }
  if (error instanceof CaptureConfigurationPartialError) {
    return error.outcome === "scene_attachment_rejected"
      ? "OBS updated the capture target but rejected adding it to the scene; inspect get_session before retrying."
      : "OBS configuration may be partially applied; inspect get_session before retrying or restoring it manually.";
  }
  if (error instanceof CaptureConfigurationError) {
    switch (error.kind) {
      case "incompatible_source":
        return "The selected OBS source cannot capture that target.";
      case "invalid_reference":
        return "The capture target or source reference is invalid.";
      case "invalid_request":
        return "The capture configuration request is invalid.";
      case "source_unavailable":
        return "The requested OBS source or scene is no longer available; list targets again.";
      case "stale_reference":
        return "The capture target is no longer available; list targets again.";
    }
  }
  return curatedObsFailureReason(error, {
    cancelled: "OBS capture configuration was cancelled.",
    timeout: "OBS capture configuration timed out.",
    unknown: "OBS capture configuration failed for an unknown reason.",
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
      manualRecovery: cleanupGuidance(error.failures),
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

function cleanupGuidance(failures: CapturePreviewCleanupError["failures"]): string[] {
  const guidance: string[] = [];
  if (failures.includes("program_scene")) {
    guidance.push("The temporary scene is Program; do not remove it until an operator changes Program in OBS.");
  }
  if (failures.includes("preview_scene")) {
    guidance.push("Preview changed outside this tool; restore it manually only after confirming the current operator intent.");
  }
  if (failures.includes("studio_mode")) {
    guidance.push("Studio Mode state changed outside this tool; confirm it manually before altering it.");
  }
  if (failures.includes("scene_item")) {
    guidance.push("Disable the listed temporary scene item only after confirming it is still the scenecap preview item.");
  }
  if (failures.includes("input") || failures.includes("scene")) {
    guidance.push("Remove only the listed temporary preview input and scene after resolving any state conflicts.");
  }
  return guidance;
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
