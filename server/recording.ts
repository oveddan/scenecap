import { stat } from "node:fs/promises";

import type { CaptureSession, CaptureSessionStore, RecordingSession } from "./capture-session.js";
import { readCaptureTargets } from "./capture-targets.js";
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
  const discovery = await readCaptureTargets(config, createSocket, {
    signal: options.signal,
    timeoutMs: remainingTimeout(deadline),
  });
  const current = new Map(discovery.sources.map((source) => [source.sourceRef, source]));
  for (const configured of session.configuredSources) {
    const source = current.get(configured.source.sourceRef);
    if (!source || source.configuredTargetRef !== configured.target.targetRef) {
      throw new RecordingControlError("stale_configuration", "A configured capture source changed in OBS; configure it again before recording.");
    }
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

function remainingTimeout(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function isDefinitiveObsRequestRejection(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "number" && Number.isInteger(code) && code >= 200 && code < 700;
}
