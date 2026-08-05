import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOOPBACK_HOST = "127.0.0.1" as const;
export const DEFAULT_MCP_PORT = 3233;
export const DEFAULT_OBS_PORT = 4455;
export const DEFAULT_OBS_CONFIG_PATH_SUFFIX = [
  "Library",
  "Application Support",
  "obs-studio",
  "plugin_config",
  "obs-websocket",
  "config.json",
] as const;

export interface SidecarConfig {
  http: {
    host: typeof LOOPBACK_HOST;
    port: number;
  };
  obs: {
    host: typeof LOOPBACK_HOST;
    port: number;
    password: string;
  };
}

interface ObsConfigFile {
  host?: unknown;
  password?: unknown;
  port?: unknown;
  server_password?: unknown;
  server_port?: unknown;
}

export interface ConfigDependencies {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  readConfigFile?: (path: string) => Promise<string>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Reads the password from the environment first. A non-empty environment
 * password short-circuits before resolving a home directory or reading any
 * config file. Otherwise it reads OBS v5's local config (or an explicit
 * SCENECAP_OBS_CONFIG override). Errors never include password material.
 */
export async function loadConfig(
  dependencies: ConfigDependencies = {},
): Promise<SidecarConfig> {
  const env = dependencies.env ?? process.env;
  const password = env.SCENECAP_OBS_PASSWORD ?? env.OBS_WEBSOCKET_PASSWORD;
  const httpPort = parsePort(env.SCENECAP_PORT, DEFAULT_MCP_PORT, "SCENECAP_PORT");
  const envObsPort = parsePort(env.SCENECAP_OBS_PORT, DEFAULT_OBS_PORT, "SCENECAP_OBS_PORT");

  if (isNonEmptyString(password)) {
    return withObsPassword(httpPort, password, envObsPort);
  }

  const configPath =
    env.SCENECAP_OBS_CONFIG ?? join((dependencies.homedir ?? homedir)(), ...DEFAULT_OBS_CONFIG_PATH_SUFFIX);
  let fileConfig: ObsConfigFile;
  try {
    const readConfigFile = dependencies.readConfigFile ?? ((path: string) => readFile(path, "utf8"));
    fileConfig = parseConfigFile(await readConfigFile(configPath));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if (isMissingFile(error)) throw new ConfigError("OBS WebSocket configuration was not found.");
    throw new ConfigError("Unable to read OBS configuration.");
  }

  const host = fileConfig.host === undefined ? LOOPBACK_HOST : parseLoopbackHost(fileConfig.host);
  const configObsPort = parsePort(
    fileConfig.server_port ?? fileConfig.port,
    DEFAULT_OBS_PORT,
    "OBS config port",
  );
  const filePassword = fileConfig.server_password ?? fileConfig.password;
  if (!isNonEmptyString(filePassword)) {
    throw new ConfigError("OBS WebSocket password is required.");
  }

  return {
    http: { host: LOOPBACK_HOST, port: httpPort },
    obs: {
      host,
      port: env.SCENECAP_OBS_PORT === undefined ? configObsPort : envObsPort,
      password: filePassword,
    },
  };
}

function withObsPassword(httpPort: number, password: string, obsPort: number): SidecarConfig {
  return {
    http: { host: LOOPBACK_HOST, port: httpPort },
    obs: { host: LOOPBACK_HOST, port: obsPort, password },
  };
}

function parseConfigFile(contents: string): ObsConfigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new ConfigError("OBS configuration must be valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError("OBS configuration must be a JSON object.");
  }
  return parsed as ObsConfigFile;
}

function parseLoopbackHost(value: unknown): typeof LOOPBACK_HOST {
  if (value !== LOOPBACK_HOST) {
    throw new ConfigError("OBS host must be the literal IPv4 loopback address 127.0.0.1.");
  }
  return LOOPBACK_HOST;
}

export function parsePort(
  value: unknown,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535) {
    return value;
  }
  if (typeof value === "string" && /^(?:[1-9]\d{0,4})$/.test(value)) {
    const parsed = Number(value);
    if (parsed <= 65535) {
      return parsed;
    }
  }
  throw new ConfigError(`${name} must be a numeric port from 1 to 65535.`);
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
