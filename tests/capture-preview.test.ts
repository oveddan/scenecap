import { describe, expect, it } from "vitest";

import { previewCaptureTarget } from "../server/capture-preview.js";
import { encodeCaptureTargetRef } from "../server/capture-targets.js";
import type { ObsConnectionOptions, ObsRequest, ObsSocket } from "../server/obs.js";

const config = { host: "127.0.0.1", password: "preview-secret", port: 4455 } as const;
const targetRef = encodeCaptureTargetRef("window", 42);

class PreviewSocket implements ObsSocket {
  readonly requests: ObsRequest[] = [];
  connectedWith?: ObsConnectionOptions;
  disconnected = false;

  constructor(
    readonly responder: (request: ObsRequest) => unknown | Promise<unknown>,
    readonly activeOutput?: "GetStreamStatus" | "GetRecordStatus" | "GetReplayBufferStatus" | "GetVirtualCamStatus",
    readonly programSceneUuid = "program-scene-uuid",
    readonly hangDisconnect = false,
    readonly unavailableOutput?: "GetReplayBufferStatus" | "GetVirtualCamStatus",
  ) {}

  async connect(options: ObsConnectionOptions): Promise<void> {
    this.connectedWith = options;
  }

  async request(request: ObsRequest): Promise<unknown> {
    this.requests.push(request);
    if (
      request.type === "GetStreamStatus"
      || request.type === "GetRecordStatus"
      || request.type === "GetReplayBufferStatus"
      || request.type === "GetVirtualCamStatus"
    ) {
      if (request.type === this.unavailableOutput) {
        const label = request.type === "GetReplayBufferStatus" ? "Replay buffer" : "Virtual camera";
        throw Object.assign(new Error(`${label} is not available.`), { code: 604 });
      }
      return { outputActive: request.type === this.activeOutput };
    }
    if (request.type === "GetCurrentProgramScene") return { sceneUuid: this.programSceneUuid };
    return this.responder(request);
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
    if (this.hangDisconnect) return new Promise<never>(() => undefined);
  }
}

describe("previewCaptureTarget", () => {
  it("requires a canonical discovered target reference before connecting to a preview source", async () => {
    let created = 0;
    await expect(previewCaptureTarget(config, "scenecap-target-v1.not-json", () => {
      created += 1;
      return new PreviewSocket(() => ({}));
    })).rejects.toMatchObject({ kind: "invalid_reference" });
    expect(created).toBe(0);
  });

  it("rejects a valid but stale reference before opening a preview connection or mutating OBS", async () => {
    const discovery = discoverySocket({ listedWindow: 43 });
    let connections = 0;
    await expect(previewCaptureTarget(config, targetRef, () => {
      connections += 1;
      return nextSocket([discovery]);
    })).rejects.toMatchObject({ kind: "stale_reference" });
    expect(connections).toBe(1);
    expect(discovery.requests.map((request) => request.type)).not.toContain("CreateInput");
  });

  it("screenshots a matching configured source by UUID without creating temporary OBS resources", async () => {
    const discovery = discoverySocket({ configuredWindow: 42, listedWindow: 42 });
    const screenshot = new PreviewSocket((request) => {
      expect(request).toEqual({
        data: {
          imageCompressionQuality: 75,
          imageFormat: "jpg",
          imageHeight: 540,
          imageWidth: 960,
          sourceUuid: "configured-input-uuid",
        },
        type: "GetSourceScreenshot",
      });
      const imageData = jpegDataUrl(960, 540, 512);
      expect(imageData.length).toBeGreaterThan(300);
      return { imageData };
    });
    const sockets = [discovery, screenshot];

    const result = await previewCaptureTarget(config, targetRef, () => nextSocket(sockets));

    expect(result).toMatchObject({
      image: { height: 540, mimeType: "image/jpeg", width: 960 },
      previewMethod: "configured_source",
      target: { targetRef },
    });
    expect(screenshot.requests).toHaveLength(1);
    expect(discovery.requests.map((request) => request.type)).toEqual([
      "GetInputList",
      "GetInputSettings",
      "GetInputPropertiesListPropertyItems",
    ]);
    expect(screenshot.disconnected).toBe(true);
    expect(JSON.stringify(result)).not.toContain("preview-secret");
  });

  it("uses a disabled isolated window probe and removes it before returning its image", async () => {
    const discovery = discoverySocket({ listedWindow: 42 });
    let inputName = "";
    let sceneName = "";
    const primary = new PreviewSocket((request) => {
      if (request.type === "CreateScene") {
        sceneName = request.data.sceneName;
        return { sceneUuid: "temporary-scene-uuid" };
      }
      if (request.type === "CreateInput") {
        inputName = request.data.inputName;
        expect(request.data).toMatchObject({
          inputKind: "screen_capture",
          inputSettings: { show_cursor: false, type: 1, window: 42 },
          sceneItemEnabled: false,
          sceneName,
        });
        return { inputUuid: "temporary-input-uuid", sceneItemId: 7 };
      }
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
      if (request.type === "SetStudioModeEnabled") return {};
      if (request.type === "GetCurrentPreviewScene") return { currentPreviewSceneUuid: "previous-preview-uuid" };
      if (request.type === "SetCurrentPreviewScene") return {};
      if (request.type === "SetSceneItemEnabled") return {};
      if (request.type === "GetSourceScreenshot") {
        expect(request.data.sourceUuid).toBe("temporary-input-uuid");
        return { imageData: jpegDataUrl(320, 180) };
      }
      throw new Error(`Unexpected primary request ${request.type}`);
    });
    let inputRemoved = false;
    let sceneRemoved = false;
    const cleanup = new PreviewSocket((request) => {
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: true };
      if (request.type === "GetCurrentPreviewScene") return { currentPreviewSceneUuid: "temporary-scene-uuid" };
      if (request.type === "GetInputList") {
        return { inputs: inputRemoved ? [] : [{ inputName, inputUuid: "temporary-input-uuid" }] };
      }
      if (request.type === "SetSceneItemEnabled") {
        expect(request.data).toEqual({ sceneItemEnabled: false, sceneItemId: 7, sceneName });
        return {};
      }
      if (request.type === "SetCurrentPreviewScene") {
        expect(request.data).toEqual({ sceneUuid: "previous-preview-uuid" });
        return {};
      }
      if (request.type === "SetStudioModeEnabled") {
        expect(request.data).toEqual({ studioModeEnabled: false });
        return {};
      }
      if (request.type === "RemoveInput") {
        expect(request.data).toEqual({ inputUuid: "temporary-input-uuid" });
        inputRemoved = true;
        return {};
      }
      if (request.type === "GetSceneList") return { scenes: sceneRemoved ? [] : [{ sceneName }] };
      if (request.type === "RemoveScene") {
        expect(request.data).toEqual({ sceneName });
        sceneRemoved = true;
        return {};
      }
      throw new Error(`Unexpected cleanup request ${request.type}`);
    });
    const sockets = [discovery, primary, cleanup, emptyVerificationSocket()];

    const result = await previewCaptureTarget(config, targetRef, () => nextSocket(sockets));

    expect(result).toMatchObject({
      image: { height: 180, width: 320 },
      previewMethod: "temporary_window_probe",
    });
    expect(sceneName).toMatch(/^__scenecap_preview_scene_[0-9a-f-]{36}$/);
    expect(inputName).toMatch(/^__scenecap_preview_input_[0-9a-f-]{36}$/);
    expect(primary.requests.map((request) => request.type)).toEqual([
      "GetStudioModeEnabled",
      "GetStreamStatus",
      "GetRecordStatus",
      "GetReplayBufferStatus",
      "GetVirtualCamStatus",
      "GetCurrentProgramScene",
      "CreateScene",
      "CreateInput",
      "GetStudioModeEnabled",
      "GetStreamStatus",
      "GetRecordStatus",
      "GetReplayBufferStatus",
      "GetVirtualCamStatus",
      "GetCurrentProgramScene",
      "SetStudioModeEnabled",
      "GetCurrentPreviewScene",
      "SetCurrentPreviewScene",
      "SetSceneItemEnabled",
      "GetSourceScreenshot",
    ]);
    expect(cleanup.requests.map((request) => request.type)).toEqual([
      "GetCurrentProgramScene",
      "GetStudioModeEnabled",
      "GetCurrentPreviewScene",
      "SetSceneItemEnabled",
      "SetCurrentPreviewScene",
      "SetStudioModeEnabled",
      "RemoveInput",
      "RemoveScene",
    ]);
    expect(primary.disconnected).toBe(true);
    expect(cleanup.disconnected).toBe(true);
  });

  it("uses a fresh cleanup connection after a timed-out probe request and still removes both resources", async () => {
    const discovery = discoverySocket({ listedWindow: 42 });
    let inputName = "";
    let sceneName = "";
    const primary = new PreviewSocket((request) => {
      if (request.type === "CreateScene") {
        sceneName = request.data.sceneName;
        return { sceneUuid: "temporary-scene-uuid" };
      }
      if (request.type === "CreateInput") {
        inputName = request.data.inputName;
        return { inputUuid: "temporary-input-uuid", sceneItemId: 7 };
      }
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
      if (request.type === "SetStudioModeEnabled") return {};
      if (request.type === "GetCurrentPreviewScene") return { currentPreviewSceneUuid: "previous-preview-uuid" };
      if (request.type === "SetCurrentPreviewScene") return {};
      if (request.type === "SetSceneItemEnabled") return {};
      if (request.type === "GetSourceScreenshot") return new Promise<never>(() => undefined);
      throw new Error(`Unexpected primary request ${request.type}`);
    });
    const cleanup = cleanupSocket(() => inputName, () => sceneName);
    const sockets = [discovery, primary, cleanup, emptyVerificationSocket()];

    await expect(previewCaptureTarget(config, targetRef, () => nextSocket(sockets), { timeoutMs: 80 }))
      .rejects.toMatchObject({ kind: "timeout" });

    expect(primary.disconnected).toBe(true);
    expect(cleanup.connectedWith).toEqual({
      address: "ws://127.0.0.1:4455",
      eventSubscriptions: 0,
      password: "preview-secret",
    });
    expect(cleanup.requests.map((request) => request.type)).toEqual([
      "GetCurrentProgramScene",
      "GetStudioModeEnabled",
      "RemoveInput",
      "RemoveScene",
    ]);
  });

  it("fails closed without creating resources when Studio Mode is already enabled", async () => {
    const discovery = discoverySocket({ listedWindow: 42 });
    let inputName = "";
    let sceneName = "";
    const primary = new PreviewSocket((request) => {
      if (request.type === "CreateScene") {
        sceneName = request.data.sceneName;
        return { sceneUuid: "temporary-scene-uuid" };
      }
      if (request.type === "CreateInput") {
        inputName = request.data.inputName;
        return { inputUuid: "temporary-input-uuid", sceneItemId: 7 };
      }
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: true };
      if (request.type === "GetCurrentPreviewScene") return { currentPreviewSceneUuid: "previous-preview-uuid" };
      if (request.type === "SetCurrentPreviewScene" || request.type === "SetSceneItemEnabled") return {};
      if (request.type === "GetSourceScreenshot") return { imageData: jpegDataUrl(10, 10) };
      throw new Error(`Unexpected original-Studio-Mode request ${request.type}`);
    });
    let sceneRemoved = false;
    const cleanup = new PreviewSocket((request) => {
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
      if (request.type === "SetSceneItemEnabled" || request.type === "SetCurrentPreviewScene") return {};
      if (request.type === "GetInputList") return { inputs: [{ inputName, inputUuid: "temporary-input-uuid" }] };
      if (request.type === "RemoveInput") return {};
      if (request.type === "GetSceneList") return { scenes: sceneRemoved ? [] : [{ sceneName }] };
      if (request.type === "RemoveScene") {
        sceneRemoved = true;
        return {};
      }
      throw new Error(`Unexpected original-Studio-Mode cleanup ${request.type}`);
    });
    const sockets = [discovery, primary, cleanup, emptyVerificationSocket()];

    await expect(previewCaptureTarget(config, targetRef, () => nextSocket(sockets))).rejects.toMatchObject({
      kind: "preview_unavailable",
    });
    expect(primary.requests).toEqual([{ type: "GetStudioModeEnabled" }]);
    expect(cleanup.requests).toEqual([]);
  });

  it("fails closed before resource creation while any OBS output is active", async () => {
    const discovery = discoverySocket({ listedWindow: 42 });
    const primary = new PreviewSocket(
      (request) => {
        if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
        throw new Error(`Unexpected active-output request ${request.type}`);
      },
      "GetRecordStatus",
    );
    const sockets = [discovery, primary];

    await expect(previewCaptureTarget(config, targetRef, () => nextSocket(sockets))).rejects.toMatchObject({
      kind: "preview_unavailable",
    });
    expect(primary.requests.map((request) => request.type)).toEqual([
      "GetStudioModeEnabled",
      "GetStreamStatus",
      "GetRecordStatus",
    ]);
  });

  it("does not invent cleanup work after a definitive CreateScene rejection", async () => {
    const discovery = discoverySocket({ listedWindow: 42 });
    const rejection = Object.assign(new Error("scene rejected"), { code: 500 });
    const primary = new PreviewSocket((request) => {
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
      if (request.type === "CreateScene") throw rejection;
      throw new Error(`Unexpected rejected-scene request ${request.type}`);
    });
    const sockets = [discovery, primary];

    await expect(previewCaptureTarget(config, targetRef, () => nextSocket(sockets))).rejects.toBe(rejection);
    expect(primary.requests.map((request) => request.type)).not.toContain("CreateInput");
    expect(sockets).toEqual([]);
  });

  it("removes only the confirmed scene after a definitive CreateInput rejection", async () => {
    const discovery = discoverySocket({ listedWindow: 42 });
    const rejection = Object.assign(new Error("input rejected"), { code: 601 });
    let sceneName = "";
    const primary = new PreviewSocket((request) => {
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
      if (request.type === "CreateScene") {
        sceneName = request.data.sceneName;
        return { sceneUuid: "temporary-scene-uuid" };
      }
      if (request.type === "CreateInput") throw rejection;
      throw new Error(`Unexpected rejected-input request ${request.type}`);
    });
    const cleanup = new PreviewSocket((request) => {
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
      if (request.type === "RemoveScene") {
        expect(request.data).toEqual({ sceneName });
        return {};
      }
      throw new Error(`Unexpected rejected-input cleanup request ${request.type}`);
    });
    const sockets = [discovery, primary, cleanup, emptyVerificationSocket()];

    await expect(previewCaptureTarget(config, targetRef, () => nextSocket(sockets))).rejects.toBe(rejection);
    expect(cleanup.requests.map((request) => request.type)).not.toContain("RemoveInput");
    expect(cleanup.requests.map((request) => request.type)).toContain("RemoveScene");
  });

  it.each(["GetReplayBufferStatus", "GetVirtualCamStatus"] as const)(
    "treats a recognized unavailable %s status as inactive",
    async (unavailableOutput) => {
      const discovery = discoverySocket({ listedWindow: 42 });
      const primary = temporaryPrimary(false, unavailableOutput);
      const cleanup = new PreviewSocket((request) => {
        if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
        if (request.type === "GetInputList") return { inputs: [] };
        if (request.type === "GetSceneList") return { scenes: [] };
        if (request.type === "RemoveInput" || request.type === "RemoveScene") return {};
        throw new Error(`Unexpected optional-output cleanup request ${request.type}`);
      });
      const sockets = [discovery, primary, cleanup, emptyVerificationSocket()];

      await expect(previewCaptureTarget(config, targetRef, () => nextSocket(sockets))).resolves.toMatchObject({
        previewMethod: "temporary_window_probe",
      });
      expect(primary.requests.map((request) => request.type)).toContain(unavailableOutput);
    },
  );

  it("does not overwrite or remove a temporary scene promoted to Program", async () => {
    const discovery = discoverySocket({ listedWindow: 42 });
    const primary = temporaryPrimary();
    const cleanup = new PreviewSocket(
      (request) => {
        throw new Error(`No cleanup mutation is safe after Program promotion: ${request.type}`);
      },
      undefined,
      "temporary-scene-uuid",
    );
    const sockets = [discovery, primary, cleanup, emptyVerificationSocket()];

    await expect(previewCaptureTarget(config, targetRef, () => nextSocket(sockets))).rejects.toMatchObject({
      failures: ["program_scene"],
    });
    expect(cleanup.requests.map((request) => request.type)).toEqual(["GetCurrentProgramScene"]);
  });

  it("starts fresh-connection cleanup after a primary disconnect hangs", async () => {
    const discovery = discoverySocket({ listedWindow: 42 });
    const primary = temporaryPrimary(true);
    const cleanup = new PreviewSocket((request) => {
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
      if (request.type === "GetInputList") return { inputs: [] };
      if (request.type === "GetSceneList") return { scenes: [] };
      if (request.type === "RemoveInput" || request.type === "RemoveScene") return {};
      throw new Error(`Unexpected hanging-disconnect cleanup request ${request.type}`);
    });
    const sockets = [discovery, primary, cleanup, emptyVerificationSocket()];

    await expect(previewCaptureTarget(config, targetRef, () => nextSocket(sockets))).resolves.toMatchObject({
      previewMethod: "temporary_window_probe",
    });
    expect(cleanup.requests.map((request) => request.type)).toContain("GetCurrentProgramScene");
    expect(primary.disconnected).toBe(true);
  }, 5_000);

  it("removes an aborted queued waiter without allowing a later waiter to bypass the holder", async () => {
    let firstCreate!: () => void;
    const firstCreated = new Promise<void>((resolve) => {
      firstCreate = resolve;
    });
    let createCount = 0;
    const factory = () => new PreviewSocket((request) => {
      if (request.type === "GetInputList") {
        return { inputs: [{ inputKind: "screen_capture", inputName: "Probe", inputUuid: "configured-input-uuid" }] };
      }
      if (request.type === "GetInputSettings") return { inputSettings: { type: 1 } };
      if (request.type === "GetInputPropertiesListPropertyItems") {
        return { propertyItems: [{ itemEnabled: true, itemName: "Terminal", itemValue: 42 }] };
      }
      if (request.type === "CreateScene") {
        createCount += 1;
        if (createCount === 1) firstCreate();
        return { sceneUuid: `temporary-scene-${createCount}` };
      }
      if (request.type === "CreateInput") return { inputUuid: `uuid-${request.data.sceneName}`, sceneItemId: 7 };
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
      if (request.type === "SetStudioModeEnabled") return {};
      if (request.type === "GetCurrentPreviewScene") return { currentPreviewSceneUuid: "previous-preview-uuid" };
      if (request.type === "SetCurrentPreviewScene" || request.type === "SetSceneItemEnabled") return {};
      if (request.type === "GetSourceScreenshot") return { imageData: jpegDataUrl(10, 10) };
      if (request.type === "GetSceneList") return { scenes: [] };
      if (request.type === "RemoveInput" || request.type === "RemoveScene") return {};
      throw new Error(`Unexpected lock-order request ${request.type}`);
    });
    const first = previewCaptureTarget(config, targetRef, factory);
    await firstCreated;
    const controller = new AbortController();
    const cancelled = previewCaptureTarget(config, targetRef, factory, { signal: controller.signal });
    await delay(20);
    controller.abort();
    const third = previewCaptureTarget(config, targetRef, factory);

    await expect(cancelled).rejects.toMatchObject({ kind: "cancelled" });
    await expect(Promise.all([first, third])).resolves.toHaveLength(2);
    expect(createCount).toBe(2);
  }, 8_000);

  it("detects an external Preview conflict without overwriting Preview or Studio Mode", async () => {
    const discovery = discoverySocket({ listedWindow: 42 });
    const primary = temporaryPrimary();
    const cleanup = new PreviewSocket((request) => {
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: true };
      if (request.type === "GetCurrentPreviewScene") return { currentPreviewSceneUuid: "operator-preview-uuid" };
      if (request.type === "GetInputList") return { inputs: [] };
      if (request.type === "GetSceneList") return { scenes: [] };
      throw new Error(`Unexpected conflict cleanup mutation ${request.type}`);
    });
    const sockets = [discovery, primary, cleanup, emptyVerificationSocket()];

    await expect(previewCaptureTarget(config, targetRef, () => nextSocket(sockets))).rejects.toMatchObject({
      failures: expect.arrayContaining(["preview_scene", "studio_mode"]),
    });
    expect(cleanup.requests.map((request) => request.type)).not.toContain("SetCurrentPreviewScene");
    expect(cleanup.requests.map((request) => request.type)).not.toContain("SetStudioModeEnabled");
  });

  it("cleans generated resources after cancellation during a remotely ambiguous CreateInput", async () => {
    const controller = new AbortController();
    const discovery = discoverySocket({ listedWindow: 42 });
    let inputName = "";
    let sceneName = "";
    const primary = new PreviewSocket((request) => {
      if (request.type === "CreateScene") {
        sceneName = request.data.sceneName;
        return { sceneUuid: "temporary-scene-uuid" };
      }
      if (request.type === "CreateInput") {
        inputName = request.data.inputName;
        controller.abort();
        return new Promise<never>(() => undefined);
      }
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
      throw new Error(`Unexpected primary request ${request.type}`);
    });
    let inputListReads = 0;
    let inputRemoved = false;
    let sceneRemoved = false;
    const cleanup = new PreviewSocket((request) => {
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
      if (request.type === "GetInputList") {
        inputListReads += 1;
        return {
          inputs: inputListReads < 3 || inputRemoved
            ? []
            : [{ inputName, inputUuid: "temporary-input-uuid" }],
        };
      }
      if (request.type === "RemoveInput") {
        inputRemoved = true;
        return {};
      }
      if (request.type === "RemoveScene") {
        sceneRemoved = true;
        return {};
      }
      if (request.type === "GetSceneList") return { scenes: sceneRemoved ? [] : [{ sceneName }] };
      throw new Error(`Unexpected ambiguous cleanup request ${request.type}`);
    });
    const sockets = [discovery, primary, cleanup, emptyVerificationSocket()];

    await expect(previewCaptureTarget(config, targetRef, () => nextSocket(sockets), { signal: controller.signal }))
      .rejects.toMatchObject({ kind: "cancelled" });
    expect(cleanup.requests.map((request) => request.type)).toEqual([
      "GetCurrentProgramScene",
      "GetStudioModeEnabled",
      "GetInputList",
      "GetInputList",
      "GetInputList",
      "RemoveInput",
      "RemoveScene",
    ]);
  });

  it("suppresses an otherwise successful image when temporary cleanup is incomplete", async () => {
    const discovery = discoverySocket({ listedWindow: 42 });
    let inputName = "";
    let sceneName = "";
    let sceneRemoved = false;
    const primary = new PreviewSocket((request) => {
      if (request.type === "CreateScene") {
        sceneName = request.data.sceneName;
        return { sceneUuid: "temporary-scene-uuid" };
      }
      if (request.type === "CreateInput") {
        inputName = request.data.inputName;
        return { inputUuid: "temporary-input-uuid", sceneItemId: 7 };
      }
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
      if (request.type === "SetStudioModeEnabled") return {};
      if (request.type === "GetCurrentPreviewScene") return { currentPreviewSceneUuid: "previous-preview-uuid" };
      if (request.type === "SetCurrentPreviewScene") return {};
      if (request.type === "SetSceneItemEnabled") return {};
      if (request.type === "GetSourceScreenshot") return { imageData: jpegDataUrl(10, 10) };
      throw new Error(`Unexpected primary request ${request.type}`);
    });
    const cleanup = new PreviewSocket((request) => {
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
      if (request.type === "SetSceneItemEnabled") return {};
      if (request.type === "SetCurrentPreviewScene") return {};
      if (request.type === "SetStudioModeEnabled") return {};
      if (request.type === "GetInputList") throw new Error("cleanup input query failed");
      if (request.type === "GetSceneList") return { scenes: sceneRemoved ? [] : [{ sceneName }] };
      if (request.type === "RemoveScene") {
        sceneRemoved = true;
        return {};
      }
      throw new Error(`Unexpected cleanup request ${request.type}`);
    });
    const verifier = new PreviewSocket((request) => {
      if (request.type === "GetInputList") {
        return { inputs: [{ inputName, inputUuid: "temporary-input-uuid" }] };
      }
      if (request.type === "GetSceneList") return { scenes: [] };
      throw new Error(`Unexpected incomplete-cleanup verification request ${request.type}`);
    });
    const sockets = [discovery, primary, cleanup, verifier];

    // The rejected promise establishes no image is returned; the error exposes
    // only generated names suitable for manual cleanup.
    await expect(previewCaptureTarget(config, targetRef, () => nextSocket(sockets))).rejects.toMatchObject({
      failures: ["input"],
      identifiers: {
        inputName: expect.stringMatching(/^__scenecap_preview_input_/),
        sceneName: expect.stringMatching(/^__scenecap_preview_scene_/),
      },
    });
    expect(cleanup.requests.map((request) => request.type)).toEqual(expect.arrayContaining([
      "GetCurrentProgramScene",
      "GetStudioModeEnabled",
      "RemoveInput",
      "RemoveScene",
    ]));
  });

  it("accepts fresh proof of absence when removal responses are lost", async () => {
    const discovery = discoverySocket({ listedWindow: 42 });
    const primary = temporaryPrimary();
    const cleanup = new PreviewSocket((request) => {
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
      if (request.type === "RemoveInput") throw new Error("input response lost");
      if (request.type === "RemoveScene") throw new Error("scene response lost");
      throw new Error(`Unexpected lost-response cleanup request ${request.type}`);
    });
    const sockets = [discovery, primary, cleanup, emptyVerificationSocket()];

    await expect(previewCaptureTarget(config, targetRef, () => nextSocket(sockets))).resolves.toMatchObject({
      previewMethod: "temporary_window_probe",
    });
  });

  it("serializes temporary probes so concurrent sessions cannot overlap Studio Mode state", async () => {
    const activeScenes = new Set<string>();
    const removedInputs = new Set<string>();
    let maxActiveScenes = 0;
    const factory = () => new PreviewSocket((request) => {
      if (request.type === "GetInputList") {
        return {
          inputs: [
            { inputKind: "screen_capture", inputName: "Probe", inputUuid: "configured-input-uuid" },
            ...[...activeScenes]
              .map((sceneName) => ({
              inputName: sceneName.replace("_scene_", "_input_"),
              inputUuid: `uuid-${sceneName}`,
              }))
              .filter((input) => !removedInputs.has(input.inputName)),
          ],
        };
      }
      if (request.type === "GetInputSettings") return { inputSettings: { type: 1 } };
      if (request.type === "GetInputPropertiesListPropertyItems") {
        return { propertyItems: [{ itemEnabled: true, itemName: "Terminal", itemValue: 42 }] };
      }
      if (request.type === "CreateScene") {
        activeScenes.add(request.data.sceneName);
        maxActiveScenes = Math.max(maxActiveScenes, activeScenes.size);
        return { sceneUuid: request.data.sceneName };
      }
      if (request.type === "CreateInput") return { inputUuid: `uuid-${request.data.inputName}`, sceneItemId: 7 };
      if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
      if (request.type === "SetStudioModeEnabled") return {};
      if (request.type === "GetCurrentPreviewScene") return { currentPreviewSceneUuid: "previous-preview-uuid" };
      if (request.type === "SetCurrentPreviewScene") return {};
      if (request.type === "SetSceneItemEnabled") return {};
      if (request.type === "GetSourceScreenshot") return { imageData: jpegDataUrl(10, 10) };
      if (request.type === "RemoveInput") {
        if (request.data.inputUuid?.startsWith("uuid-")) {
          removedInputs.add(request.data.inputUuid.slice("uuid-".length));
        }
        return {};
      }
      if (request.type === "GetSceneList") return { scenes: [...activeScenes].map((sceneName) => ({ sceneName })) };
      if (request.type === "RemoveScene") {
        activeScenes.delete(request.data.sceneName);
        return {};
      }
      throw new Error(`Unexpected serialized preview request ${request.type}`);
    });

    await expect(Promise.all([
      previewCaptureTarget(config, targetRef, factory),
      previewCaptureTarget(config, targetRef, factory),
    ])).resolves.toHaveLength(2);
    expect(maxActiveScenes).toBe(1);
    expect(activeScenes).toEqual(new Set());
  });

  it.each([
    ["malformed base64", "data:image/jpeg;base64,not-base64"],
    ["wrong MIME", jpegDataUrl(10, 10).replace("image/jpeg", "image/png")],
    ["zero JPEG dimensions", jpegDataUrl(0, 10)],
    ["oversized JPEG dimensions", jpegDataUrl(961, 540)],
    ["oversized base64", `data:image/jpeg;base64,${"A".repeat(2_796_204)}`],
  ])("rejects a %s screenshot payload", async (_case, imageData) => {
    const discovery = discoverySocket({ configuredWindow: 42, listedWindow: 42 });
    const screenshot = new PreviewSocket(() => ({ imageData }));
    const sockets = [discovery, screenshot];
    await expect(previewCaptureTarget(config, targetRef, () => nextSocket(sockets)))
      .rejects.toMatchObject({ kind: "preview_unavailable" });
  });
});

function discoverySocket({ configuredWindow, listedWindow }: { configuredWindow?: number; listedWindow: number }): PreviewSocket {
  return new PreviewSocket((request) => {
    if (request.type === "GetInputList") {
      return {
        inputs: [{ inputKind: "screen_capture", inputName: "Capture", inputUuid: "configured-input-uuid" }],
      };
    }
    if (request.type === "GetInputSettings") {
      return { inputSettings: { type: 1, ...(configuredWindow ? { window: configuredWindow } : {}) } };
    }
    if (request.type === "GetInputPropertiesListPropertyItems") {
      return { propertyItems: [{ itemEnabled: true, itemName: "Terminal", itemValue: listedWindow }] };
    }
    throw new Error(`Unexpected discovery request ${request.type}`);
  });
}

function cleanupSocket(inputName: () => string, sceneName: () => string): PreviewSocket {
  let inputRemoved = false;
  let sceneRemoved = false;
  return new PreviewSocket((request) => {
    if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
    if (request.type === "SetSceneItemEnabled") return {};
    if (request.type === "SetCurrentPreviewScene") return {};
    if (request.type === "SetStudioModeEnabled") return {};
    if (request.type === "GetInputList") {
      return { inputs: inputRemoved ? [] : [{ inputName: inputName(), inputUuid: "temporary-input-uuid" }] };
    }
    if (request.type === "RemoveInput") {
      inputRemoved = true;
      return {};
    }
    if (request.type === "GetSceneList") return { scenes: sceneRemoved ? [] : [{ sceneName: sceneName() }] };
    if (request.type === "RemoveScene") {
      sceneRemoved = true;
      return {};
    }
    throw new Error(`Unexpected cleanup request ${request.type}`);
  });
}

function emptyVerificationSocket(): PreviewSocket {
  return new PreviewSocket((request) => {
    if (request.type === "GetInputList") return { inputs: [] };
    if (request.type === "GetSceneList") return { scenes: [] };
    throw new Error(`Unexpected verification request ${request.type}`);
  });
}

function temporaryPrimary(
  hangDisconnect = false,
  unavailableOutput?: "GetReplayBufferStatus" | "GetVirtualCamStatus",
): PreviewSocket {
  return new PreviewSocket((request) => {
    if (request.type === "CreateScene") return { sceneUuid: "temporary-scene-uuid" };
    if (request.type === "CreateInput") return { inputUuid: "temporary-input-uuid", sceneItemId: 7 };
    if (request.type === "GetStudioModeEnabled") return { studioModeEnabled: false };
    if (request.type === "SetStudioModeEnabled") return {};
    if (request.type === "GetCurrentPreviewScene") return { currentPreviewSceneUuid: "previous-preview-uuid" };
    if (request.type === "SetCurrentPreviewScene" || request.type === "SetSceneItemEnabled") return {};
    if (request.type === "GetSourceScreenshot") return { imageData: jpegDataUrl(10, 10) };
    throw new Error(`Unexpected temporary primary request ${request.type}`);
  }, undefined, "program-scene-uuid", hangDisconnect, unavailableOutput);
}

function nextSocket(sockets: PreviewSocket[]): PreviewSocket {
  const socket = sockets.shift();
  if (!socket) throw new Error("Unexpected extra OBS connection");
  return socket;
}

function jpegDataUrl(width: number, height: number, padding = 0): string {
  const appSegment = padding > 0
    ? [0xff, 0xe0, (padding + 2) >> 8, (padding + 2) & 0xff, ...new Array<number>(padding).fill(0)]
    : [];
  const bytes = Buffer.from([
    0xff, 0xd8,
    ...appSegment,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff,
    width >> 8, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
