import { stat } from "node:fs/promises";

import type { CaptureSession, CaptureSessionStore, RecordingSession } from "./capture-session.js";
import { decodeCaptureTargetRef, decodeInputRef } from "./capture-targets.js";
import type { ObsConfig } from "./config.js";
import {
  boundedObsRead,
  createObsSocket,
  isAbortSignal,
  normalizeObsReadOptions,
  type ObsReadOptions,
  type ObsSocket,
  type ObsSocketFactory,
} from "./obs.js";

export const DEFAULT_RECORDING_TIMEOUT_MS = 20_000;

export interface RecordingOutput {
  byteLength?: number;
  exists: boolean;
  kind: "obs_recording";
  path: string;
}

export interface StartedRecording {
  recording: RecordingSession;
  sessionId: string;
}

export interface StoppedRecording {
  output: RecordingOutput;
  sessionId: string;
}

export type RecordingControlErrorKind =
  | "already_recording"
  | "ambiguous_recording_state"
  | "no_configured_sources"
  | "not_recording"
  | "recording_owned_elsewhere"
  | "stale_configuration";

export class RecordingControlError extends Error {
  constructor(readonly kind: RecordingControlErrorKind, message: string) {
    super(message);
    this.name = "RecordingControlError";
  }
}

export async function startRecording(
  config: ObsConfig,
  store: CaptureSessionStore,
  createSocket: ObsSocketFactory = createObsSocket,
  optionsOrSignal: ObsReadOptions | AbortSignal = {},
): Promise<StartedRecording> {
  const options = recordingOptions(optionsOrSignal);
  const deadline = Date.now() + options.timeoutMs;
  const session = store.read();
  assertCanStart(session);
  await assertConfigurationCurrent(config, session, createSocket, options, deadline);
  const socket = createSocket();
  try {
    await connect(socket, config, options, deadline);
    const before = await recordActive(socket, options, deadline);
    if (before) throw new RecordingControlError("recording_owned_elsewhere", "OBS is already recording outside scenecap.");
    store.beginRecording();
    try {
      await boundedObsRead(socket, () => socket.request({ type: "StartRecord" }), options, deadline);
    } catch (error) {
      if (isDefinitiveObsRequestRejection(error)) store.clearRecording();
      throw error;
    }
    if (!await recordActive(socket, options, deadline)) {
      throw new RecordingControlError("ambiguous_recording_state", "OBS did not confirm that recording started.");
    }
    const active = store.setRecordingState("active");
    return { recording: active.recording as RecordingSession, sessionId: active.sessionId };
  } finally {
    void Promise.resolve(socket.disconnect()).catch(() => undefined);
  }
}

export async function stopRecording(
  config: ObsConfig,
  store: CaptureSessionStore,
  createSocket: ObsSocketFactory = createObsSocket,
  optionsOrSignal: ObsReadOptions | AbortSignal = {},
): Promise<StoppedRecording> {
  const options = recordingOptions(optionsOrSignal);
  const deadline = Date.now() + options.timeoutMs;
  const session = store.read();
  const recording = session.recording;
  if (!recording) throw new RecordingControlError("not_recording", "No scenecap-owned recording is active.");
  if (recording.state !== "active") {
    throw new RecordingControlError("ambiguous_recording_state", "The prior recording transition is ambiguous; inspect OBS before retrying.");
  }
  const socket = createSocket();
  try {
    await connect(socket, config, options, deadline);
    if (!await recordActive(socket, options, deadline)) {
      // The previous active state was sidecar-owned, but a missing active OBS
      // output could mean an external stop or a lost event. Retain ownership
      // evidence and block a later start from accidentally adopting it.
      store.setRecordingState("stop_ambiguous");
      throw new RecordingControlError("ambiguous_recording_state", "OBS no longer reports the scenecap recording as active.");
    }
    store.setRecordingState("stop_ambiguous");
    let stopped: unknown;
    try {
      stopped = await boundedObsRead(socket, () => socket.request({ type: "StopRecord" }), options, deadline);
    } catch (error) {
      if (isDefinitiveObsRequestRejection(error)) store.setRecordingState("active");
      throw error;
    }
    const outputPath = objectString(stopped, "outputPath");
    if (!outputPath) {
      throw new RecordingControlError("ambiguous_recording_state", "OBS stopped recording without returning its output path.");
    }
    if (await recordActive(socket, options, deadline)) {
      throw new RecordingControlError("ambiguous_recording_state", "OBS did not confirm that recording stopped.");
    }
    const cleared = store.clearRecording();
    return { output: await inspectOutput(outputPath), sessionId: cleared.sessionId };
  } finally {
    void Promise.resolve(socket.disconnect()).catch(() => undefined);
  }
}

function assertCanStart(session: CaptureSession): void {
  if (session.recording?.state === "active") {
    throw new RecordingControlError("already_recording", "A scenecap-owned recording is already active.");
  }
  if (session.recording) {
    throw new RecordingControlError("ambiguous_recording_state", "The prior recording transition is ambiguous; inspect OBS before retrying.");
  }
  if (
    !session.configuredSources.length
    || session.configuredSources.some((source) => source.configurationState !== "configured")
    || session.unresolvedCreations.length
  ) {
    throw new RecordingControlError("no_configured_sources", "Configure at least one complete capture source before recording.");
  }
}

async function assertConfigurationCurrent(
  config: ObsConfig,
  session: CaptureSession,
  createSocket: ObsSocketFactory,
  options: Required<ObsReadOptions>,
  deadline: number,
): Promise<void> {
  const socket = createSocket();
  try {
    await connect(socket, config, options, deadline);
    const inputList = await boundedObsRead(socket, () => socket.request({ type: "GetInputList" }), options, deadline);
    const inputs = arrayField(inputList, "inputs");
    for (const configured of session.configuredSources) {
      const inputUuid = decodeInputRef(configured.source.sourceRef);
      if (!inputUuid) throw staleConfiguration();
      const input = inputs.find((candidate) => objectString(candidate, "inputUuid") === inputUuid);
      if (!input || objectString(input, "inputKind") !== configured.source.inputKind) throw staleConfiguration();
      const inputName = objectString(input, "inputName");
      if (!inputName) throw staleConfiguration();
      const settings = await boundedObsRead(
        socket,
        () => socket.request({ data: { inputName }, type: "GetInputSettings" }),
        options,
        deadline,
      );
      if (!settingsMatchTarget(configured.source.inputKind, configured.target.targetRef, objectRecord(settings, "inputSettings"))) {
        throw staleConfiguration();
      }
      const sceneItems = await boundedObsRead(
        socket,
        () => socket.request({ data: { sceneName: configured.scene.sceneName }, type: "GetSceneItemList" }),
        options,
        deadline,
      );
      if (!arrayField(sceneItems, "sceneItems").some((item) => objectString(item, "sourceUuid") === inputUuid)) {
        throw staleConfiguration();
      }
    }
  } finally {
    void Promise.resolve(socket.disconnect()).catch(() => undefined);
  }
}

function recordingOptions(optionsOrSignal: ObsReadOptions | AbortSignal): Required<ObsReadOptions> {
  const timeoutMs = isAbortSignal(optionsOrSignal)
    ? DEFAULT_RECORDING_TIMEOUT_MS
    : optionsOrSignal.timeoutMs ?? DEFAULT_RECORDING_TIMEOUT_MS;
  return normalizeObsReadOptions(isAbortSignal(optionsOrSignal)
    ? { signal: optionsOrSignal, timeoutMs }
    : { ...optionsOrSignal, timeoutMs });
}

async function connect(socket: ObsSocket, config: ObsConfig, options: Required<ObsReadOptions>, deadline: number): Promise<void> {
  await boundedObsRead(socket, () => socket.connect({
    address: `ws://${config.host}:${config.port}`,
    eventSubscriptions: 0,
    password: config.password,
  }), options, deadline);
}

async function recordActive(socket: ObsSocket, options: Required<ObsReadOptions>, deadline: number): Promise<boolean> {
  const status = await boundedObsRead(socket, () => socket.request({ type: "GetRecordStatus" }), options, deadline);
  const active = objectBoolean(status, "outputActive");
  if (active === undefined) throw new RecordingControlError("ambiguous_recording_state", "OBS did not return a recording status.");
  return active;
}

async function inspectOutput(path: string): Promise<RecordingOutput> {
  try {
    const file = await stat(path);
    return file.isFile()
      ? { byteLength: file.size, exists: true, kind: "obs_recording", path }
      : { exists: false, kind: "obs_recording", path };
  } catch {
    return { exists: false, kind: "obs_recording", path };
  }
}

function objectBoolean(value: unknown, key: string): boolean | undefined {
  const candidate = objectField(value, key);
  return typeof candidate === "boolean" ? candidate : undefined;
}

function objectString(value: unknown, key: string): string | undefined {
  const candidate = objectField(value, key);
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 4_096 ? candidate : undefined;
}

function objectField(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function settingsMatchTarget(inputKind: string, targetRef: string, settings: Record<string, unknown>): boolean {
  const target = decodeCaptureTargetRef(targetRef);
  if (!target) return false;
  if (inputKind === "screen_capture") {
    const type = settings.type === undefined ? 0 : settings.type;
    return (target.kind === "display" && type === 0 && settings.display_uuid === target.value)
      || (target.kind === "window" && type === 1 && settings.window === target.value)
      || (target.kind === "application" && type === 2 && settings.application === target.value);
  }
  return (inputKind === "av_capture_input_v2" || inputKind === "macos-avcapture")
    && target.kind === "camera"
    && settings.device === target.value;
}

function staleConfiguration(): RecordingControlError {
  return new RecordingControlError("stale_configuration", "A configured capture source changed in OBS; configure it again before recording.");
}

function arrayField(value: unknown, key: string): unknown[] {
  const candidate = objectField(value, key);
  return Array.isArray(candidate) ? candidate : [];
}

function objectRecord(value: unknown, key: string): Record<string, unknown> {
  const candidate = objectField(value, key);
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : {};
}

function isDefinitiveObsRequestRejection(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "number" && Number.isInteger(code) && code >= 200 && code < 700;
}
