import { describe, expect, it } from "vitest";

import type { ObsConnectionOptions, ObsSocket } from "../server/obs.js";
import { readObsStatus } from "../server/obs.js";

class FakeObsSocket implements ObsSocket {
  readonly calls: string[] = [];
  connectedWith?: ObsConnectionOptions;
  disconnected = false;

  async connect(options: ObsConnectionOptions): Promise<void> {
    this.connectedWith = options;
  }

  async call(requestType: "GetVersion" | "GetInputKindList" | "GetSourceFilterKindList"): Promise<unknown> {
    this.calls.push(requestType);
    if (requestType === "GetVersion") {
      return { obsVersion: "31.0.0", obsWebSocketVersion: "5.5.0" };
    }
    if (requestType === "GetInputKindList") {
      return { inputKinds: ["display_capture"] };
    }
    return { sourceFilterKinds: ["crop_filter", "source_record_filter"] };
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

describe("readObsStatus", () => {
  it("authenticates and makes exactly the read-only preflight calls with events disabled", async () => {
    const socket = new FakeObsSocket();
    const status = await readObsStatus(
      { host: "127.0.0.1", password: "not-for-output", port: 4455 },
      () => socket,
    );

    expect(socket.connectedWith).toEqual({
      address: "ws://127.0.0.1:4455",
      eventSubscriptions: 0,
      password: "not-for-output",
    });
    expect(socket.calls).toEqual(["GetVersion", "GetInputKindList", "GetSourceFilterKindList"]);
    expect(socket.disconnected).toBe(true);
    expect(status).toEqual({
      capabilities: { screen_capture: true, source_record_filter: true },
      obsVersion: "31.0.0",
      websocketVersion: "5.5.0",
    });
  });

  it("honours cancellation before making an OBS connection", async () => {
    const socket = new FakeObsSocket();
    const controller = new AbortController();
    controller.abort();

    await expect(
      readObsStatus({ host: "127.0.0.1", password: "test-secret", port: 4455 }, () => socket, controller.signal),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(socket.connectedWith).toBeUndefined();
    expect(socket.calls).toEqual([]);
  });

  it("times out during the OBS Hello handshake and disconnects", async () => {
    const socket = new HangingConnectSocket();

    await expect(
      readObsStatus(
        { host: "127.0.0.1", password: "test-secret", port: 4455 },
        () => socket,
        { timeoutMs: 10 },
      ),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(socket.disconnected).toBe(true);
  });

  it("cancels during an OBS response and disconnects", async () => {
    const socket = new HangingRequestSocket();
    const controller = new AbortController();
    const requestStarted = socket.waitForRequest();
    const pending = readObsStatus(
      { host: "127.0.0.1", password: "test-secret", port: 4455 },
      () => socket,
      { signal: controller.signal, timeoutMs: 1_000 },
    );
    await requestStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    expect(socket.disconnected).toBe(true);
  });

  it("applies one timeout budget to the complete preflight", async () => {
    const socket = new SlowSocket(15);

    await expect(
      readObsStatus(
        { host: "127.0.0.1", password: "test-secret", port: 4455 },
        () => socket,
        { timeoutMs: 35 },
      ),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(socket.disconnected).toBe(true);
  });
});

class HangingConnectSocket implements ObsSocket {
  disconnected = false;

  async connect(): Promise<void> {
    await new Promise<void>(() => undefined);
  }

  async call(): Promise<unknown> {
    throw new Error("No request should be issued before Hello completes.");
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class HangingRequestSocket implements ObsSocket {
  disconnected = false;
  #requestStarted!: () => void;
  readonly #requestStartedPromise = new Promise<void>((resolve) => {
    this.#requestStarted = resolve;
  });

  async connect(): Promise<void> {}

  async call(): Promise<unknown> {
    this.#requestStarted();
    return new Promise<never>(() => undefined);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  waitForRequest(): Promise<void> {
    return this.#requestStartedPromise;
  }
}

class SlowSocket implements ObsSocket {
  disconnected = false;

  constructor(readonly delayMs: number) {}

  async connect(): Promise<void> {
    await delay(this.delayMs);
  }

  async call(requestType: "GetVersion" | "GetInputKindList" | "GetSourceFilterKindList"): Promise<unknown> {
    await delay(this.delayMs);
    if (requestType === "GetVersion") return {};
    if (requestType === "GetInputKindList") return { inputKinds: [] };
    return { sourceFilterKinds: [] };
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
