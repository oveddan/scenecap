import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { readObsStatus } from "../server/obs.js";

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
