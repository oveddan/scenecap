import { randomUUID } from "node:crypto";

import type { ObsConfig } from "./config.js";
import {
  decodeCaptureTargetRef,
  decodeInputRef,
  readCaptureTargets,
  type CaptureTarget,
} from "./capture-targets.js";
import {
  boundedObsRead,
  createObsSocket,
  isAbortSignal,
  normalizeObsReadOptions,
  ObsStatusError,
  type ObsReadOptions,
  type ObsSocket,
  type ObsSocketFactory,
} from "./obs.js";

export const DEFAULT_CAPTURE_PREVIEW_TIMEOUT_MS = 20_000;
export const CAPTURE_PREVIEW_CLEANUP_TIMEOUT_MS = 5_000;
export const CAPTURE_PREVIEW_IMAGE_WIDTH = 960;
export const CAPTURE_PREVIEW_IMAGE_HEIGHT = 540;
export const MAX_CAPTURE_PREVIEW_IMAGE_BYTES = 2 * 1024 * 1024;
export const CAPTURE_PREVIEW_RENDER_WAIT_MS = 850;
export const CAPTURE_PREVIEW_DISCONNECT_WAIT_MS = 400;
const MAX_CAPTURE_PREVIEW_BASE64_CHARS = Math.ceil(MAX_CAPTURE_PREVIEW_IMAGE_BYTES / 3) * 4;

export interface CapturePreview {
  image: {
    byteLength: number;
    data: string;
    height: number;
    mimeType: "image/jpeg";
    width: number;
  };
  previewMethod: "configured_source" | "temporary_window_probe";
  target: Pick<CaptureTarget, "availability" | "kind" | "label" | "targetRef" | "validity">;
}

export type CapturePreviewErrorKind =
  | "cleanup_failed"
  | "invalid_reference"
  | "preview_unavailable"
  | "stale_reference";

export class CapturePreviewError extends Error {
  constructor(readonly kind: CapturePreviewErrorKind, message: string) {
    super(message);
    this.name = "CapturePreviewError";
  }
}

export interface PreviewCleanupIdentifiers {
  inputName: string;
  previousPreviewSceneUuid?: string;
  previousStudioModeEnabled?: boolean;
  sceneName: string;
}

export class CapturePreviewCleanupError extends CapturePreviewError {
  constructor(
    readonly identifiers: PreviewCleanupIdentifiers,
    readonly failures: Array<"input" | "scene" | "scene_item" | "preview_scene" | "studio_mode" | "program_scene">,
  ) {
    super("cleanup_failed", "Temporary preview resources could not be fully removed.");
    this.name = "CapturePreviewCleanupError";
  }
}

interface TemporaryProbe {
  inputMayExist: boolean;
  inputName: string;
  inputUuid?: string;
  programSceneUuid?: string;
  previewSceneMayHaveChanged: boolean;
  previousPreviewSceneUuid?: string;
  sceneMayExist: boolean;
  sceneItemId?: number;
  sceneItemMayHaveBeenEnabled: boolean;
  sceneName: string;
  sceneUuid?: string;
  studioModeMayHaveChanged: boolean;
  studioModeWasEnabled?: boolean;
}

let temporaryPreviewTail: Promise<void> = Promise.resolve();

/**
 * Preview is intentionally single-target and explicit. A syntactically valid
 * reference is not enough: it is rediscovered and must exactly match a target
 * that the current OBS session exposes before we screenshot or create a probe.
 */
export async function previewCaptureTarget(
  config: ObsConfig,
  targetRef: string,
  createSocket: ObsSocketFactory = createObsSocket,
  optionsOrSignal: ObsReadOptions | AbortSignal = {},
): Promise<CapturePreview> {
  const timeoutMs = isAbortSignal(optionsOrSignal)
    ? DEFAULT_CAPTURE_PREVIEW_TIMEOUT_MS
    : optionsOrSignal.timeoutMs ?? DEFAULT_CAPTURE_PREVIEW_TIMEOUT_MS;
  const options = normalizeObsReadOptions(
    isAbortSignal(optionsOrSignal)
      ? { signal: optionsOrSignal, timeoutMs }
      : { ...optionsOrSignal, timeoutMs },
  );
  if (!decodeCaptureTargetRef(targetRef)) {
    throw new CapturePreviewError("invalid_reference", "The capture target reference is invalid.");
  }
  const deadline = Date.now() + options.timeoutMs;
  const discovery = await readCaptureTargets(config, createSocket, {
    signal: options.signal,
    timeoutMs: remainingTimeout(deadline),
  });
  const target = discovery.targets.find((candidate) => candidate.targetRef === targetRef);
  if (!target) {
    throw new CapturePreviewError("stale_reference", "The capture target is no longer available in OBS.");
  }
  const configuredSource = discovery.sources.find((source) => source.configuredTargetRef === targetRef);
  if (configuredSource) {
    const inputUuid = decodeInputRef(configuredSource.sourceRef);
    if (!inputUuid) {
      throw new CapturePreviewError("preview_unavailable", "The configured OBS source could not be resolved.");
    }
    return screenshotConfiguredSource(config, target, inputUuid, createSocket, options, deadline);
  }
  if (target.kind !== "window" || target.availability !== "available") {
    throw new CapturePreviewError(
      "preview_unavailable",
      "This capture target requires an existing configured OBS source before it can be previewed.",
    );
  }
  const decoded = decodeCaptureTargetRef(targetRef);
  // The earlier decoder and the discovered target's kind make this exhaustive.
  if (!decoded || decoded.kind !== "window" || typeof decoded.value !== "number") {
    throw new CapturePreviewError("invalid_reference", "The capture target reference is invalid.");
  }
  const windowId = decoded.value;
  return withTemporaryPreviewLock(options, deadline, () =>
    screenshotTemporaryWindowProbe(config, target, windowId, createSocket, options, deadline),
  );
}

async function screenshotConfiguredSource(
  config: ObsConfig,
  target: CaptureTarget,
  inputUuid: string,
  createSocket: ObsSocketFactory,
  options: Required<ObsReadOptions>,
  deadline: number,
): Promise<CapturePreview> {
  const socket = createSocket();
  try {
    await connect(socket, config, options, deadline);
    const image = await requestScreenshot(socket, inputUuid, options, deadline);
    return toPreview(target, image, "configured_source");
  } finally {
    await disconnectQuietly(socket);
  }
}

async function screenshotTemporaryWindowProbe(
  config: ObsConfig,
  target: CaptureTarget,
  windowId: number,
  createSocket: ObsSocketFactory,
  options: Required<ObsReadOptions>,
  deadline: number,
): Promise<CapturePreview> {
  const suffix = randomUUID();
  const probe: TemporaryProbe = {
    inputMayExist: false,
    inputName: `__scenecap_preview_input_${suffix}`,
    previewSceneMayHaveChanged: false,
    sceneMayExist: false,
    sceneItemMayHaveBeenEnabled: false,
    sceneName: `__scenecap_preview_scene_${suffix}`,
    studioModeMayHaveChanged: false,
  };
  const socket = createSocket();
  let primaryError: unknown;
  let image: CapturePreview["image"] | undefined;
  try {
    await connect(socket, config, options, deadline);
    await assertTemporaryPreviewSafe(socket, probe, options, deadline);
    // Set this before the request: cancellation/timeouts can arrive after OBS
    // creates the resource but before its response reaches us.
    probe.sceneMayExist = true;
    const createdScene = await boundedObsRead(
      socket,
      () => socket.request({ data: { sceneName: probe.sceneName }, type: "CreateScene" }),
      options,
      deadline,
    );
    const sceneUuid = objectString(createdScene, "sceneUuid");
    if (!sceneUuid) {
      throw new CapturePreviewError("preview_unavailable", "OBS did not return a temporary preview scene.");
    }
    probe.sceneUuid = sceneUuid;
    probe.inputMayExist = true;
    const created = await boundedObsRead(
      socket,
      () => socket.request({
        data: {
          inputKind: "screen_capture",
          inputName: probe.inputName,
          inputSettings: { show_cursor: false, type: 1, window: windowId },
          sceneItemEnabled: false,
          sceneName: probe.sceneName,
        },
        type: "CreateInput",
      }),
      options,
      deadline,
    );
    const inputUuid = objectString(created, "inputUuid");
    if (!inputUuid) {
      throw new CapturePreviewError("preview_unavailable", "OBS did not return a temporary preview source.");
    }
    probe.inputUuid = inputUuid;
    const sceneItemId = objectInteger(created, "sceneItemId");
    if (sceneItemId === undefined) {
      throw new CapturePreviewError("preview_unavailable", "OBS did not return a temporary preview scene item.");
    }
    probe.sceneItemId = sceneItemId;
    // Recheck immediately before touching Studio Mode: discovery and resource
    // creation may have taken long enough for an operator to start output.
    await assertTemporaryPreviewSafe(socket, probe, options, deadline);
    probe.studioModeMayHaveChanged = true;
    await boundedObsRead(
      socket,
      () => socket.request({ data: { studioModeEnabled: true }, type: "SetStudioModeEnabled" }),
      options,
      deadline,
    );
    const previousPreview = await boundedObsRead(
      socket,
      () => socket.request({ type: "GetCurrentPreviewScene" }),
      options,
      deadline,
    );
    const previousPreviewSceneUuid = objectString(previousPreview, "currentPreviewSceneUuid");
    if (!previousPreviewSceneUuid) {
      throw new CapturePreviewError("preview_unavailable", "OBS did not report the current Preview scene.");
    }
    probe.previousPreviewSceneUuid = previousPreviewSceneUuid;
    probe.previewSceneMayHaveChanged = true;
    await boundedObsRead(
      socket,
      () => socket.request({ data: { sceneUuid }, type: "SetCurrentPreviewScene" }),
      options,
      deadline,
    );
    probe.sceneItemMayHaveBeenEnabled = true;
    await boundedObsRead(
      socket,
      () => socket.request({
        data: { sceneItemEnabled: true, sceneItemId, sceneName: probe.sceneName },
        type: "SetSceneItemEnabled",
      }),
      options,
      deadline,
    );
    await boundedRenderWait(options.signal, deadline);
    image = await requestScreenshot(socket, inputUuid, options, deadline);
  } catch (error) {
    primaryError = error;
  } finally {
    // Wait for the primary connection to close before a fresh connection
    // checks whether an ambiguously timed-out mutation took effect.
    await disconnectQuietly(socket, CAPTURE_PREVIEW_DISCONNECT_WAIT_MS);
  }

  const cleanupError = await cleanupTemporaryProbe(config, probe, createSocket);
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  if (!image) {
    throw new CapturePreviewError("preview_unavailable", "OBS did not return a preview image.");
  }
  return toPreview(target, image, "temporary_window_probe");
}

/**
 * Cleanup never reuses the possibly cancelled primary socket or deadline. It
 * restores only state this preview may have changed, then checks the exact
 * random names it generated. Every restoration/removal step is attempted even
 * if an earlier one fails.
 */
async function cleanupTemporaryProbe(
  config: ObsConfig,
  probe: TemporaryProbe,
  createSocket: ObsSocketFactory,
): Promise<CapturePreviewCleanupError | undefined> {
  if (!probe.inputMayExist && !probe.sceneMayExist) return undefined;
  const socket = createSocket();
  const options = normalizeObsReadOptions({ timeoutMs: CAPTURE_PREVIEW_CLEANUP_TIMEOUT_MS });
  const deadline = Date.now() + options.timeoutMs;
  const failures: Array<"input" | "scene" | "scene_item" | "preview_scene" | "studio_mode" | "program_scene"> = [];
  try {
    await connect(socket, config, options, deadline);
    const program = await boundedObsRead(socket, () => socket.request({ type: "GetCurrentProgramScene" }), options, deadline);
    if (
      objectString(program, "sceneUuid") === probe.sceneUuid
      || objectString(program, "sceneName") === probe.sceneName
    ) {
      failures.push("program_scene");
    } else {
      const studio = await boundedObsRead(socket, () => socket.request({ type: "GetStudioModeEnabled" }), options, deadline);
      const studioModeEnabled = objectBoolean(studio, "studioModeEnabled");
      let previewRestored = !probe.previewSceneMayHaveChanged;
      if (probe.previewSceneMayHaveChanged && studioModeEnabled === true) {
        const preview = await boundedObsRead(socket, () => socket.request({ type: "GetCurrentPreviewScene" }), options, deadline);
        const previewSceneUuid = objectString(preview, "currentPreviewSceneUuid");
        if (previewSceneUuid !== probe.sceneUuid || !probe.previousPreviewSceneUuid) {
          failures.push("preview_scene");
        } else {
          if (probe.sceneItemMayHaveBeenEnabled) {
            try {
              if (probe.sceneItemId === undefined) throw new Error("Temporary scene item was not identified.");
              const sceneItemId = probe.sceneItemId;
              await boundedObsRead(socket, () => socket.request({
                data: { sceneItemEnabled: false, sceneItemId, sceneName: probe.sceneName },
                type: "SetSceneItemEnabled",
              }), options, deadline);
            } catch {
              failures.push("scene_item");
            }
          }
          try {
            await boundedObsRead(socket, () => socket.request({
              data: { sceneUuid: probe.previousPreviewSceneUuid as string },
              type: "SetCurrentPreviewScene",
            }), options, deadline);
            previewRestored = true;
          } catch {
            failures.push("preview_scene");
          }
        }
      } else if (probe.previewSceneMayHaveChanged && studioModeEnabled === false) {
        previewRestored = true;
      } else if (probe.previewSceneMayHaveChanged) {
        failures.push("preview_scene");
      }
      if (probe.studioModeMayHaveChanged) {
        if (studioModeEnabled === false) {
          // Already at the original state; do not overwrite another client.
        } else if (studioModeEnabled !== true || !previewRestored) {
          failures.push("studio_mode");
        } else {
          try {
            await boundedObsRead(socket, () => socket.request({
              data: { studioModeEnabled: false }, type: "SetStudioModeEnabled",
            }), options, deadline);
          } catch {
            failures.push("studio_mode");
          }
        }
      }
      await removeTemporaryResources(socket, probe, options, deadline, failures);
    }
  } catch {
    if (probe.previewSceneMayHaveChanged && !failures.includes("preview_scene")) failures.push("preview_scene");
    if (probe.studioModeMayHaveChanged && !failures.includes("studio_mode")) failures.push("studio_mode");
    if (probe.inputMayExist && !failures.includes("input")) failures.push("input");
    if (probe.sceneMayExist && !failures.includes("scene")) failures.push("scene");
  } finally {
    await disconnectQuietly(socket);
  }
  return failures.length > 0
    ? new CapturePreviewCleanupError(
        {
          inputName: probe.inputName,
          ...(probe.previousPreviewSceneUuid ? { previousPreviewSceneUuid: probe.previousPreviewSceneUuid } : {}),
          ...(probe.studioModeWasEnabled === false ? { previousStudioModeEnabled: false } : {}),
          sceneName: probe.sceneName,
        },
        failures,
      )
    : undefined;
}

async function removeTemporaryResources(
  socket: ObsSocket,
  probe: TemporaryProbe,
  options: Required<ObsReadOptions>,
  deadline: number,
  failures: Array<"input" | "scene" | "scene_item" | "preview_scene" | "studio_mode" | "program_scene">,
): Promise<void> {
  if (probe.inputMayExist) {
    try {
      const inputs = await boundedObsRead(socket, () => socket.request({ type: "GetInputList" }), options, deadline);
      const input = findInput(inputs, probe.inputName);
      if (!input) throw new Error("Could not verify temporary preview input cleanup.");
      if (input.inputUuid) {
        probe.inputUuid = input.inputUuid;
        await boundedObsRead(socket, () => socket.request({ data: { inputUuid: input.inputUuid }, type: "RemoveInput" }), options, deadline);
      }
    } catch {
      failures.push("input");
    }
  }
  if (probe.sceneMayExist) {
    try {
      const scenes = await boundedObsRead(socket, () => socket.request({ type: "GetSceneList" }), options, deadline);
      const sceneExists = hasSceneNamed(scenes, probe.sceneName);
      if (sceneExists === undefined) throw new Error("Could not verify temporary preview scene cleanup.");
      if (sceneExists) {
        await boundedObsRead(socket, () => socket.request({ data: { sceneName: probe.sceneName }, type: "RemoveScene" }), options, deadline);
      }
    } catch {
      failures.push("scene");
    }
  }
}

async function assertTemporaryPreviewSafe(
  socket: ObsSocket,
  probe: TemporaryProbe,
  options: Required<ObsReadOptions>,
  deadline: number,
): Promise<void> {
  const studio = await boundedObsRead(socket, () => socket.request({ type: "GetStudioModeEnabled" }), options, deadline);
  const studioModeEnabled = objectBoolean(studio, "studioModeEnabled");
  if (studioModeEnabled !== false) {
    throw new CapturePreviewError("preview_unavailable", "Temporary preview requires OBS Studio Mode to be off.");
  }
  probe.studioModeWasEnabled = false;
  for (const requestType of [
    "GetStreamStatus",
    "GetRecordStatus",
    "GetReplayBufferStatus",
    "GetVirtualCamStatus",
  ] as const) {
    const status = await boundedObsRead(socket, () => socket.request({ type: requestType }), options, deadline);
    if (objectBoolean(status, "outputActive") !== false) {
      throw new CapturePreviewError("preview_unavailable", "Temporary preview requires all OBS outputs to be inactive.");
    }
  }
  const program = await boundedObsRead(socket, () => socket.request({ type: "GetCurrentProgramScene" }), options, deadline);
  const programSceneUuid = objectString(program, "sceneUuid");
  if (!programSceneUuid) {
    throw new CapturePreviewError("preview_unavailable", "OBS did not report the current Program scene.");
  }
  probe.programSceneUuid = programSceneUuid;
}

async function withTemporaryPreviewLock<T>(
  options: Required<ObsReadOptions>,
  deadline: number,
  action: () => Promise<T>,
): Promise<T> {
  let release!: () => void;
  const ticket = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = temporaryPreviewTail;
  // A cancelled waiter releases its own ticket, but its successor still waits
  // for every earlier holder because the queue tail is chained to `previous`.
  temporaryPreviewTail = previous.then(() => ticket);
  try {
    await waitForLock(previous, options.signal, deadline);
    return await action();
  } finally {
    release();
  }
}

async function waitForLock(previous: Promise<void>, signal: AbortSignal, deadline: number): Promise<void> {
  if (signal.aborted) throw new ObsStatusError("cancelled");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ObsStatusError("timeout");
  let timeout: NodeJS.Timeout | undefined;
  let rejectAbort: ((error: ObsStatusError) => void) | undefined;
  const onAbort = () => rejectAbort?.(new ObsStatusError("cancelled"));
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    timeout = setTimeout(() => reject(new ObsStatusError("timeout")), remaining);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([previous, interrupted]);
  } finally {
    if (timeout) clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

async function connect(
  socket: ObsSocket,
  config: ObsConfig,
  options: Required<ObsReadOptions>,
  deadline: number,
): Promise<void> {
  await boundedObsRead(
    socket,
    () => socket.connect({
      address: `ws://${config.host}:${config.port}`,
      eventSubscriptions: 0,
      password: config.password,
    }),
    options,
    deadline,
  );
}

async function requestScreenshot(
  socket: ObsSocket,
  sourceUuid: string,
  options: Required<ObsReadOptions>,
  deadline: number,
): Promise<CapturePreview["image"]> {
  const response = await boundedObsRead(
    socket,
    () => socket.request({
      data: {
        imageCompressionQuality: 75,
        imageFormat: "jpg",
        imageHeight: CAPTURE_PREVIEW_IMAGE_HEIGHT,
        imageWidth: CAPTURE_PREVIEW_IMAGE_WIDTH,
        sourceUuid,
      },
      type: "GetSourceScreenshot",
    }),
    options,
    deadline,
  );
  return parsePreviewImage(objectString(
    response,
    "imageData",
    MAX_CAPTURE_PREVIEW_BASE64_CHARS + "data:image/jpeg;base64,".length,
  ));
}

function parsePreviewImage(imageData: string | undefined): CapturePreview["image"] {
  const match = imageData?.match(/^data:image\/(?:jpeg|jpg);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) {
    throw new CapturePreviewError("preview_unavailable", "OBS returned an unsupported preview image.");
  }
  const encoded = match[1] as string;
  if (encoded.length > MAX_CAPTURE_PREVIEW_BASE64_CHARS) {
    throw new CapturePreviewError("preview_unavailable", "OBS returned a preview image outside the permitted size.");
  }
  const bytes = Buffer.from(encoded, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  if (!bytes.length || encoded.replace(/=+$/, "") !== canonical || bytes.length > MAX_CAPTURE_PREVIEW_IMAGE_BYTES) {
    throw new CapturePreviewError("preview_unavailable", "OBS returned a preview image outside the permitted size.");
  }
  const dimensions = jpegDimensions(bytes);
  if (
    !dimensions
    || dimensions.width < 1
    || dimensions.height < 1
    || dimensions.width > CAPTURE_PREVIEW_IMAGE_WIDTH
    || dimensions.height > CAPTURE_PREVIEW_IMAGE_HEIGHT
  ) {
    throw new CapturePreviewError("preview_unavailable", "OBS returned a preview image outside the permitted dimensions.");
  }
  return {
    byteLength: bytes.length,
    data: bytes.toString("base64"),
    height: dimensions.height,
    mimeType: "image/jpeg",
    width: dimensions.width,
  };
}

function toPreview(
  target: CaptureTarget,
  image: CapturePreview["image"],
  previewMethod: CapturePreview["previewMethod"],
): CapturePreview {
  return {
    image,
    previewMethod,
    target: {
      availability: target.availability,
      kind: target.kind,
      label: target.label,
      targetRef: target.targetRef,
      validity: target.validity,
    },
  };
}

function remainingTimeout(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function objectString(value: unknown, key: string, maxLength = 300): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= maxLength
    ? candidate
    : undefined;
}

function objectBoolean(value: unknown, key: string): boolean | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

function objectInteger(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
}

function findInput(value: unknown, inputName: string): { inputUuid?: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const inputs = (value as Record<string, unknown>).inputs;
  if (!Array.isArray(inputs)) return undefined;
  for (const input of inputs) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) continue;
    const record = input as Record<string, unknown>;
    if (record.inputName === inputName) {
      return typeof record.inputUuid === "string" && record.inputUuid.length > 0
        ? { inputUuid: record.inputUuid }
        : undefined;
    }
  }
  return {};
}

async function disconnectQuietly(socket: ObsSocket, timeoutMs = CAPTURE_PREVIEW_DISCONNECT_WAIT_MS): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve(socket.disconnect()),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // Disconnect errors must not mask the operation or cleanup result.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function boundedRenderWait(signal: AbortSignal, deadline: number): Promise<void> {
  if (signal.aborted) throw new ObsStatusError("cancelled");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ObsStatusError("timeout");
  let renderTimer: NodeJS.Timeout | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let rejectAbort: ((error: ObsStatusError) => void) | undefined;
  const onAbort = () => rejectAbort?.(new ObsStatusError("cancelled"));
  try {
    await new Promise<void>((resolve, reject) => {
      rejectAbort = reject;
      renderTimer = setTimeout(resolve, CAPTURE_PREVIEW_RENDER_WAIT_MS);
      deadlineTimer = setTimeout(() => reject(new ObsStatusError("timeout")), remaining);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    if (renderTimer) clearTimeout(renderTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    signal.removeEventListener("abort", onAbort);
  }
}

function hasSceneNamed(value: unknown, sceneName: string): boolean | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const scenes = (value as Record<string, unknown>).scenes;
  if (!Array.isArray(scenes)) return undefined;
  return scenes.some((scene) =>
    typeof scene === "object" && scene !== null && !Array.isArray(scene) && (scene as Record<string, unknown>).sceneName === sceneName,
  );
}

function jpegDimensions(bytes: Buffer): { height: number; width: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    return undefined;
  }
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    let markerOffset = offset + 1;
    while (bytes[markerOffset] === 0xff) markerOffset += 1;
    const marker = bytes[markerOffset];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return undefined;
    const lengthOffset = markerOffset + 1;
    if (lengthOffset + 2 > bytes.length) return undefined;
    const length = bytes.readUInt16BE(lengthOffset);
    if (length < 2 || lengthOffset + length > bytes.length) return undefined;
    if (isJpegStartOfFrame(marker)) {
      if (length < 8) return undefined;
      return {
        height: bytes.readUInt16BE(lengthOffset + 3),
        width: bytes.readUInt16BE(lengthOffset + 5),
      };
    }
    offset = lengthOffset + length;
  }
  return undefined;
}

function isJpegStartOfFrame(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf);
}
