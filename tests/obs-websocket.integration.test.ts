import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { previewCaptureTarget } from "../server/capture-preview.js";
import { encodeCaptureTargetRef, readCaptureTargets } from "../server/capture-targets.js";
import { classifyObsFailure, readObsStatus } from "../server/obs.js";

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("ObsWebSocketAdapter", () => {
  it("authenticates, disables events, and performs only the read-only preflight requests", async () => {
    const password = "auth-password";
    const salt = "test-salt";
    const challenge = "test-challenge";
    const observed = { identify: undefined as Record<string, unknown> | undefined, requests: [] as string[] };
    const fakeObs = await startObsServer((socket) => {
      socket.send(message(0, {
        authentication: { challenge, salt },
        obsWebSocketVersion: "5.5.0",
        rpcVersion: 1,
      }));
      socket.on("message", (raw) => {
        const incoming = JSON.parse(raw.toString()) as { d: Record<string, unknown>; op: number };
        if (incoming.op === 1) {
          observed.identify = incoming.d;
          socket.send(message(2, { negotiatedRpcVersion: 1 }));
          return;
        }
        if (incoming.op !== 6) return;

        const requestType = incoming.d.requestType;
        if (typeof requestType !== "string") return;
        observed.requests.push(requestType);
        const responseData = responseFor(requestType);
        socket.send(message(7, {
          requestId: incoming.d.requestId,
          requestStatus: { code: 100, result: true },
          responseData,
          requestType,
        }));
      });
    });

    const status = await readObsStatus({ host: "127.0.0.1", password, port: fakeObs.port });

    expect(observed.identify).toEqual({
      authentication: obsAuthentication(password, salt, challenge),
      eventSubscriptions: 0,
      rpcVersion: 1,
    });
    expect(observed.requests).toEqual([
      "GetVersion",
      "GetInputKindList",
      "GetSourceFilterKindList",
    ]);
    expect(status).toMatchObject({
      capabilities: { screen_capture: true, source_record_filter: true },
      obsVersion: "31.0.0",
      websocketVersion: "5.5.0",
    });
  });

  it("does not follow an HTTP redirect or leak the password", async () => {
    let redirectTargetConnections = 0;
    const redirectTarget = await startObsServer(() => {
      redirectTargetConnections += 1;
    });
    const redirectSource = await startRedirectServer(redirectTarget.port);
    const password = "redirect-secret";

    let failure: unknown;
    try {
      await readObsStatus({ host: "127.0.0.1", password, port: redirectSource.port });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(password);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(redirectTargetConnections).toBe(0);
  });

  it("classifies OBS's protocol-defined authentication close code", async () => {
    const fakeObs = await startObsServer((socket) => {
      socket.send(message(0, {
        authentication: { challenge: "test-challenge", salt: "test-salt" },
        obsWebSocketVersion: "5.5.0",
        rpcVersion: 1,
      }));
      socket.once("message", () => socket.close(4009, "Authentication Failed"));
    });

    const failure = await readObsStatus({
      host: "127.0.0.1",
      password: "wrong-password",
      port: fakeObs.port,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 4009 });
    expect(classifyObsFailure(failure)).toBe("authentication_failed");
  });

  it("sends only inputName plus the allowlisted window property for live discovery", async () => {
    const observed: Array<{ requestData?: unknown; requestType: string }> = [];
    const fakeObs = await startObsServer((socket) => {
      socket.send(message(0, { obsWebSocketVersion: "5.5.0", rpcVersion: 1 }));
      socket.on("message", (raw) => {
        const incoming = JSON.parse(raw.toString()) as { d: Record<string, unknown>; op: number };
        if (incoming.op === 1) {
          socket.send(message(2, { negotiatedRpcVersion: 1 }));
          return;
        }
        if (incoming.op !== 6 || typeof incoming.d.requestType !== "string") return;
        const requestType = incoming.d.requestType;
        observed.push({ requestData: incoming.d.requestData, requestType });
        const responseData = requestType === "GetInputList"
          ? { inputs: [{ inputKind: "screen_capture", inputName: "Window Probe", inputUuid: "uuid" }] }
          : requestType === "GetInputSettings"
            ? { inputKind: "screen_capture", inputSettings: { show_hidden_windows: true, type: 1 } }
            : requestType === "GetInputPropertiesListPropertyItems"
              ? { propertyItems: [{ itemEnabled: true, itemName: "[Bitwig Studio] Project", itemValue: 42 }] }
              : undefined;
        if (!responseData) throw new Error(`Unexpected OBS request: ${requestType}`);
        socket.send(message(7, {
          requestId: incoming.d.requestId,
          requestStatus: { code: 100, result: true },
          responseData,
          requestType,
        }));
      });
    });

    const result = await readCaptureTargets({
      host: "127.0.0.1",
      password: "unused-by-server",
      port: fakeObs.port,
    });

    expect(observed).toEqual([
      { requestData: undefined, requestType: "GetInputList" },
      { requestData: { inputName: "Window Probe" }, requestType: "GetInputSettings" },
      {
        requestData: { inputName: "Window Probe", propertyName: "window" },
        requestType: "GetInputPropertiesListPropertyItems",
      },
    ]);
    expect(JSON.stringify(observed)).not.toContain("inputUuid");
    expect(JSON.stringify(observed)).not.toMatch(/display_uuid|application|device/);
    expect(result.targets).toContainEqual(expect.objectContaining({
      availability: "available",
      label: "[Bitwig Studio] Project",
    }));
  });

  it("sends one bounded UUID screenshot request for a configured preview and never changes Program", async () => {
    const observed: Array<{ connection: number; requestData?: unknown; requestType: string }> = [];
    let connection = 0;
    const fakeObs = await startObsServer((socket) => {
      connection += 1;
      const connectionNumber = connection;
      socket.send(message(0, { obsWebSocketVersion: "5.5.0", rpcVersion: 1 }));
      socket.on("message", (raw) => {
        const incoming = JSON.parse(raw.toString()) as { d: Record<string, unknown>; op: number };
        if (incoming.op === 1) {
          socket.send(message(2, { negotiatedRpcVersion: 1 }));
          return;
        }
        if (incoming.op !== 6 || typeof incoming.d.requestType !== "string") return;
        const requestType = incoming.d.requestType;
        observed.push({ connection: connectionNumber, requestData: incoming.d.requestData, requestType });
        const responseData = connectionNumber === 1
          ? requestType === "GetInputList"
            ? { inputs: [{ inputKind: "screen_capture", inputName: "Capture", inputUuid: "input-uuid" }] }
            : requestType === "GetInputSettings"
              ? { inputSettings: { type: 1, window: 42 } }
              : requestType === "GetInputPropertiesListPropertyItems"
                ? { propertyItems: [{ itemEnabled: true, itemName: "Terminal", itemValue: 42 }] }
                : undefined
          : requestType === "GetSourceScreenshot"
            ? { imageData: tinyJpegDataUrl() }
            : undefined;
        if (!responseData) throw new Error(`Unexpected OBS request: ${requestType}`);
        socket.send(message(7, {
          requestId: incoming.d.requestId,
          requestStatus: { code: 100, result: true },
          responseData,
          requestType,
        }));
      });
    });

    const result = await previewCaptureTarget(
      { host: "127.0.0.1", password: "unused-by-server", port: fakeObs.port },
      encodeCaptureTargetRef("window", 42),
    );

    expect(result.previewMethod).toBe("configured_source");
    expect(observed).toEqual([
      { connection: 1, requestData: undefined, requestType: "GetInputList" },
      { connection: 1, requestData: { inputName: "Capture" }, requestType: "GetInputSettings" },
      {
        connection: 1,
        requestData: { inputName: "Capture", propertyName: "window" },
        requestType: "GetInputPropertiesListPropertyItems",
      },
      {
        connection: 2,
        requestData: {
          imageCompressionQuality: 75,
          imageFormat: "jpg",
          imageHeight: 540,
          imageWidth: 960,
          sourceUuid: "input-uuid",
        },
        requestType: "GetSourceScreenshot",
      },
    ]);
    expect(observed.map((request) => request.requestType)).not.toContain("SetCurrentProgramScene");
    expect(JSON.stringify(observed)).not.toContain("source_record");
  });

  it("renders an unconfigured window only through Studio Mode Preview and restores it before removal", async () => {
    const observed: Array<{ connection: number; requestData?: unknown; requestType: string }> = [];
    let connection = 0;
    let inputName = "";
    let inputRemoved = false;
    let sceneName = "";
    let sceneRemoved = false;
    const fakeObs = await startObsServer((socket) => {
      connection += 1;
      const connectionNumber = connection;
      socket.send(message(0, { obsWebSocketVersion: "5.5.0", rpcVersion: 1 }));
      socket.on("message", (raw) => {
        const incoming = JSON.parse(raw.toString()) as { d: Record<string, unknown>; op: number };
        if (incoming.op === 1) {
          socket.send(message(2, { negotiatedRpcVersion: 1 }));
          return;
        }
        if (incoming.op !== 6 || typeof incoming.d.requestType !== "string") return;
        const requestType = incoming.d.requestType;
        observed.push({ connection: connectionNumber, requestData: incoming.d.requestData, requestType });
        if (requestType === "CreateScene") sceneName = (incoming.d.requestData as { sceneName: string }).sceneName;
        if (requestType === "CreateInput") inputName = (incoming.d.requestData as { inputName: string }).inputName;
        if (requestType === "RemoveInput") inputRemoved = true;
        if (requestType === "RemoveScene") sceneRemoved = true;
        const responseData = connectionNumber === 1
          ? requestType === "GetInputList"
            ? { inputs: [{ inputKind: "screen_capture", inputName: "Probe", inputUuid: "configured-uuid" }] }
            : requestType === "GetInputSettings"
              ? { inputSettings: { type: 1 } }
              : requestType === "GetInputPropertiesListPropertyItems"
                ? { propertyItems: [{ itemEnabled: true, itemName: "Terminal", itemValue: 42 }] }
                : undefined
          : connectionNumber === 2
            ? ["GetStreamStatus", "GetRecordStatus", "GetReplayBufferStatus", "GetVirtualCamStatus"].includes(requestType)
              ? { outputActive: false }
              : requestType === "GetCurrentProgramScene"
                ? { sceneUuid: "program-scene-uuid" }
                : requestType === "CreateScene"
              ? { sceneUuid: "temporary-scene-uuid" }
              : requestType === "CreateInput"
                ? { inputUuid: "temporary-input-uuid", sceneItemId: 7 }
                : requestType === "GetStudioModeEnabled"
                  ? { studioModeEnabled: false }
                  : requestType === "GetCurrentPreviewScene"
                    ? { currentPreviewSceneUuid: "previous-preview-uuid" }
                    : requestType === "GetSourceScreenshot"
                      ? { imageData: tinyJpegDataUrl() }
                      : ["SetStudioModeEnabled", "SetCurrentPreviewScene", "SetSceneItemEnabled"].includes(requestType)
                        ? {}
                        : undefined
            : connectionNumber === 3
              ? requestType === "GetCurrentProgramScene"
                ? { sceneUuid: "program-scene-uuid" }
                : requestType === "GetStudioModeEnabled"
                  ? { studioModeEnabled: false }
                  : requestType === "GetInputList"
                ? { inputs: inputRemoved ? [] : [{ inputName, inputUuid: "temporary-input-uuid" }] }
                : requestType === "GetSceneList"
                  ? { scenes: sceneRemoved ? [] : [{ sceneName }] }
                  : ["SetSceneItemEnabled", "SetCurrentPreviewScene", "SetStudioModeEnabled", "RemoveInput", "RemoveScene"].includes(requestType)
                    ? {}
                    : undefined
              : connectionNumber === 4
                ? requestType === "GetInputList"
                  ? { inputs: inputRemoved ? [] : [{ inputName, inputUuid: "temporary-input-uuid" }] }
                  : requestType === "GetSceneList"
                    ? { scenes: sceneRemoved ? [] : [{ sceneName }] }
                    : undefined
              : undefined;
        if (responseData === undefined) throw new Error(`Unexpected OBS request: ${requestType}`);
        socket.send(message(7, {
          requestId: incoming.d.requestId,
          requestStatus: { code: 100, result: true },
          responseData,
          requestType,
        }));
      });
    });

    const result = await previewCaptureTarget(
      { host: "127.0.0.1", password: "unused-by-server", port: fakeObs.port },
      encodeCaptureTargetRef("window", 42),
    );

    expect(result.previewMethod).toBe("temporary_window_probe");
    expect(observed.map((request) => request.requestType)).toEqual([
      "GetInputList",
      "GetInputSettings",
      "GetInputPropertiesListPropertyItems",
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
      "GetCurrentProgramScene",
      "GetStudioModeEnabled",
      "RemoveInput",
      "RemoveScene",
      "GetInputList",
      "GetSceneList",
    ]);
    expect(observed.map((request) => request.requestType)).not.toContain("SetCurrentProgramScene");
    expect(JSON.stringify(observed)).not.toContain("source_record");
    expect(observed.filter((request) => request.connection === 4).map((request) => request.requestType))
      .toEqual(["GetInputList", "GetSceneList"]);
    expect(observed.find((request) => request.requestType === "SetCurrentPreviewScene" && request.connection === 2))
      .toMatchObject({ requestData: { sceneUuid: "temporary-scene-uuid" } });
  });
});

function responseFor(requestType: string): Record<string, unknown> {
  switch (requestType) {
    case "GetVersion":
      return { obsVersion: "31.0.0", obsWebSocketVersion: "5.5.0" };
    case "GetInputKindList":
      return { inputKinds: ["display_capture"] };
    case "GetSourceFilterKindList":
      return { sourceFilterKinds: ["crop_filter", "source_record_filter"] };
    default:
      throw new Error(`Unexpected OBS request: ${requestType}`);
  }
}

async function startObsServer(onConnection: (socket: WebSocket) => void): Promise<{
  close(): Promise<void>;
  port: number;
}> {
  const server = new WebSocketServer({
    handleProtocols: (protocols) => (protocols.has("obswebsocket.json") ? "obswebsocket.json" : false),
    host: "127.0.0.1",
    port: 0,
  });
  server.on("connection", onConnection);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate fake OBS port.");
  const port = address.port;
  const managed = {
    port,
    close: () => closeWebSocketServer(server),
  };
  servers.push(managed);
  return managed;
}

async function startRedirectServer(targetPort: number): Promise<{ close(): Promise<void>; port: number }> {
  const server = createServer();
  server.on("upgrade", (_request, socket) => {
    socket.end(
      `HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`,
    );
  });
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate redirect test port.");
  const managed = { port: address.port, close: () => closeHttpServer(server) };
  servers.push(managed);
  return managed;
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function message(op: number, d: Record<string, unknown>): string {
  return JSON.stringify({ d, op });
}

function obsAuthentication(password: string, salt: string, challenge: string): string {
  const passwordSalt = createHash("sha256").update(password + salt).digest("base64");
  return createHash("sha256").update(passwordSalt + challenge).digest("base64");
}

function tinyJpegDataUrl(): string {
  const bytes = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x0a, 0x00, 0x0a, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}
