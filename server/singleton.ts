import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface LockRecord {
  pid: number;
  token: string;
}

export interface ProcessSingletonDependencies {
  isProcessAlive?: (pid: number) => boolean;
  lockPath?: string;
  pid?: number;
  token?: string;
}

/**
 * Cross-process singleton backed by an atomic per-user lock file. The lock
 * contains a random owner token, so only its creator can remove it.
 */
export class ProcessSingleton {
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #lockPath: string;
  readonly #pid: number;
  readonly #token: string;
  #acquired = false;

  constructor(dependencies: ProcessSingletonDependencies = {}) {
    this.#isProcessAlive = dependencies.isProcessAlive ?? isProcessAlive;
    this.#lockPath = dependencies.lockPath ?? join(homedir(), ".scenecap", "mcp.lock");
    this.#pid = dependencies.pid ?? process.pid;
    this.#token = dependencies.token ?? randomUUID();
  }

  async acquire(): Promise<void> {
    if (this.#acquired) return;
    await mkdir(dirname(this.#lockPath), { recursive: true, mode: 0o700 });
    try {
      await this.#publishOwnerRecord();
      this.#acquired = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      throw await this.#existingLockError(error);
    }
  }

  async release(): Promise<void> {
    if (!this.#acquired) return;
    this.#acquired = false;
    const owner = await readLockRecord(this.#lockPath);
    if (owner?.token === this.#token && owner.pid === this.#pid) {
      await unlink(this.#lockPath).catch(() => undefined);
    }
  }

  async #existingLockError(cause: unknown): Promise<Error> {
    const owner = await readLockRecord(this.#lockPath);
    if (!owner) {
      return new Error(
        `Scenecap MCP lock is unreadable. Inspect and remove it manually after confirming no sidecar is running: ${this.#lockPath}`,
        { cause },
      );
    }
    if (this.#isProcessAlive(owner.pid)) {
      return new Error(`Another scenecap MCP sidecar is already running (PID ${owner.pid}).`, { cause });
    }
    return new Error(
      `A stale scenecap MCP lock was found (PID ${owner.pid}). Inspect and remove it manually after confirming no sidecar is running: ${this.#lockPath}`,
      { cause },
    );
  }

  async #publishOwnerRecord(): Promise<void> {
    const temporaryPath = `${this.#lockPath}.owner-${this.#token}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: this.#pid, token: this.#token } satisfies LockRecord));
      await handle.sync();
      await handle.close();
      handle = undefined;
      // link(2) fails atomically when another owner already published its lock.
      await link(temporaryPath, this.#lockPath);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

async function readLockRecord(path: string): Promise<LockRecord | undefined> {
  try {
    const candidate: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      typeof (candidate as LockRecord).pid === "number" &&
      typeof (candidate as LockRecord).token === "string"
    ) {
      return candidate as LockRecord;
    }
  } catch {
    // A malformed or unreadable lock cannot prove an active owner.
  }
  return undefined;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
