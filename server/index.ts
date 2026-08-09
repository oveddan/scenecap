import { loadServerConfig } from "./config.js";
import { CaptureSessionStore } from "./capture-session.js";
import { McpHttpSidecar } from "./http.js";
import { createMcpServer } from "./mcp.js";
import { ProcessSingleton } from "./singleton.js";

const config = loadServerConfig();
// HTTP creates one McpServer per client session. Keep configuration state in
// this process-owned store so all of those sessions see the same atomic view.
const captureSessionStore = new CaptureSessionStore();
const sidecar = new McpHttpSidecar(config, {
  createMcpServer: () => createMcpServer(config, undefined, undefined, captureSessionStore),
});
const singleton = new ProcessSingleton();

const stop = async () => {
  try {
    await sidecar.stop();
  } finally {
    await singleton.release();
  }
};

let shutdownStarted = false;
const shutdown = (exitCode: number) => {
  if (shutdownStarted) return;
  shutdownStarted = true;

  // Keep the process alive after its listening socket closes so the async
  // lock-file cleanup completes before a signal-initiated exit.
  const keepAlive = setInterval(() => undefined, 1_000);
  void stop()
    .catch((error: unknown) => {
      process.exitCode = 1;
      console.error(error instanceof Error ? error.message : "Unable to stop scenecap cleanly.");
    })
    .finally(() => {
      clearInterval(keepAlive);
      process.exit(process.exitCode ?? exitCode);
    });
};

try {
  await singleton.acquire();
  await sidecar.start();
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));
  console.error(`scenecap MCP listening at http://${config.http.host}:${config.http.port}/mcp`);
} catch (error) {
  await singleton.release();
  console.error(error instanceof Error ? error.message : "Unable to start scenecap.");
  process.exitCode = 1;
}
