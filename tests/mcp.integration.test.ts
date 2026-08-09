import { request, type IncomingHttpHeaders } from "node:http";
import { createServer } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, type SidecarConfig } from "../server/config.js";
import { CaptureSessionStore } from "../server/capture-session.js";
import { McpHttpSidecar, type McpHttpSidecarOptions } from "../server/http.js";
import { createMcpServer } from "../server/mcp.js";
import type { ObsConnectionOptions, ObsReadRequest, ObsRequest, ObsSocket } from "../server/obs.js";

class FakeObsSocket implements ObsSocket {
  connectedWith?: ObsConnectionOptions;

  async connect(options: ObsConnectionOptions): Promise<void> {
    this.connectedWith = options;
  }

  async request(request: ObsReadRequest): Promise<unknown> {
    if (request.type === "GetVersion") return { obsVersion: "31.0.0" };
    if (request.type === "GetInputKindList") return { inputKinds: ["screen"] };
    if (request.type === "GetSourceFilterKindList") {
      return { sourceFilterKinds: ["crop", "source_record_filter"] };
    }
    if (request.type === "GetInputList") return { inputs: [] };
    throw new Error(`Unexpected fake OBS request: ${request.type}`);
  }

  disconnect(): void {}
}

const running: McpHttpSidecar[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((sidecar) => sidecar.stop()));
});

describe("MCP HTTP sidecar", () => {
  it("serves get_status over Streamable HTTP without exposing OBS credentials", async () => {
    const socket = new FakeObsSocket();
    const sidecar = await startSidecar(() => createMcpServer(configFor(0), () => socket));
    const port = sidecar.listeningPort;
    expect(port).toBeTypeOf("number");

    const client = new Client({ name: "scenecap-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "get_session",
      "configure_capture_target",
      "get_status",
      "list_capture_targets",
      "preview_capture_target",
    ]);

    const sessionResult = await client.callTool({ name: "get_session", arguments: {} }) as {
      content?: Array<{ text?: string; type: string }>;
      isError?: boolean;
    };
    expect(sessionResult.isError).not.toBe(true);
    expect(JSON.stringify(sessionResult)).not.toContain("integration-secret");
    const sessionText = sessionResult.content?.[0]?.type === "text" ? sessionResult.content[0].text : undefined;
    expect(JSON.parse(sessionText ?? "{}")).toMatchObject({
      session: { configuredSources: [], revision: 0, sessionId: expect.any(String) },
      status: "ok",
    });

    const result = await client.callTool({ name: "get_status", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).not.toContain("integration-secret");
    const response = result as { content?: Array<{ text?: string; type: string }> };
    const text = response.content?.[0]?.type === "text" ? response.content[0].text : undefined;
    const status = JSON.parse(text ?? "{}");
    expect(status.server).toEqual({ name: "scenecap", version: "0.1.0" });
    expect(status.capabilities).toEqual({ screen_capture: false, source_record_filter: true });
    expect(socket.connectedWith?.password).toBe("integration-secret");
    const discoveryResult = await client.callTool({ name: "list_capture_targets", arguments: {} }) as {
      content?: Array<{ text?: string; type: string }>;
      isError?: boolean;
    };
    expect(discoveryResult.isError).not.toBe(true);
    expect(JSON.stringify(discoveryResult)).not.toContain("integration-secret");
    const discoveryContent = discoveryResult.content?.[0];
    expect(discoveryContent).toMatchObject({ type: "text" });
    if (!discoveryContent || discoveryContent.type !== "text") {
      throw new Error("Expected capture discovery to return text.");
    }
    expect(JSON.parse(discoveryContent.text ?? "{}")).toMatchObject({
      limitations: [
        expect.objectContaining({ kind: "screen_capture" }),
        expect.objectContaining({ kind: "camera" }),
      ],
      status: "ok",
      targets: [],
    });
    await client.close();
  });

  it("rejects spoofed Host, proxy, and browser Origin requests before MCP handling", async () => {
    const sidecar = await startSidecar(() => createMcpServer(configFor(0), () => new FakeObsSocket()));
    const port = sidecar.listeningPort;
    if (!port) throw new Error("Sidecar did not expose a listening port.");

    await expect(
      rawMcpRequest(port, { headers: { host: "untrusted.example" } }),
    ).resolves.toMatchObject({
      body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid Host: untrusted.example"},"id":null}',
      status: 403,
    });
    await expect(
      rawMcpRequest(port, { headers: { "x-forwarded-for": "203.0.113.1" } }),
    ).resolves.toMatchObject({ body: '{"error":"Loopback requests cannot be proxied."}', status: 400 });
    await expect(
      rawMcpRequest(port, { headers: { origin: "https://evil.example" } }),
    ).resolves.toMatchObject({ body: '{"error":"Browser origins are not permitted."}', status: 403 });
  });

  it("returns 400 for a non-initialize request without a session and 404 for unknown sessions", async () => {
    const sidecar = await startSidecar(() => createMcpServer(configFor(0), () => new FakeObsSocket()));
    const port = sidecar.listeningPort;
    if (!port) throw new Error("Sidecar did not expose a listening port.");

    await expect(rawMcpRequest(port, { body: listToolsRequest() })).resolves.toMatchObject({
      body: '{"error":{"code":-32000,"message":"Bad Request: Mcp-Session-Id header is required"},"id":null,"jsonrpc":"2.0"}',
      status: 400,
    });
    await expect(
      rawMcpRequest(port, { body: listToolsRequest(), headers: { "mcp-session-id": "missing-session" } }),
    ).resolves.toMatchObject({
      body: '{"error":{"code":-32001,"message":"Session not found"},"id":null,"jsonrpc":"2.0"}',
      status: 404,
    });
  });

  it("removes a terminated session so clients recover with a 404", async () => {
    const sidecar = await startSidecar(() => createMcpServer(configFor(0), () => new FakeObsSocket()));
    const port = sidecar.listeningPort;
    if (!port) throw new Error("Sidecar did not expose a listening port.");

    const initialized = await rawMcpRequest(port, { body: initializeRequest() });
    expect(initialized.status).toBe(200);
    const sessionIdHeader = initialized.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    if (!sessionId) throw new Error("Initialize response did not include an MCP session ID.");

    await expect(
      rawMcpRequest(port, {
        headers: { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-11-25" },
        method: "DELETE",
      }),
    ).resolves.toMatchObject({ body: "", status: 200 });
    await expect(
      rawMcpRequest(port, {
        body: listToolsRequest(),
        headers: { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-11-25" },
      }),
    ).resolves.toMatchObject({
      body: '{"error":{"code":-32001,"message":"Session not found"},"id":null,"jsonrpc":"2.0"}',
      status: 404,
    });
  });

  it("keeps concurrent MCP sessions independent", async () => {
    const captureSessionStore = new CaptureSessionStore();
    const sidecar = await startSidecar(() => createMcpServer(
      configFor(0),
      () => new FakeObsSocket(),
      undefined,
      captureSessionStore,
    ));
    const port = sidecar.listeningPort;
    if (!port) throw new Error("Sidecar did not expose a listening port.");
    const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);

    const first = new Client({ name: "first", version: "0.0.0" });
    const second = new Client({ name: "second", version: "0.0.0" });
    await Promise.all([
      first.connect(new StreamableHTTPClientTransport(endpoint)),
      second.connect(new StreamableHTTPClientTransport(endpoint)),
    ]);
    await expect(Promise.all([first.listTools(), second.listTools()])).resolves.toEqual([
      expect.objectContaining({ tools: expect.arrayContaining([expect.objectContaining({ name: "get_status" })]) }),
      expect.objectContaining({ tools: expect.arrayContaining([expect.objectContaining({ name: "get_status" })]) }),
    ]);
    const [firstSession, secondSession] = await Promise.all([
      first.callTool({ name: "get_session", arguments: {} }),
      second.callTool({ name: "get_session", arguments: {} }),
    ]);
    expect(sessionIdFromResult(firstSession)).toBe(sessionIdFromResult(secondSession));
    await Promise.all([first.close(), second.close()]);
  });

  it("expires abandoned MCP sessions after their idle TTL", async () => {
    const sidecar = await startSidecar(
      () => createMcpServer(configFor(0), () => new FakeObsSocket()),
      { sessionIdleTtlMs: 10 },
    );
    const port = sidecar.listeningPort;
    if (!port) throw new Error("Sidecar did not expose a listening port.");

    const initialized = await rawMcpRequest(port, { body: initializeRequest() });
    const sessionId = singleHeader(initialized.headers, "mcp-session-id");
    if (!sessionId) throw new Error("Initialize response did not include an MCP session ID.");

    await delay(30);
    await expect(
      rawMcpRequest(port, { body: listToolsRequest(), headers: { "mcp-session-id": sessionId } }),
    ).resolves.toMatchObject({
      body: '{"error":{"code":-32001,"message":"Session not found"},"id":null,"jsonrpc":"2.0"}',
      status: 404,
    });
  });

  it("enforces its session ceiling across concurrent initializations", async () => {
    const sidecar = await startSidecar(
      () => createMcpServer(configFor(0), () => new FakeObsSocket()),
      { maxSessions: 1 },
    );
    const port = sidecar.listeningPort;
    if (!port) throw new Error("Sidecar did not expose a listening port.");

    const responses = await Promise.all(
      Array.from({ length: 4 }, () => rawMcpRequest(port, { body: initializeRequest() })),
    );
    const successful = responses.filter((response) => response.status === 200);
    expect(successful).toHaveLength(1);
    expect(responses.filter((response) => response.status !== 200).map((response) => response.status)).toEqual([
      400,
      400,
      400,
    ]);
    const sessionId = singleHeader(successful[0]?.headers ?? {}, "mcp-session-id");
    if (!sessionId) throw new Error("Initialize response did not include an MCP session ID.");
    await rawMcpRequest(port, { headers: { "mcp-session-id": sessionId }, method: "DELETE" });
    await expect(rawMcpRequest(port, { body: initializeRequest() })).resolves.toMatchObject({ status: 200 });
  });

  it("keeps the active-instance guard after a failed peer start is stopped", async () => {
    const port = await unusedPort();
    const first = new McpHttpSidecar(configFor(port), {
      createMcpServer: () => createMcpServer(configFor(port), () => new FakeObsSocket()),
    });
    const second = new McpHttpSidecar(configFor(port), {
      createMcpServer: () => createMcpServer(configFor(port), () => new FakeObsSocket()),
    });
    const third = new McpHttpSidecar(configFor(await unusedPort()), {
      createMcpServer: () => createMcpServer(configFor(port), () => new FakeObsSocket()),
    });
    running.push(first, second, third);
    await first.start();
    await expect(second.start()).rejects.toThrow(`127.0.0.1:${port}`);
    await second.stop();
    await expect(third.start()).rejects.toThrow(`127.0.0.1:${port}`);
  });

  it("closes the listener before surfacing a session cleanup failure", async () => {
    const sidecar = await startSidecar(() => {
      const server = createMcpServer(configFor(0), () => new FakeObsSocket());
      server.close = async () => {
        throw new Error("injected close failure");
      };
      return server;
    });
    const port = sidecar.listeningPort;
    if (!port) throw new Error("Sidecar did not expose a listening port.");
    const client = new Client({ name: "close-failure-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

    await expect(sidecar.stop()).rejects.toThrow("injected close failure");
    expect(sidecar.listeningPort).toBeUndefined();
    const replacement = new McpHttpSidecar(configFor(await unusedPort()), {
      createMcpServer: () => createMcpServer(configFor(0), () => new FakeObsSocket()),
    });
    running.push(replacement);
    await expect(replacement.start()).resolves.toBeUndefined();
    await client.close();
  });

  it("keeps MCP available when loading OBS configuration fails", async () => {
    const sidecar = await startSidecar(() =>
      createMcpServer(
        { http: { host: "127.0.0.1", port: 0 } },
        () => new FakeObsSocket(),
        async () => {
          throw new ConfigError("OBS setup is missing");
        },
      ),
    );
    const client = await connectClient(sidecar, "config-error-test");

    const status = await getStatus(client);
    expect(status).toEqual({
      reason: "OBS configuration is unavailable.",
      server: { name: "scenecap", version: "0.1.0" },
      status: "unavailable",
    });
    await expect(client.listTools()).resolves.toEqual(
      expect.objectContaining({ tools: expect.arrayContaining([expect.objectContaining({ name: "get_status" })]) }),
    );
    await client.close();
  });

  it("returns a curated OBS authentication failure without leaking the password", async () => {
    const secret = "integration-secret";
    const sidecar = await startSidecar(() =>
      createMcpServer(configFor(0), () => ({
        async connect() {
          throw new Error(`Authentication failed for ${secret}`);
        },
        async request() {
          throw new Error("unreachable");
        },
        disconnect() {},
      })),
    );
    const client = await connectClient(sidecar, "auth-error-test");
    const result = await client.callTool({ name: "get_status", arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await getStatus(client)).toEqual({
      reason: "OBS authentication failed.",
      server: { name: "scenecap", version: "0.1.0" },
      status: "unavailable",
    });
    await client.close();
  });

  it("returns preview metadata plus an MCP image block without reflecting image data or credentials in text", async () => {
    const discovery = new PreviewFakeObsSocket((request) => {
      if (request.type === "GetInputList") {
        return { inputs: [{ inputKind: "screen_capture", inputName: "Capture", inputUuid: "input-uuid" }] };
      }
      if (request.type === "GetInputSettings") return { inputSettings: { type: 1, window: 42 } };
      if (request.type === "GetInputPropertiesListPropertyItems") {
        return { propertyItems: [{ itemEnabled: true, itemName: "Terminal", itemValue: 42 }] };
      }
      throw new Error(`Unexpected discovery request ${request.type}`);
    });
    const imageData = tinyJpegDataUrl();
    const screenshot = new PreviewFakeObsSocket((request) => {
      expect(request).toMatchObject({
        data: { imageFormat: "jpg", sourceUuid: "input-uuid" },
        type: "GetSourceScreenshot",
      });
      return { imageData };
    });
    const sockets = [discovery, screenshot];
    const sidecar = await startSidecar(() => createMcpServer(configFor(0), () => {
      const socket = sockets.shift();
      if (!socket) throw new Error("Unexpected extra OBS connection");
      return socket;
    }));
    const client = await connectClient(sidecar, "preview-test");

    const result = await client.callTool({
      arguments: { targetRef: "scenecap-target-v1.WyJ3aW5kb3ciLDQyXQ" },
      name: "preview_capture_target",
    }) as { content?: Array<{ data?: string; text?: string; type: string }>; isError?: boolean };

    expect(result.isError).not.toBe(true);
    const metadata = result.content?.[0];
    const image = result.content?.[1];
    expect(metadata).toMatchObject({ type: "text" });
    expect(image).toMatchObject({ data: expect.any(String), mimeType: "image/jpeg", type: "image" });
    expect(metadata?.text).toContain('"previewMethod":"configured_source"');
    expect(metadata?.text).not.toContain("imageData");
    expect(metadata?.text).not.toContain(imageData);
    expect(metadata?.text).not.toContain("integration-secret");
    await client.close();
  });

  it("persists one configured source into the shared get_session contract without exposing credentials", async () => {
    const discovery = new PreviewFakeObsSocket((request) => {
      if (request.type === "GetInputList") {
        return { inputs: [{ inputKind: "screen_capture", inputName: "Screen", inputUuid: "screen-input-uuid" }] };
      }
      if (request.type === "GetInputSettings") return { inputSettings: { type: 1, window: 41 } };
      if (request.type === "GetInputPropertiesListPropertyItems") {
        return { propertyItems: [{ itemEnabled: true, itemName: "Terminal", itemValue: 42 }] };
      }
      throw new Error(`Unexpected discovery request ${request.type}`);
    });
    const mutation = new PreviewFakeObsSocket((request) => {
      if (request.type === "GetCurrentProgramScene") {
        return { currentProgramSceneName: "Record", currentProgramSceneUuid: "record-uuid" };
      }
      if (request.type === "GetInputList") {
        return { inputs: [{ inputKind: "screen_capture", inputName: "Screen", inputUuid: "screen-input-uuid" }] };
      }
      if (request.type === "GetInputSettings") return { inputSettings: { type: 1, window: 41 } };
      if (request.type === "SetInputSettings") return {};
      if (request.type === "GetSceneItemList") return { sceneItems: [{ sceneItemId: 5, sourceUuid: "screen-input-uuid" }] };
      throw new Error(`Unexpected mutation request ${request.type}`);
    });
    const sockets = [discovery, mutation];
    const store = new CaptureSessionStore();
    const sidecar = await startSidecar(() => createMcpServer(configFor(0), () => {
      const socket = sockets.shift();
      if (!socket) throw new Error("Unexpected extra OBS connection");
      return socket;
    }, undefined, store));
    const client = await connectClient(sidecar, "configuration-test");
    const targetRef = "scenecap-target-v1.WyJ3aW5kb3ciLDQyXQ";
    const sourceRef = "scenecap-input-v1.c2NyZWVuLWlucHV0LXV1aWQ";

    const configured = await client.callTool({
      arguments: { sourceRef, targetRef },
      name: "configure_capture_target",
    });
    expect(configured.isError).not.toBe(true);
    expect(JSON.stringify(configured)).not.toContain("integration-secret");
    expect(JSON.parse((configured as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "{}")).toMatchObject({
      configuredSource: {
        configurationState: "configured",
        scene: { sceneName: "Record", sceneUuid: "record-uuid" },
        source: { configuredTargetRef: targetRef, sourceRef },
      },
      session: { configuredSources: [expect.any(Object)], revision: 1 },
      status: "ok",
    });
    const session = await client.callTool({ arguments: {}, name: "get_session" });
    const sessionText = (session as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "{}";
    expect(sessionText).not.toContain("previousInputSettings");
    expect(sessionText).not.toContain("restoreSnapshot");
    expect(JSON.parse(sessionText)).toMatchObject({
      session: {
        configuredSources: [expect.objectContaining({ source: expect.objectContaining({ sourceRef }) })],
        revision: 1,
      },
    });
    await client.close();
  });
});

class PreviewFakeObsSocket implements ObsSocket {
  constructor(readonly responder: (request: ObsRequest) => unknown | Promise<unknown>) {}

  async connect(options: ObsConnectionOptions): Promise<void> {
    void options;
  }

  async request(request: ObsRequest): Promise<unknown> {
    return this.responder(request);
  }

  disconnect(): void {}
}

async function startSidecar(
  factory: () => ReturnType<typeof createMcpServer>,
  options?: McpHttpSidecarOptions,
): Promise<McpHttpSidecar> {
  const sidecar = new McpHttpSidecar(configFor(await unusedPort()), { createMcpServer: factory }, options);
  running.push(sidecar);
  await sidecar.start();
  return sidecar;
}

function configFor(port: number): SidecarConfig {
  return {
    http: { host: "127.0.0.1", port },
    obs: { host: "127.0.0.1", password: "integration-secret", port: 4455 },
  };
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate test port.");
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function connectClient(sidecar: McpHttpSidecar, name: string): Promise<Client> {
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${sidecar.listeningPort}/mcp`)),
  );
  return client;
}

async function getStatus(client: Client): Promise<unknown> {
  const result = await client.callTool({ name: "get_status", arguments: {} }) as {
    content?: Array<{ text?: string; type: string }>;
  };
  const content = result.content?.[0];
  if (!content || content.type !== "text" || !content.text) {
    throw new Error("Expected a text MCP tool result.");
  }
  return JSON.parse(content.text);
}

function sessionIdFromResult(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string; type: string }> }).content?.[0];
  if (!content || content.type !== "text" || !content.text) {
    throw new Error("Expected a text MCP session result.");
  }
  const sessionId = (JSON.parse(content.text) as { session?: { sessionId?: unknown } }).session?.sessionId;
  if (typeof sessionId !== "string") throw new Error("Expected a capture session ID.");
  return sessionId;
}

function singleHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface RawMcpRequest {
  body?: object;
  headers?: Record<string, string>;
  method?: "DELETE" | "GET" | "POST";
}

interface RawMcpResponse {
  body: string;
  headers: IncomingHttpHeaders;
  status: number;
}

function rawMcpRequest(port: number, options: RawMcpRequest = {}): Promise<RawMcpResponse> {
  const payload = options.body ? JSON.stringify(options.body) : undefined;
  return new Promise((resolve, reject) => {
    const clientRequest = request({
      headers: {
        accept: "application/json, text/event-stream",
        ...(payload ? { "content-length": String(Buffer.byteLength(payload)), "content-type": "application/json" } : {}),
        host: `127.0.0.1:${port}`,
        ...options.headers,
      },
      host: "127.0.0.1",
      method: options.method ?? "POST",
      path: "/mcp",
      port,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({ body, headers: response.headers, status: response.statusCode ?? 0 });
      });
    });
    clientRequest.once("error", reject);
    clientRequest.end(payload);
  });
}

function initializeRequest(): object {
  return {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "raw-test", version: "0.0.0" },
      protocolVersion: "2025-11-25",
    },
  };
}

function listToolsRequest(): object {
  return { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} };
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
