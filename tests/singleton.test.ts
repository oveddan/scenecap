import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { ProcessSingleton } from "../server/singleton.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("ProcessSingleton", () => {
  it("recovers a stale lock and never removes a lock owned by another token", async () => {
    const lockPath = await temporaryLockPath();
    await writeFile(lockPath, JSON.stringify({ pid: 999_999, token: "stale" }));
    const singleton = new ProcessSingleton({
      isProcessAlive: () => false,
      lockPath,
      pid: 123,
      token: "current-owner",
    });

    await singleton.acquire();
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual({ pid: 123, token: "current-owner" });
    await writeFile(lockPath, JSON.stringify({ pid: 456, token: "different-owner" }));
    await singleton.release();
    expect(await readFile(lockPath, "utf8")).toContain("different-owner");
  });

  it("atomically publishes only one fully initialized owner record", async () => {
    const lockPath = await temporaryLockPath();
    const first = new ProcessSingleton({ lockPath, pid: process.pid, token: "first" });
    const second = new ProcessSingleton({ lockPath, pid: process.pid, token: "second" });
    const results = await Promise.allSettled([first.acquire(), second.acquire()]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ pid: process.pid });
    await first.release();
    await second.release();
  });

  it("enforces the lock across two child processes regardless of HTTP port", async () => {
    const lockPath = await temporaryLockPath();
    const holder = child(lockPath, "hold");
    await expectOutput(holder, "acquired");

    const blocked = child(lockPath, "try");
    const blockedExit = once(blocked, "exit");
    await expectOutput(blocked, "blocked");
    expect((await blockedExit)[0]).toBe(1);

    const holderExit = once(holder, "exit");
    holder.kill("SIGTERM");
    expect((await holderExit)[0]).toBe(0);

    const afterRelease = child(lockPath, "try");
    const afterReleaseExit = once(afterRelease, "exit");
    await expectOutput(afterRelease, "acquired");
    expect((await afterReleaseExit)[0]).toBe(0);
  });
});

async function temporaryLockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "scenecap-singleton-"));
  directories.push(directory);
  return join(directory, "mcp.lock");
}

function child(lockPath: string, mode: "hold" | "try"): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "tests/fixtures/singleton-child.ts", lockPath, mode], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function expectOutput(childProcess: ChildProcess, expected: string): Promise<void> {
  const output = await new Promise<string>((resolve, reject) => {
    childProcess.stdout?.once("data", (chunk: Buffer) => resolve(chunk.toString()));
    childProcess.once("error", reject);
  });
  expect(output).toBe(`${expected}\n`);
}
