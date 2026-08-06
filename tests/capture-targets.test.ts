import { describe, expect, it } from "vitest";

import { encodeCaptureTargetRef, readCaptureTargets } from "../server/capture-targets.js";
import type {
  ObsConnectionOptions,
  ObsReadRequest,
  ObsSocket,
} from "../server/obs.js";

class DiscoverySocket implements ObsSocket {
  readonly requests: ObsReadRequest[] = [];
  connectedWith?: ObsConnectionOptions;
  disconnected = false;

  async connect(options: ObsConnectionOptions): Promise<void> {
    this.connectedWith = options;
  }

  async request(request: ObsReadRequest): Promise<unknown> {
    this.requests.push(request);
    if (request.type === "GetInputList") {
      return {
        inputs: [
          { inputKind: "screen_capture", inputName: "Window Probe", inputUuid: "screen-uuid" },
          { inputKind: "macos-avcapture", inputName: "Phone Camera", inputUuid: "camera-uuid" },
          { inputKind: "browser_source", inputName: "Ignored", inputUuid: "browser-uuid" },
        ],
      };
    }
    if (request.type === "GetInputSettings") {
      if (request.data.inputName === "Window Probe") {
        return {
          inputSettings: {
            secret_plugin_setting: "must-not-escape",
            show_hidden_windows: true,
            type: 1,
            window: 42,
          },
        };
      }
      return { inputSettings: { device: "camera-id", device_name: "Continuity Camera" } };
    }
    if (request.type === "GetInputPropertiesListPropertyItems") {
      const propertyItems = {
        application: [{ itemEnabled: true, itemName: "Bitwig Studio", itemValue: "com.bitwig.BitwigStudio" }],
        device: [{ itemEnabled: true, itemName: "Dan's iPhone", itemValue: "camera-id" }],
        display_uuid: [{ itemEnabled: true, itemName: "Built-in Display", itemValue: "display-uuid" }],
        window: [
          { itemEnabled: true, itemName: "[Bitwig Studio] Project", itemValue: 42 },
          { itemEnabled: false, itemName: "Disabled", itemValue: 43 },
          { itemEnabled: true, itemName: " ", itemValue: 0 },
        ],
      }[request.data.propertyName];
      return { propertyItems };
    }
    throw new Error(`Unexpected request: ${request.type}`);
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

describe("readCaptureTargets", () => {
  it("lists only curated capture targets with stable typed references", async () => {
    const socket = new DiscoverySocket();
    const result = await readCaptureTargets(
      { host: "127.0.0.1", password: "not-for-output", port: 4455 },
      () => socket,
    );

    expect(socket.connectedWith).toEqual({
      address: "ws://127.0.0.1:4455",
      eventSubscriptions: 0,
      password: "not-for-output",
    });
    expect(result.limitations).toEqual([
      expect.objectContaining({ code: "dynamic_list_unavailable", kind: "display" }),
      expect.objectContaining({ code: "dynamic_list_unavailable", kind: "application" }),
      expect.objectContaining({ code: "dynamic_list_unavailable", kind: "camera" }),
    ]);
    expect(result.truncatedKinds).toEqual([]);
    expect(result.sources).toEqual([
      {
        configuredTargetRef: encodeCaptureTargetRef("window", 42),
        inputKind: "screen_capture",
        inputName: "Window Probe",
        sourceRef: expect.stringMatching(/^scenecap-input-v1\./),
      },
      {
        configuredTargetRef: encodeCaptureTargetRef("camera", "camera-id"),
        inputKind: "macos-avcapture",
        inputName: "Phone Camera",
        sourceRef: expect.stringMatching(/^scenecap-input-v1\./),
      },
    ]);
    expect(result.targets).toEqual([
      {
        availability: "available",
        kind: "window",
        label: "[Bitwig Studio] Project",
        targetRef: encodeCaptureTargetRef("window", 42),
        validity: "current_obs_session",
      },
      {
        availability: "configured_only",
        kind: "camera",
        label: "Continuity Camera",
        targetRef: encodeCaptureTargetRef("camera", "camera-id"),
        validity: "persistent",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
    expect(JSON.stringify(result)).not.toContain("not-for-output");
    expect(socket.disconnected).toBe(true);
  });

  it("always uses an input name and exact allowlisted dynamic properties", async () => {
    const socket = new DiscoverySocket();
    await readCaptureTargets(
      { host: "127.0.0.1", password: "secret", port: 4455 },
      () => socket,
    );

    const propertyRequests = socket.requests.filter(
      (request): request is Extract<ObsReadRequest, { type: "GetInputPropertiesListPropertyItems" }> =>
        request.type === "GetInputPropertiesListPropertyItems",
    );
    expect(propertyRequests.map((request) => request.data)).toEqual([
      { inputName: "Window Probe", propertyName: "window" },
    ]);
    expect(propertyRequests.every((request) => !("inputUuid" in request.data))).toBe(true);
  });

  it("reports structured setup limitations instead of mutating OBS to create probes", async () => {
    const requests: ObsReadRequest[] = [];
    const socket: ObsSocket = {
      async connect() {},
      async request(request) {
        requests.push(request);
        if (request.type === "GetInputList") return { inputs: [] };
        throw new Error("Discovery must not issue another request without capture inputs.");
      },
      disconnect() {},
    };

    const result = await readCaptureTargets(
      { host: "127.0.0.1", password: "secret", port: 4455 },
      () => socket,
    );

    expect(result).toEqual({
      limitations: [
        expect.objectContaining({ code: "requires_existing_input", kind: "screen_capture" }),
        expect.objectContaining({ code: "requires_existing_input", kind: "camera" }),
      ],
      sources: [],
      targets: [],
      truncatedKinds: [],
    });
    expect(requests).toEqual([{ type: "GetInputList" }]);
  });

  it("honours cancellation before connecting to OBS", async () => {
    const socket = new DiscoverySocket();
    const controller = new AbortController();
    controller.abort();

    await expect(readCaptureTargets(
      { host: "127.0.0.1", password: "secret", port: 4455 },
      () => socket,
      controller.signal,
    )).rejects.toMatchObject({ kind: "cancelled" });
    expect(socket.connectedWith).toBeUndefined();
    expect(socket.requests).toEqual([]);
    expect(socket.disconnected).toBe(true);
  });

  it("honours cancellation during capture-input inspection", async () => {
    let startSettingsRequest!: () => void;
    const settingsRequestStarted = new Promise<void>((resolve) => {
      startSettingsRequest = resolve;
    });
    let disconnected = false;
    const socket: ObsSocket = {
      async connect() {},
      async request(request) {
        if (request.type === "GetInputList") {
          return { inputs: [{ inputKind: "screen_capture", inputName: "Probe", inputUuid: "uuid" }] };
        }
        if (request.type === "GetInputSettings") {
          startSettingsRequest();
          return new Promise<never>(() => undefined);
        }
        throw new Error(`Unexpected request: ${request.type}`);
      },
      disconnect() {
        disconnected = true;
      },
    };
    const controller = new AbortController();
    const pending = readCaptureTargets(
      { host: "127.0.0.1", password: "secret", port: 4455 },
      () => socket,
      controller.signal,
    );
    await settingsRequestStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    expect(disconnected).toBe(true);
  });

  it("bounds large OBS window lists and reports truncation", async () => {
    const socket: ObsSocket = {
      async connect() {},
      async request(request) {
        if (request.type === "GetInputList") {
          return { inputs: [{ inputKind: "screen_capture", inputName: "Probe", inputUuid: "uuid" }] };
        }
        if (request.type === "GetInputSettings") return { inputSettings: { type: 1, window: 251 } };
        if (request.type === "GetInputPropertiesListPropertyItems") {
          return {
            propertyItems: Array.from({ length: 251 }, (_, index) => ({
              itemEnabled: true,
              itemName: `Window ${index + 1}`,
              itemValue: index + 1,
            })),
          };
        }
        throw new Error(`Unexpected request: ${request.type}`);
      },
      disconnect() {},
    };

    const result = await readCaptureTargets(
      { host: "127.0.0.1", password: "secret", port: 4455 },
      () => socket,
    );

    expect(result.targets).toHaveLength(250);
    expect(result.truncatedKinds).toEqual(["window"]);
    expect(result.targets.find((target) => target.targetRef === encodeCaptureTargetRef("window", 251)))
      .toMatchObject({ availability: "available", label: "Window 251" });
  });

  it("caps screen and camera inputs independently", async () => {
    const inputs = [
      ...Array.from({ length: 9 }, (_, index) => ({
        inputKind: "screen_capture",
        inputName: `Screen ${index + 1}`,
        inputUuid: `screen-${index + 1}`,
      })),
      { inputKind: "macos-avcapture", inputName: "Camera", inputUuid: "camera" },
    ];
    const socket: ObsSocket = {
      async connect() {},
      async request(request) {
        if (request.type === "GetInputList") return { inputs };
        if (request.type === "GetInputSettings") {
          return request.data.inputName === "Camera"
            ? { inputSettings: { device: "camera-id" } }
            : { inputSettings: { type: 1 } };
        }
        if (request.type === "GetInputPropertiesListPropertyItems") return { propertyItems: [] };
        throw new Error(`Unexpected request: ${request.type}`);
      },
      disconnect() {},
    };

    const result = await readCaptureTargets(
      { host: "127.0.0.1", password: "secret", port: 4455 },
      () => socket,
    );

    expect(result.sources).toHaveLength(9);
    expect(result.sources.some((source) => source.inputKind === "macos-avcapture")).toBe(true);
    expect(result.limitations).toContainEqual(
      expect.objectContaining({ code: "input_limit_reached", kind: "screen_capture" }),
    );
    expect(result.limitations).not.toContainEqual(
      expect.objectContaining({ code: "requires_existing_input", kind: "camera" }),
    );
  });

  it("reports explicit display and application selections, including the default display mode", async () => {
    const socket: ObsSocket = {
      async connect() {},
      async request(request) {
        if (request.type === "GetInputList") {
          return {
            inputs: [
              { inputKind: "screen_capture", inputName: "Display", inputUuid: "display-source" },
              { inputKind: "screen_capture", inputName: "Application", inputUuid: "app-source" },
            ],
          };
        }
        if (request.type === "GetInputSettings") {
          return request.data.inputName === "Display"
            ? { inputSettings: { display_uuid: "display-id" } }
            : { inputSettings: { application: "com.example.App", type: 2 } };
        }
        if (request.type === "GetInputPropertiesListPropertyItems") return { propertyItems: [] };
        throw new Error(`Unexpected request: ${request.type}`);
      },
      disconnect() {},
    };

    const result = await readCaptureTargets(
      { host: "127.0.0.1", password: "secret", port: 4455 },
      () => socket,
    );

    expect(result.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "display",
        targetRef: encodeCaptureTargetRef("display", "display-id"),
      }),
      expect.objectContaining({
        kind: "application",
        targetRef: encodeCaptureTargetRef("application", "com.example.App"),
      }),
    ]));
  });

  it("skips an input that disappears during discovery and keeps the remaining results", async () => {
    const socket: ObsSocket = {
      async connect() {},
      async request(request) {
        if (request.type === "GetInputList") {
          return {
            inputs: [
              { inputKind: "screen_capture", inputName: "Removed", inputUuid: "removed" },
              { inputKind: "screen_capture", inputName: "Remaining", inputUuid: "remaining" },
            ],
          };
        }
        if (request.type === "GetInputSettings" && request.data.inputName === "Removed") {
          throw Object.assign(new Error("resource not found"), { code: 601 });
        }
        if (request.type === "GetInputSettings") return { inputSettings: { type: 1, window: 7 } };
        if (request.type === "GetInputPropertiesListPropertyItems") {
          return { propertyItems: [{ itemEnabled: true, itemName: "Remaining Window", itemValue: 7 }] };
        }
        throw new Error(`Unexpected request: ${request.type}`);
      },
      disconnect() {},
    };

    const result = await readCaptureTargets(
      { host: "127.0.0.1", password: "secret", port: 4455 },
      () => socket,
    );

    expect(result.sources.map((source) => source.inputName)).toEqual(["Remaining"]);
    expect(result.limitations).toContainEqual(expect.objectContaining({
      code: "input_unavailable",
      inputName: "Removed",
    }));
    expect(result.targets).toContainEqual(expect.objectContaining({ label: "Remaining Window" }));
  });
});
