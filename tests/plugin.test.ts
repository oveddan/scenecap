import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

interface PluginManifest {
  author?: unknown;
  commands?: unknown;
  keywords?: unknown;
  license?: unknown;
  mcpServers?: unknown;
  name?: unknown;
  repository?: unknown;
  skills?: unknown;
  version?: unknown;
}

interface McpConfig {
  mcpServers?: Record<string, { type?: unknown; url?: unknown }>;
}

const pluginRoot = resolve(process.cwd(), "agent-plugin");
const claude = readJson<PluginManifest>(".claude-plugin/plugin.json");
const codex = readJson<PluginManifest>(".codex-plugin/plugin.json");
const mcp = readJson<McpConfig>(".mcp.json");

describe("agent plugin bundle", () => {
  it("keeps host manifest identity and release metadata aligned", () => {
    expect(claude.name).toBe("scenecap");
    expect(codex.name).toBe(claude.name);
    expect(codex.version).toBe(claude.version);
    expect(codex.repository).toBe(claude.repository);
    expect(codex.author).toEqual(claude.author);
    expect(codex.license).toBe(claude.license);
    expect(codex.keywords).toEqual(claude.keywords);
  });

  it("keeps both hosts on the fixed loopback MCP endpoint", () => {
    expect(codex.mcpServers).toBe("./.mcp.json");
    expect(Object.keys(mcp.mcpServers ?? {})).toEqual(["scenecap"]);
    expect(mcp.mcpServers?.scenecap).toEqual({
      type: "http",
      url: "http://127.0.0.1:3233/mcp",
    });
  });

  it("does not ship skills or commands before live workflows are proven", () => {
    expect(claude.skills).toBeUndefined();
    expect(claude.commands).toBeUndefined();
    expect(codex.skills).toBeUndefined();
    expect(codex.commands).toBeUndefined();
    expect(existsSync(resolve(pluginRoot, "skills"))).toBe(false);
    expect(existsSync(resolve(pluginRoot, "commands"))).toBe(false);
  });
});

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(pluginRoot, relativePath), "utf8")) as T;
}
