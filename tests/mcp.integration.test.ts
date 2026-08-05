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

  it("does not expose a proxy path and rejects non-loopback Host headers", async () => {
    const sidecar = await startSidecar(() => createMcpServer(configFor(0), () => new FakeObsSocket()));
    const base = `http://127.0.0.1:${sidecar.listeningPort}/mcp`;

    const proxied = await fetch(base, { headers: { "x-forwarded-for": "203.0.113.1" } });
    expect(proxied.status).toBe(400);
    const rebinding = await fetch(base, { headers: { host: "untrusted.example" } });
    expect(rebinding.status).toBeGreaterThanOrEqual(400);
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
