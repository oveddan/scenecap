import { request, type IncomingHttpHeaders } from "node:http";
import { createServer } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import type { SidecarConfig } from "../server/config.js";
import { McpHttpSidecar } from "../server/http.js";
import { createMcpServer } from "../server/mcp.js";
import type { ObsConnectionOptions, ObsSocket } from "../server/obs.js";

class FakeObsSocket implements ObsSocket {
  connectedWith?: ObsConnectionOptions;

  async connect(options: ObsConnectionOptions): Promise<void> {
    this.connectedWith = options;
  }

  async call(requestType: "GetVersion" | "GetInputKindList" | "GetSourceFilterKindList"): Promise<unknown> {
    if (requestType === "GetVersion") return { obsVersion: "31.0.0" };
    if (requestType === "GetInputKindList") return { inputKinds: ["screen"] };
    return { sourceFilterKinds: ["crop", "source_record_filter"] };
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
    expect(tools.tools.map((tool) => tool.name)).toEqual(["get_status"]);

    const result = await client.callTool({ name: "get_status", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).not.toContain("integration-secret");
    const response = result as { content?: Array<{ text?: string; type: string }> };
    const text = response.content?.[0]?.type === "text" ? response.content[0].text : undefined;
    const status = JSON.parse(text ?? "{}");
    expect(status.server).toEqual({ name: "scenecap", version: "0.1.0" });
    expect(status.capabilities).toEqual({ screen_capture: false, source_record_filter: true });
    expect(socket.connectedWith?.password).toBe("integration-secret");
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
    const sidecar = await startSidecar(() => createMcpServer(configFor(0), () => new FakeObsSocket()));
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
      expect.objectContaining({ tools: [expect.objectContaining({ name: "get_status" })] }),
      expect.objectContaining({ tools: [expect.objectContaining({ name: "get_status" })] }),
    ]);
    await Promise.all([first.close(), second.close()]);
  });

  it("fails rather than sharing a port with another sidecar", async () => {
    const port = await unusedPort();
    const first = new McpHttpSidecar(configFor(port), {
      createMcpServer: () => createMcpServer(configFor(port), () => new FakeObsSocket()),
    });
    const second = new McpHttpSidecar(configFor(port), {
      createMcpServer: () => createMcpServer(configFor(port), () => new FakeObsSocket()),
    });
    running.push(first, second);
    await first.start();
    await expect(second.start()).rejects.toThrow(`127.0.0.1:${port}`);
  });

  it("does not return an OBS error containing the configured password", async () => {
    const secret = "integration-secret";
    const sidecar = await startSidecar(() =>
      createMcpServer(configFor(0), () => ({
        async connect() {
          throw new Error(`OBS rejected ${secret}`);
        },
        async call() {
          throw new Error("unreachable");
        },
        disconnect() {},
      })),
    );
    const client = new Client({ name: "scenecap-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${sidecar.listeningPort}/mcp`)),
    );
    const result = await client.callTool({ name: "get_status", arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    await client.close();
  });
});

async function startSidecar(factory: () => ReturnType<typeof createMcpServer>): Promise<McpHttpSidecar> {
  const sidecar = new McpHttpSidecar(configFor(await unusedPort()), { createMcpServer: factory });
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
