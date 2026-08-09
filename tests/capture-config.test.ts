import { describe, expect, it } from "vitest";

import {
  CaptureConfigurationError,
  CaptureConfigurationPartialError,
  alignEncoderDimensions,
  configureCaptureTarget,
} from "../server/capture-config.js";
import { CaptureSessionStore } from "../server/capture-session.js";
import { encodeCaptureTargetRef, encodeInputRef } from "../server/capture-targets.js";
import type { ObsConnectionOptions, ObsRequest, ObsSocket } from "../server/obs.js";

const config = { host: "127.0.0.1", password: "configuration-secret", port: 4455 } as const;
const windowTargetRef = encodeCaptureTargetRef("window", 42);

class FakeSocket implements ObsSocket {
  readonly requests: ObsRequest[] = [];
  connectedWith?: ObsConnectionOptions;
  disconnected = false;

  constructor(readonly responder: (request: ObsRequest) => unknown | Promise<unknown>) {}

  async connect(options: ObsConnectionOptions): Promise<void> {
    this.connectedWith = options;
  }

  async request(request: ObsRequest): Promise<unknown> {
    this.requests.push(request);
    return this.responder(request);
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

describe("configureCaptureTarget", () => {
  it("rejects malformed opaque references before opening an OBS connection", async () => {
    let created = 0;
    await expect(configureCaptureTarget(config, {
      newSource: { inputName: "Terminal" },
      targetRef: "not-a-target-reference",
    }, () => {
      created += 1;
      return new FakeSocket(() => ({}));
    })).rejects.toMatchObject({ kind: "invalid_reference" } satisfies Partial<CaptureConfigurationError>);
    expect(created).toBe(0);
  });

  it("updates an existing compatible input, preserving it and adding it to Program only when absent", async () => {
    const sourceRef = encodeInputRef("screen-input-uuid");
    const discovery = discoverySocket({ inputName: "Screen", inputUuid: "screen-input-uuid", configuredWindow: 41 });
    const mutation = new FakeSocket((request) => {
      if (request.type === "GetCurrentProgramScene") {
        return { currentProgramSceneName: "Record", currentProgramSceneUuid: "scene-uuid" };
      }
      if (request.type === "GetInputList") {
        return { inputs: [{ inputKind: "screen_capture", inputName: "Screen", inputUuid: "screen-input-uuid" }] };
      }
      if (request.type === "GetInputSettings") return { inputSettings: { type: 1, window: 41 } };
      if (request.type === "SetInputSettings") return {};
      if (request.type === "GetSceneItemList") return { sceneItems: [] };
      if (request.type === "CreateSceneItem") return { sceneItemId: 17 };
      throw new Error(`Unexpected configuration request ${request.type}`);
    });
    const sockets = [discovery, mutation];

    const result = await configureCaptureTarget(config, { sourceRef, targetRef: windowTargetRef }, () => nextSocket(sockets));

    expect(result.configuredSource).toMatchObject({
      recovery: {
        input: "restore_previous_target",
        mutationOutcome: "confirmed",
        previousTargetRef: encodeCaptureTargetRef("window", 41),
        sceneItem: "remove_added_scene_item",
      },
      scene: { sceneName: "Record", sceneUuid: "scene-uuid" },
      source: { configuredTargetRef: windowTargetRef, inputKind: "screen_capture", inputName: "Screen", sourceRef },
      target: { targetRef: windowTargetRef },
    });
    expect(result.restoreSnapshot).toEqual({
      configuredSourceRef: sourceRef,
      previousInputSettings: { type: 1, window: 41 },
      sceneItemId: 17,
    });
    expect(mutation.requests).toEqual([
      { type: "GetCurrentProgramScene" },
      { type: "GetInputList" },
      { data: { inputName: "Screen" }, type: "GetInputSettings" },
      { data: { inputName: "Screen", inputSettings: { type: 1, window: 42 }, overlay: true }, type: "SetInputSettings" },
      { data: { sceneName: "Record" }, type: "GetSceneItemList" },
      { data: { sceneName: "Record", sourceName: "Screen" }, type: "CreateSceneItem" },
    ]);
    expect(mutation.disconnected).toBe(true);
  });

  it("creates a named camera input in a requested existing scene and retains a removable recovery point", async () => {
    const cameraTargetRef = encodeCaptureTargetRef("camera", "phone-camera-device");
    const discovery = discoverySocket({
      inputKind: "macos-avcapture",
      inputName: "Phone probe",
      inputUuid: "phone-probe-uuid",
      configuredCamera: "phone-camera-device",
    });
    const mutation = new FakeSocket((request) => {
      if (request.type === "GetSceneList") return { scenes: [{ sceneName: "Devices", sceneUuid: "devices-uuid" }] };
      if (request.type === "GetInputList") return { inputs: [] };
      if (request.type === "CreateInput") return { inputUuid: "phone-input-uuid", sceneItemId: 7 };
      throw new Error(`Unexpected configuration request ${request.type}`);
    });
    const sockets = [discovery, mutation];

    const result = await configureCaptureTarget(config, {
      encoderDimensions: { height: 1_081, width: 1_919 },
      newSource: { inputKind: "macos-avcapture", inputName: "Phone" },
      sceneName: "Devices",
      targetRef: cameraTargetRef,
    }, () => nextSocket(sockets));

    expect(result).toMatchObject({
      configuredSource: {
        recovery: { input: "remove_created_input", mutationOutcome: "confirmed", sceneItem: "remove_added_scene_item" },
        scene: { sceneName: "Devices", sceneUuid: "devices-uuid" },
        source: {
          configuredTargetRef: cameraTargetRef,
          inputKind: "macos-avcapture",
          inputName: "Phone",
          sourceRef: encodeInputRef("phone-input-uuid"),
        },
      },
      encoderSafeDimensions: { adjusted: true, alignment: 2, height: 1_082, width: 1_920 },
    });
    expect(mutation.requests).toEqual([
      { type: "GetSceneList" },
      { type: "GetInputList" },
      {
        data: {
          inputKind: "macos-avcapture",
          inputName: "Phone",
          inputSettings: { device: "phone-camera-device" },
          sceneItemEnabled: true,
          sceneName: "Devices",
        },
        type: "CreateInput",
      },
    ]);
  });

  it("normalizes intended output dimensions to encoder-safe even pixels", () => {
    expect(alignEncoderDimensions({ height: 1_080, width: 1_919 })).toEqual({
      adjusted: true,
      alignment: 2,
      height: 1_080,
      width: 1_920,
    });
    expect(() => alignEncoderDimensions({ height: 0, width: 100 })).toThrow("Encoder dimensions");
  });

  it("retains a recovery point when OBS updates an input but rejects its later scene attachment", async () => {
    const sourceRef = encodeInputRef("screen-input-uuid");
    const discovery = discoverySocket({ inputName: "Screen", inputUuid: "screen-input-uuid", configuredWindow: 41 });
    const mutation = new FakeSocket((request) => {
      if (request.type === "GetCurrentProgramScene") {
        return { currentProgramSceneName: "Record", currentProgramSceneUuid: "scene-uuid" };
      }
      if (request.type === "GetInputList") {
        return { inputs: [{ inputKind: "screen_capture", inputName: "Screen", inputUuid: "screen-input-uuid" }] };
      }
      if (request.type === "GetInputSettings") return { inputSettings: { type: 1, window: 41 } };
      if (request.type === "SetInputSettings") return {};
      if (request.type === "GetSceneItemList") return { sceneItems: [] };
      if (request.type === "CreateSceneItem") throw Object.assign(new Error("scene locked"), { code: 500 });
      throw new Error(`Unexpected configuration request ${request.type}`);
    });
    const sockets = [discovery, mutation];

    let partial: CaptureConfigurationPartialError | undefined;
    try {
      await configureCaptureTarget(config, { sourceRef, targetRef: windowTargetRef }, () => nextSocket(sockets));
    } catch (error) {
      if (error instanceof CaptureConfigurationPartialError) partial = error;
      else throw error;
    }

    expect(partial).toBeInstanceOf(CaptureConfigurationPartialError);
    if (!partial) throw new Error("Expected a partial configuration error.");
    expect(partial?.outcome).toBe("scene_attachment_rejected");
    expect(partial?.configuration.configuredSource).toMatchObject({
      configurationState: "partial_recovery_required",
      recovery: {
        input: "restore_previous_target",
        mutationOutcome: "scene_attachment_rejected",
        sceneItem: "manual_confirmation_required",
      },
      source: { sourceRef, configuredTargetRef: windowTargetRef },
    });
    const store = new CaptureSessionStore();
    store.record(partial.configuration.configuredSource, partial.configuration.restoreSnapshot);
    expect(store.read().configuredSources[0]?.configurationState).toBe("partial_recovery_required");
  });

  it("keeps OBS credentials out of configuration results and session reads", async () => {
    const sourceRef = encodeInputRef("screen-input-uuid");
    const discovery = discoverySocket({ inputName: "Screen", inputUuid: "screen-input-uuid", configuredWindow: 41 });
    const mutation = new FakeSocket((request) => {
      if (request.type === "GetCurrentProgramScene") {
        return { currentProgramSceneName: "Record", currentProgramSceneUuid: "scene-uuid" };
      }
      if (request.type === "GetInputList") {
        return { inputs: [{ inputKind: "screen_capture", inputName: "Screen", inputUuid: "screen-input-uuid" }] };
      }
      if (request.type === "GetInputSettings") return { inputSettings: { type: 1, window: 41 } };
      if (request.type === "SetInputSettings") return {};
      if (request.type === "GetSceneItemList") return { sceneItems: [{ sceneItemId: 8, sourceUuid: "screen-input-uuid" }] };
      throw new Error(`Unexpected configuration request ${request.type}`);
    });
    const sockets = [discovery, mutation];
    const result = await configureCaptureTarget(config, { sourceRef, targetRef: windowTargetRef }, () => nextSocket(sockets));
    const store = new CaptureSessionStore();
    store.record(result.configuredSource, result.restoreSnapshot);

    expect(JSON.stringify({ result, session: store.read() })).not.toContain(config.password);
    expect(mutation.connectedWith?.password).toBe(config.password);
  });
});

function discoverySocket(options: {
  configuredCamera?: string;
  configuredWindow?: number;
  inputKind?: "macos-avcapture" | "screen_capture";
  inputName: string;
  inputUuid: string;
}): FakeSocket {
  return new FakeSocket((request) => {
    if (request.type === "GetInputList") {
      return { inputs: [{ inputKind: options.inputKind ?? "screen_capture", inputName: options.inputName, inputUuid: options.inputUuid }] };
    }
    if (request.type === "GetInputSettings") {
      return options.inputKind === "macos-avcapture"
        ? { inputSettings: { device: options.configuredCamera, device_name: "Phone camera" } }
        : { inputSettings: { type: 1, window: options.configuredWindow } };
    }
    if (request.type === "GetInputPropertiesListPropertyItems") {
      return { propertyItems: [{ itemEnabled: true, itemName: "Terminal", itemValue: 42 }] };
    }
    throw new Error(`Unexpected discovery request ${request.type}`);
  });
}

function nextSocket(sockets: FakeSocket[]): FakeSocket {
  const socket = sockets.shift();
  if (!socket) throw new Error("Unexpected extra OBS connection");
  return socket;
}
