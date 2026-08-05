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
      return { inputKinds: ["macos-screen-capture"] };
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
      inputKinds: ["macos-screen-capture"],
      obsVersion: "31.0.0",
      sourceFilterKinds: ["crop_filter", "source_record_filter"],
      websocketVersion: "5.5.0",
    });
  });

  it("honours cancellation before making an OBS connection", async () => {
    const socket = new FakeObsSocket();
    const controller = new AbortController();
    controller.abort();

    await expect(
      readObsStatus({ host: "127.0.0.1", password: "test-secret", port: 4455 }, () => socket, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(socket.connectedWith).toBeUndefined();
    expect(socket.calls).toEqual([]);
  });
});
