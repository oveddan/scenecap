import { randomUUID } from "node:crypto";
import { createServer, type Server as NodeHttpServer } from "node:http";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { NextFunction, Request, Response } from "express";

import { LOOPBACK_HOST, type SidecarConfig } from "./config.js";

export interface McpHttpSidecarDependencies {
  createMcpServer: () => McpServer;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

let activeSidecarPort: number | undefined;

/**
 * A local-only Streamable HTTP server. It has no proxy support and binds to
 * the literal IPv4 loopback address rather than a hostname that could resolve
 * differently on another machine.
 */
export class McpHttpSidecar {
  readonly #config: SidecarConfig;
  readonly #dependencies: McpHttpSidecarDependencies;
  readonly #sessions = new Map<string, Session>();
  #httpServer?: NodeHttpServer;

  constructor(config: SidecarConfig, dependencies: McpHttpSidecarDependencies) {
    this.#config = config;
    this.#dependencies = dependencies;
  }

  async start(): Promise<void> {
    if (this.#httpServer?.listening) {
      throw new Error("MCP sidecar is already running.");
    }
    if (activeSidecarPort !== undefined) {
      throw new Error(
        `MCP sidecar is already running on ${LOOPBACK_HOST}:${activeSidecarPort}.`,
      );
    }

    const app = createMcpExpressApp({
      allowedHosts: [LOOPBACK_HOST],
      host: LOOPBACK_HOST,
    });
    app.set("trust proxy", false);
    app.use(rejectProxyAndOffHostRequests);
    app.post("/mcp", this.#handleMcpRequest);
    app.get("/mcp", this.#handleMcpRequest);
    app.delete("/mcp", this.#handleMcpRequest);

    const server = createServer(app);
    this.#httpServer = server;
    activeSidecarPort = this.#config.http.port;
    try {
      await listen(server, this.#config.http.port);
    } catch (error) {
      if (activeSidecarPort === this.#config.http.port) activeSidecarPort = undefined;
      this.#httpServer = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map(({ transport }) => transport.close()));
    this.#sessions.clear();

    if (activeSidecarPort === this.#config.http.port) activeSidecarPort = undefined;
    if (!this.#httpServer?.listening) {
      this.#httpServer = undefined;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.#httpServer?.close((error) => (error ? reject(error) : resolve()));
    });
    this.#httpServer = undefined;
  }

  get listeningPort(): number | undefined {
    const address = this.#httpServer?.address();
    return address && typeof address !== "string" ? address.port : undefined;
  }

  readonly #handleMcpRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.header("mcp-session-id");
    const existing = sessionId ? this.#sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId || !isInitializeRequest(req.body)) {
      res.status(400).json({
        error: { code: -32000, message: "Invalid MCP session." },
        id: null,
        jsonrpc: "2.0",
      });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      onsessionclosed: (closedSessionId) => {
        this.#sessions.delete(closedSessionId);
      },
      sessionIdGenerator: randomUUID,
    });
    const server = this.#dependencies.createMcpServer();
    transport.onclose = () => {
      if (transport.sessionId) {
        this.#sessions.delete(transport.sessionId);
      }
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    if (transport.sessionId) {
      this.#sessions.set(transport.sessionId, { server, transport });
    }
  };
}

function rejectProxyAndOffHostRequests(req: Request, res: Response, next: NextFunction): void {
  const remote = req.socket.remoteAddress;
  const isLoopback = remote === LOOPBACK_HOST || remote === "::ffff:127.0.0.1";
  const proxyHeaders = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"];
  if (!isLoopback || proxyHeaders.some((header) => req.headers[header] !== undefined)) {
    res.status(400).json({ error: "Loopback requests cannot be proxied." });
    return;
  }
  next();
}

function listen(server: NodeHttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      const code = (error as NodeJS.ErrnoException).code;
      reject(new Error(`Unable to listen on ${LOOPBACK_HOST}:${port}: ${code ?? error.message}`));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ exclusive: true, host: LOOPBACK_HOST, port });
  });
}
