import { ProcessSingleton } from "../../server/singleton.js";

const [lockPath, mode] = process.argv.slice(2);
if (!lockPath || !mode) throw new Error("Expected lock path and mode.");

const singleton = new ProcessSingleton({ lockPath });
try {
  await singleton.acquire();
  process.stdout.write("acquired\n");
  if (mode === "try") {
    await singleton.release();
  } else {
    const keepAlive = setInterval(() => undefined, 1_000);
    process.once("SIGTERM", () => {
      clearInterval(keepAlive);
      void singleton.release().finally(() => process.exit(0));
    });
  }
} catch {
  process.stdout.write("blocked\n");
  process.exitCode = 1;
}
