import { describe, expect, it } from "vitest";

import { loadConfig } from "../server/config.js";

describe("loadConfig", () => {
  it("takes a password from the environment before reading the config password", async () => {
    const config = await loadConfig({
      env: {
        SCENECAP_OBS_CONFIG: "/private/config.json",
        SCENECAP_OBS_PASSWORD: "environment-secret",
      },
      readConfigFile: async () => {
        throw new Error("config should not be read");
      },
    });

    expect(config).toEqual({
      http: { host: "127.0.0.1", port: 3233 },
      obs: { host: "127.0.0.1", password: "environment-secret", port: 4455 },
    });
  });

  it("uses a config password only when no password environment variable is set", async () => {
    const config = await loadConfig({
      env: { SCENECAP_OBS_CONFIG: "/private/config.json" },
      readConfigFile: async () =>
        JSON.stringify({ host: "127.0.0.1", server_password: "file-secret", server_port: 4455 }),
    });

    expect(config.obs.password).toBe("file-secret");
  });

  it("does not resolve home or read config when a password environment variable exists", async () => {
    const config = await loadConfig({
      env: { SCENECAP_OBS_PASSWORD: "environment-secret" },
      homedir: () => {
        throw new Error("home should not be resolved");
      },
      readConfigFile: async () => {
        throw new Error("config should not be read");
      },
    });

    expect(config.obs).toEqual({ host: "127.0.0.1", password: "environment-secret", port: 4455 });
  });

  it("allows a numeric custom OBS port with an environment password without reading config", async () => {
    const config = await loadConfig({
      env: { SCENECAP_OBS_PASSWORD: "environment-secret", SCENECAP_OBS_PORT: "4456" },
      homedir: () => {
        throw new Error("home should not be resolved");
      },
    });

    expect(config.obs.port).toBe(4456);
  });

  it("reads OBS v5's default config path and server_password key", async () => {
    let requestedPath = "";
    const config = await loadConfig({
      env: {},
      homedir: () => "/Users/example",
      readConfigFile: async (path) => {
        requestedPath = path;
        return JSON.stringify({ server_password: "file-secret", server_port: 4456 });
      },
    });

    expect(requestedPath).toBe(
      "/Users/example/Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json",
    );
    expect(config.obs).toEqual({ host: "127.0.0.1", password: "file-secret", port: 4456 });
  });

  it("does not let an empty SCENECAP_OBS_PORT override OBS config", async () => {
    const config = await loadConfig({
      env: { SCENECAP_OBS_CONFIG: "/private/config.json", SCENECAP_OBS_PORT: "" },
      readConfigFile: async () => JSON.stringify({ server_password: "file-secret", server_port: 4456 }),
    });

    expect(config.obs.port).toBe(4456);
  });

  it.each([
    [{ SCENECAP_PORT: "0" }, "SCENECAP_PORT"],
    [{ SCENECAP_PORT: "3233.5" }, "SCENECAP_PORT"],
    [{ SCENECAP_PORT: "65536" }, "SCENECAP_PORT"],
    [{ SCENECAP_OBS_PORT: "not-a-port" }, "SCENECAP_OBS_PORT"],
  ])("rejects a non-numeric or unsafe port", async (env, message) => {
    await expect(loadConfig({ env })).rejects.toMatchObject({ message: expect.stringContaining(message) });
  });

  it("rejects any OBS host other than literal IPv4 loopback", async () => {
    await expect(
      loadConfig({
        env: { SCENECAP_OBS_CONFIG: "/private/config.json" },
        readConfigFile: async () => JSON.stringify({ host: "localhost" }),
      }),
    ).rejects.toThrow("literal IPv4 loopback");
  });

  it("refuses missing or invalid OBS passwords without leaking a file secret", async () => {
    const failure = await loadConfig(
      {
        env: { SCENECAP_OBS_CONFIG: "/private/config.json" },
        readConfigFile: async () => JSON.stringify({ server_password: { secret: "never-show-this" } }),
      },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: "OBS WebSocket password is required." });
    expect(String(failure)).not.toContain("never-show-this");
    await expect(
      loadConfig({
        env: { SCENECAP_OBS_CONFIG: "/private/config.json" },
        readConfigFile: async () => JSON.stringify({ server_password: "" }),
      }),
    ).rejects.toThrow("password is required");
  });
});
