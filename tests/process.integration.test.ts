import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("sidecar process", () => {
  it("releases its ownership lock before a signal-initiated exit", async () => {
    const home = await mkdtemp(join(tmpdir(), "scenecap-home-"));
    directories.push(home);
    const port = await unusedPort();
    const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, SCENECAP_PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);

    const startup = await once(child.stderr!, "data");
    expect(String(startup[0])).toContain(`127.0.0.1:${port}/mcp`);
    await expect(readFile(join(home, ".scenecap", "mcp.lock"), "utf8")).resolves.toContain(`"pid":${child.pid}`);

    const exit = once(child, "exit");
    child.kill("SIGTERM");
    const [exitCode] = await exit;
    expect(exitCode).toBe(143);
    await expect(readFile(join(home, ".scenecap", "mcp.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate test port.");
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}
