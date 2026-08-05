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

export interface McpHttpSidecarOptions {
  maxSessions?: number;
  sessionIdleTtlMs?: number;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  sessionId?: string;
  idleTimer?: NodeJS.Timeout;
  connected: boolean;
  disposing: boolean;
  disposePromise?: Promise<void>;
}

const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_SESSION_IDLE_TTL_MS = 60 * 60_000;

let activeSidecar: { owner: McpHttpSidecar; port: number } | undefined;

/**
 * A local-only Streamable HTTP server. It has no proxy support and binds to
 * the literal IPv4 loopback address rather than a hostname that could resolve
 * differently on another machine.
 */
export class McpHttpSidecar {
  readonly #config: SidecarConfig;
  readonly #dependencies: McpHttpSidecarDependencies;
  readonly #sessions = new Map<string, Session>();
  readonly #maxSessions: number;
  readonly #sessionIdleTtlMs: number;
  #httpServer?: NodeHttpServer;

  constructor(
    config: SidecarConfig,
    dependencies: McpHttpSidecarDependencies,
    options: McpHttpSidecarOptions = {},
  ) {
    this.#config = config;
    this.#dependencies = dependencies;
    this.#maxSessions = positiveInteger(options.maxSessions, DEFAULT_MAX_SESSIONS, "maxSessions");
    this.#sessionIdleTtlMs = positiveInteger(
      options.sessionIdleTtlMs,
      DEFAULT_SESSION_IDLE_TTL_MS,
      "sessionIdleTtlMs",
    );
  }

  async start(): Promise<void> {
    if (this.#httpServer?.listening) {
      throw new Error("MCP sidecar is already running.");
    }
    if (activeSidecar !== undefined) {
      throw new Error(
        `MCP sidecar is already running on ${LOOPBACK_HOST}:${activeSidecar.port}.`,
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
    activeSidecar = { owner: this, port: this.#config.http.port };
    try {
      await listen(server, this.#config.http.port);
    } catch (error) {
      if (activeSidecar?.owner === this) activeSidecar = undefined;
      this.#httpServer = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    const sessionResults = await Promise.allSettled(
      [...this.#sessions.values()].map((session) => this.#disposeSession(session)),
    );
    this.#sessions.clear();

    const server = this.#httpServer;
    let listenerError: unknown;
    try {
      if (server?.listening) {
        server.closeAllConnections();
        await closeServer(server);
      }
    } catch (error) {
      listenerError = error;
    } finally {
      this.#httpServer = undefined;
      if (activeSidecar?.owner === this) activeSidecar = undefined;
    }

    const sessionError = sessionResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )?.reason;
    if (listenerError) throw listenerError;
    if (sessionError) throw sessionError;
  }

  get listeningPort(): number | undefined {
    const address = this.#httpServer?.address();
    return address && typeof address !== "string" ? address.port : undefined;
  }

  readonly #handleMcpRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.header("mcp-session-id");
    const existing = sessionId ? this.#sessions.get(sessionId) : undefined;
    if (existing) {
      this.#touchSession(existing);
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId) {
      sendJsonRpcError(res, 404, -32001, "Session not found");
      return;
    }

    if (!isInitializeRequest(req.body)) {
      sendJsonRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
      return;
    }

    const server = this.#dependencies.createMcpServer();
    const session = { connected: false, disposing: false, server } as Session;
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      onsessioninitialized: (initializedSessionId) => {
        if (this.#sessions.size >= this.#maxSessions) {
          throw new Error("MCP session capacity reached.");
        }
        session.sessionId = initializedSessionId;
        this.#sessions.set(initializedSessionId, session);
        this.#touchSession(session);
      },
      onsessionclosed: (closedSessionId) => {
        this.#forgetSession(session, closedSessionId);
      },
      sessionIdGenerator: randomUUID,
    });
    session.transport = transport;
    transport.onclose = () => {
      this.#forgetSession(session);
      this.#closeServerAfterTransportClosed(session);
    };

    try {
      await server.connect(transport);
      session.connected = true;
      await transport.handleRequest(req, res, req.body);

      // A syntactically initialize-shaped request can still fail before the
      // transport establishes a session. Do not retain its server or transport.
      if (!session.sessionId) await this.#disposeSession(session);
    } catch (error) {
      await this.#disposeSession(session);
      throw error;
    }
  };

  #forgetSession(session: Session, sessionId = session.sessionId): void {
    this.#clearSessionTimer(session);
    if (sessionId && this.#sessions.get(sessionId) === session) {
      this.#sessions.delete(sessionId);
    }
    session.sessionId = undefined;
  }

  #touchSession(session: Session): void {
    if (!session.sessionId || session.disposing) return;

    this.#clearSessionTimer(session);
    const sessionId = session.sessionId;
    session.idleTimer = setTimeout(() => {
      if (this.#sessions.get(sessionId) === session) {
        void this.#disposeSession(session).catch(() => undefined);
      }
    }, this.#sessionIdleTtlMs);
    session.idleTimer.unref();
  }

  #clearSessionTimer(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }

  async #disposeSession(session: Session): Promise<void> {
    if (session.disposePromise) return session.disposePromise;

    session.disposing = true;
    this.#forgetSession(session);
    session.disposePromise = session.connected
      ? session.server.close().catch(async (error: unknown) => {
          await session.transport.close();
          throw error;
        })
      : Promise.all([session.server.close(), session.transport.close()]).then(() => undefined);
    return session.disposePromise;
  }

  #closeServerAfterTransportClosed(session: Session): void {
    if (session.disposing || session.disposePromise) return;

    // McpServer's close() delegates to its transport. Schedule this after the
    // transport's close callback chain so its Protocol has released that
    // transport; otherwise a client DELETE would close it twice.
    queueMicrotask(() => {
      if (session.disposing || session.disposePromise) return;
      session.disposing = true;
      session.disposePromise = session.server.close().catch(() => undefined);
    });
  }
}

function rejectProxyAndOffHostRequests(req: Request, res: Response, next: NextFunction): void {
  const remote = req.socket.remoteAddress;
  const isLoopback = remote === LOOPBACK_HOST || remote === "::ffff:127.0.0.1";
  const proxyHeaders = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"];
  if (!isLoopback || proxyHeaders.some((header) => req.headers[header] !== undefined)) {
    res.status(400).json({ error: "Loopback requests cannot be proxied." });
    return;
  }
  // Local MCP agents omit Origin. Do not add CORS here without reconsidering
  // the browser threat model and authentication boundary.
  if (req.headers.origin !== undefined) {
    res.status(403).json({ error: "Browser origins are not permitted." });
    return;
  }
  next();
}

function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ error: { code, message }, id: null, jsonrpc: "2.0" });
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return resolved;
}

function closeServer(server: NodeHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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
