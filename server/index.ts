import { loadConfig } from "./config.js";
import { McpHttpSidecar } from "./http.js";
import { createMcpServer } from "./mcp.js";

const config = await loadConfig();
const sidecar = new McpHttpSidecar(config, {
  createMcpServer: () => createMcpServer(config),
});

await sidecar.start();
console.error(`scenecap MCP listening at http://${config.http.host}:${config.http.port}/mcp`);

const stop = async () => {
  await sidecar.stop();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
