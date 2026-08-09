import { describe, expect, it } from "vitest";

import { CaptureSessionStore, type ConfiguredCaptureSource } from "../server/capture-session.js";
import { encodeCaptureTargetRef, encodeInputRef } from "../server/capture-targets.js";
import { RecordingControlError, startRecording, stopRecording } from "../server/recording.js";
import type { ObsConnectionOptions, ObsRequest, ObsSocket } from "../server/obs.js";

const config = { host: "127.0.0.1", password: "recording-secret", port: 4455 } as const;
const sourceRef = encodeInputRef("camera-input-uuid");
const targetRef = encodeCaptureTargetRef("camera", "phone-camera");

class FakeSocket implements ObsSocket {
  readonly requests: ObsRequest[] = [];
  connectedWith?: ObsConnectionOptions;

  constructor(readonly responder: (request: ObsRequest) => unknown | Promise<unknown>) {}

  async connect(options: ObsConnectionOptions): Promise<void> { this.connectedWith = options; }
  async request(request: ObsRequest): Promise<unknown> { this.requests.push(request); return this.responder(request); }
  disconnect(): void {}
}

describe("recording controls", () => {
  it("starts only a current configured session, then stops and reports OBS's global output path", async () => {
    const store = configuredStore();
    const discovery = configuredDiscoverySocket();
    const start = new FakeSocket(statusSequence(false, undefined, true));
    const stop = new FakeSocket(statusSequence(true, "/private/tmp/scenecap-recording-test.mp4", false));
    const sockets = [discovery, start, stop];

    const started = await store.runExclusive(() => startRecording(config, store, () => nextSocket(sockets)));
    expect(started.recording).toMatchObject({ configuredSourceRefs: [sourceRef], state: "active" });
    expect(start.requests).toEqual([{ type: "GetRecordStatus" }, { type: "StartRecord" }, { type: "GetRecordStatus" }]);

    const stopped = await store.runExclusive(() => stopRecording(config, store, () => nextSocket(sockets)));
    expect(stopped.output).toEqual({ exists: false, kind: "obs_recording", path: "/private/tmp/scenecap-recording-test.mp4" });
    expect(stop.requests).toEqual([{ type: "GetRecordStatus" }, { type: "StopRecord" }, { type: "GetRecordStatus" }]);
    expect(store.read().recording).toBeUndefined();
    expect(JSON.stringify({ started, stopped, session: store.read() })).not.toContain(config.password);
  });

  it("rejects no configuration and an externally owned OBS recording without sending StartRecord", async () => {
    const empty = new CaptureSessionStore();
    await expect(startRecording(config, empty, () => new FakeSocket(() => ({})))).rejects.toMatchObject({ kind: "no_configured_sources" });

    const store = configuredStore();
    const discovery = configuredDiscoverySocket();
    const active = new FakeSocket((request) => request.type === "GetRecordStatus" ? { outputActive: true } : unexpected(request));
    const sockets = [discovery, active];
    await expect(startRecording(config, store, () => nextSocket(sockets))).rejects.toMatchObject({ kind: "recording_owned_elsewhere" });
    expect(active.requests).toEqual([{ type: "GetRecordStatus" }]);
  });

  it("serializes concurrent starts so only one StartRecord reaches OBS", async () => {
    const store = configuredStore();
    const discovery = configuredDiscoverySocket();
    const start = new FakeSocket(statusSequence(false, undefined, true));
    const sockets = [discovery, start];
    const first = store.runExclusive(() => startRecording(config, store, () => nextSocket(sockets)));
    const second = store.runExclusive(() => startRecording(config, store, () => nextSocket(sockets)));

    await expect(first).resolves.toMatchObject({ recording: { state: "active" } });
    await expect(second).rejects.toMatchObject({ kind: "already_recording" } satisfies Partial<RecordingControlError>);
    expect(start.requests.filter((request) => request.type === "StartRecord")).toHaveLength(1);
  });

  it("keeps an ambiguous state after a lost StartRecord response and refuses a second mutation", async () => {
    const store = configuredStore();
    const discovery = configuredDiscoverySocket();
    const lost = new FakeSocket((request) => {
      if (request.type === "GetRecordStatus") return { outputActive: false };
      if (request.type === "StartRecord") return new Promise<never>(() => undefined);
      return unexpected(request);
    });
    const sockets = [discovery, lost];
    await expect(startRecording(config, store, () => nextSocket(sockets), { timeoutMs: 15 })).rejects.toMatchObject({ kind: "timeout" });
    expect(store.read().recording?.state).toBe("start_ambiguous");
    await expect(startRecording(config, store, () => new FakeSocket(() => ({})))).rejects.toMatchObject({ kind: "ambiguous_recording_state" });
  });

  it("refuses to start after a configured source changed in OBS", async () => {
    const store = configuredStore();
    const stale = new FakeSocket((request) => {
      if (request.type === "GetInputList") return { inputs: [{ inputKind: "macos-avcapture", inputName: "Phone", inputUuid: "camera-input-uuid" }] };
      if (request.type === "GetInputSettings") return { inputSettings: { device: "different-camera" } };
      return unexpected(request);
    });
    await expect(startRecording(config, store, () => stale)).rejects.toMatchObject({ kind: "stale_configuration" });
  });

  it("refuses to start when the configured source is no longer attached to its recorded scene", async () => {
    const store = configuredStore();
    const detached = configuredDiscoverySocket([]);
    await expect(startRecording(config, store, () => detached)).rejects.toMatchObject({ kind: "stale_configuration" });
    expect(detached.requests.map((request) => request.type)).not.toContain("StartRecord");
  });

  it("revalidates a stored source beyond discovery's per-kind inspection cap", async () => {
    const store = configuredStore();
    const inputs = Array.from({ length: 9 }, (_, index) => ({
      inputKind: "macos-avcapture",
      inputName: index === 8 ? "Phone" : `Other ${index}`,
      inputUuid: index === 8 ? "camera-input-uuid" : `other-${index}`,
    }));
    const revalidation = new FakeSocket((request) => {
      if (request.type === "GetInputList") return { inputs };
      if (request.type === "GetInputSettings") return { inputSettings: { device: "phone-camera" } };
      if (request.type === "GetSceneItemList") return { sceneItems: [{ sourceUuid: "camera-input-uuid" }] };
      return unexpected(request);
    });
    const start = new FakeSocket(statusSequence(false, undefined, true));
    const sockets = [revalidation, start];
    await expect(startRecording(config, store, () => nextSocket(sockets))).resolves.toMatchObject({ recording: { state: "active" } });
    expect(start.requests.map((request) => request.type)).toContain("StartRecord");
  });

  it("marks an already-inactive pre-stop output ambiguous before returning", async () => {
    const store = configuredStore();
    store.beginRecording();
    store.setRecordingState("active");
    const inactive = new FakeSocket((request) => request.type === "GetRecordStatus" ? { outputActive: false } : unexpected(request));
    await expect(stopRecording(config, store, () => inactive)).rejects.toMatchObject({ kind: "ambiguous_recording_state" });
    expect(store.read().recording?.state).toBe("stop_ambiguous");
    expect(inactive.requests).toEqual([{ type: "GetRecordStatus" }]);
  });
});

function configuredStore(): CaptureSessionStore {
  const store = new CaptureSessionStore();
  store.record({
    configurationState: "configured",
    recovery: { input: "restore_previous_target", mutationOutcome: "confirmed", sceneItem: "preserve_existing_scene_item" },
    scene: { sceneName: "Record", sceneUuid: "scene-uuid" },
    source: { configuredTargetRef: targetRef, inputKind: "macos-avcapture", inputName: "Phone", sourceRef },
    target: { availability: "configured_only", kind: "camera", label: "Phone", targetRef, validity: "persistent" },
  } satisfies ConfiguredCaptureSource, { configuredSourceRef: sourceRef });
  return store;
}

function configuredDiscoverySocket(sceneItems = [{ sourceUuid: "camera-input-uuid" }]): FakeSocket {
  return new FakeSocket((request) => {
    if (request.type === "GetInputList") return { inputs: [{ inputKind: "macos-avcapture", inputName: "Phone", inputUuid: "camera-input-uuid" }] };
    if (request.type === "GetInputSettings") return { inputSettings: { device: "phone-camera", device_name: "Phone" } };
    if (request.type === "GetSceneItemList") return { sceneItems };
    return unexpected(request);
  });
}

function statusSequence(before: boolean, outputPath: string | undefined, after: boolean) {
  let statuses = 0;
  return (request: ObsRequest): unknown => {
    if (request.type === "GetRecordStatus") return { outputActive: statuses++ === 0 ? before : after };
    if (request.type === "StartRecord") return {};
    if (request.type === "StopRecord") return { outputPath };
    return unexpected(request);
  };
}

function nextSocket(sockets: FakeSocket[]): FakeSocket {
  const socket = sockets.shift();
  if (!socket) throw new Error("Unexpected OBS connection");
  return socket;
}

function unexpected(request: ObsRequest): never { throw new Error(`Unexpected OBS request: ${request.type}`); }
