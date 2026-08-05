import OBSWebSocket from "obs-websocket-js/json";

import type { ObsConfig } from "./config.js";

export const DEFAULT_OBS_OPERATION_TIMEOUT_MS = 5_000;

export type ObsFailureKind =
  | "authentication_failed"
  | "cancelled"
  | "incompatible_protocol"
  | "obs_unavailable"
  | "timeout"
  | "unknown";

export class ObsStatusError extends Error {
  constructor(readonly kind: Extract<ObsFailureKind, "cancelled" | "timeout">) {
    super(kind === "timeout" ? "OBS operation timed out." : "OBS operation was cancelled.");
    this.name = "ObsStatusError";
  }
}

export interface ObsConnectionOptions {
  address: string;
  eventSubscriptions: 0;
  password: string;
}

export interface ObsSocket {
  connect(options: ObsConnectionOptions): Promise<void>;
  call(requestType: "GetVersion"): Promise<unknown>;
  call(requestType: "GetInputKindList"): Promise<unknown>;
  call(requestType: "GetSourceFilterKindList"): Promise<unknown>;
  disconnect(): void | Promise<void>;
}

export interface ObsStatus {
  capabilities: {
    screen_capture: boolean;
    source_record_filter: boolean;
  };
  obsVersion?: string;
  websocketVersion?: string;
}

export interface ObsReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ObsSocketFactory = () => ObsSocket;

/** A deliberately narrow adapter: no generic OBS request method is exported. */
export class ObsWebSocketAdapter implements ObsSocket {
  readonly #socket = new OBSWebSocket();

  async connect(options: ObsConnectionOptions): Promise<void> {
    await this.#socket.connect(options.address, options.password, {
      eventSubscriptions: options.eventSubscriptions,
    });
  }

  async call(
    requestType: "GetVersion" | "GetInputKindList" | "GetSourceFilterKindList",
  ): Promise<unknown> {
    return this.#socket.call(requestType);
  }

  disconnect(): Promise<void> {
    return this.#socket.disconnect();
  }
}

export function createObsSocket(): ObsSocket {
  return new ObsWebSocketAdapter();
}

export async function readObsStatus(
  config: ObsConfig,
  createSocket: ObsSocketFactory = createObsSocket,
  optionsOrSignal: ObsReadOptions | AbortSignal = {},
): Promise<ObsStatus> {
  const options = normalizeOptions(optionsOrSignal);
  throwIfAborted(options.signal);
  const socket = createSocket();
  try {
    await bounded(socket, () => socket.connect({
      // The destination is constructed from validated numeric loopback data.
      // No proxy URL, redirect URL, or caller-provided endpoint can enter this
      // adapter; the WebSocket connection is therefore a direct local handshake.
      address: `ws://${config.host}:${config.port}`,
      eventSubscriptions: 0,
      password: config.password,
    }), options);

    // This foundation intentionally makes only read-only capability calls.
    const version = await bounded(socket, () => socket.call("GetVersion"), options);
    const inputKinds = await bounded(socket, () => socket.call("GetInputKindList"), options);
    const sourceFilterKinds = await bounded(socket, () => socket.call("GetSourceFilterKindList"), options);

    const availableInputKinds = stringList(inputKinds, "inputKinds");
    const availableFilterKinds = stringList(sourceFilterKinds, "sourceFilterKinds");
    return {
      capabilities: {
        screen_capture: availableInputKinds.some(isScreenCaptureInput),
        source_record_filter: availableFilterKinds.includes("source_record_filter"),
      },
      obsVersion: optionalString(version, "obsVersion"),
      websocketVersion: optionalString(version, "obsWebSocketVersion"),
    };
  } finally {
    disconnectQuietly(socket);
  }
}

function isScreenCaptureInput(inputKind: string): boolean {
  return inputKind === "screen_capture" || inputKind === "display_capture" || inputKind === "window_capture";
}

export function classifyObsFailure(error: unknown): ObsFailureKind {
  if (error instanceof ObsStatusError) return error.kind;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (code === 4005 || /auth|password|identify/.test(message)) return "authentication_failed";
  if (code === 4009 || /protocol|subprotocol|rpc version|incompatible/.test(message)) {
    return "incompatible_protocol";
  }
  if (/econnrefused|econnreset|enotfound|connection refused|connect|unexpected server response/.test(message)) {
    return "obs_unavailable";
  }
  return "unknown";
}

async function bounded<T>(
  socket: ObsSocket,
  operation: () => Promise<T>,
  options: Required<ObsReadOptions>,
): Promise<T> {
  if (options.signal.aborted) {
    disconnectQuietly(socket);
    throw new ObsStatusError("cancelled");
  }
  let timeout: NodeJS.Timeout | undefined;
  let rejectAbort: ((reason: ObsStatusError) => void) | undefined;
  const onAbort = () => rejectAbort?.(new ObsStatusError("cancelled"));
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    timeout = setTimeout(() => reject(new ObsStatusError("timeout")), options.timeoutMs);
    options.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), interrupted]);
  } catch (error) {
    if (error instanceof ObsStatusError) disconnectQuietly(socket);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal.removeEventListener("abort", onAbort);
  }
}

function normalizeOptions(optionsOrSignal: ObsReadOptions | AbortSignal): Required<ObsReadOptions> {
  const options = isAbortSignal(optionsOrSignal) ? { signal: optionsOrSignal } : optionsOrSignal;
  return {
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_OBS_OPERATION_TIMEOUT_MS,
  };
}

function isAbortSignal(value: ObsReadOptions | AbortSignal): value is AbortSignal {
  return "aborted" in value && "addEventListener" in value;
}

function disconnectQuietly(socket: ObsSocket): void {
  void Promise.resolve(socket.disconnect()).catch(() => undefined);
}

function optionalString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function stringList(value: unknown, key: string): string[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  const candidate = (value as Record<string, unknown>)[key];
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate.filter((item): item is string => typeof item === "string");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ObsStatusError("cancelled");
  }
}
