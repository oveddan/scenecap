import OBSWebSocket from "obs-websocket-js/json";

import type { SidecarConfig } from "./config.js";

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
  inputKinds: string[];
  obsVersion?: string;
  sourceFilterKinds: string[];
  websocketVersion?: string;
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

  disconnect(): void {
    this.#socket.disconnect();
  }
}

export function createObsSocket(): ObsSocket {
  return new ObsWebSocketAdapter();
}

export async function readObsStatus(
  config: SidecarConfig["obs"],
  createSocket: ObsSocketFactory = createObsSocket,
  signal?: AbortSignal,
): Promise<ObsStatus> {
  throwIfAborted(signal);
  const socket = createSocket();
  try {
    await socket.connect({
      // The destination is constructed from validated numeric loopback data.
      // No proxy URL, redirect URL, or caller-provided endpoint can enter this
      // adapter; the WebSocket connection is therefore a direct local handshake.
      address: `ws://${config.host}:${config.port}`,
      eventSubscriptions: 0,
      password: config.password,
    });
    throwIfAborted(signal);

    // This foundation intentionally makes only read-only capability calls.
    const version = await socket.call("GetVersion");
    throwIfAborted(signal);
    const inputKinds = await socket.call("GetInputKindList");
    throwIfAborted(signal);
    const sourceFilterKinds = await socket.call("GetSourceFilterKindList");
    throwIfAborted(signal);

    const availableInputKinds = stringList(inputKinds, "inputKinds");
    const availableFilterKinds = stringList(sourceFilterKinds, "sourceFilterKinds");
    return {
      capabilities: {
        screen_capture: availableInputKinds.some(isScreenCaptureInput),
        source_record_filter: availableFilterKinds.includes("source_record_filter"),
      },
      inputKinds: availableInputKinds,
      obsVersion: optionalString(version, "obsVersion"),
      sourceFilterKinds: availableFilterKinds,
      websocketVersion: optionalString(version, "obsWebSocketVersion"),
    };
  } finally {
    await socket.disconnect();
  }
}

function isScreenCaptureInput(inputKind: string): boolean {
  return inputKind === "screen_capture" || inputKind === "macos-screen-capture";
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
    throw signal.reason instanceof Error ? signal.reason : new DOMException("Operation aborted", "AbortError");
  }
}
