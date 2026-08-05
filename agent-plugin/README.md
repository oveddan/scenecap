# Scenecap agent plugin

This directory packages the local Scenecap MCP connection for both Claude Code
and Codex. It is developer-facing packaging, not user installation guidance.

## Contents

```
.claude-plugin/plugin.json  Claude Code plugin metadata
.codex-plugin/plugin.json   Codex plugin metadata
.mcp.json                   Scenecap MCP connection configuration
LICENSE                     Standalone MIT license for packaged distribution
```

Both clients connect to the same Streamable HTTP endpoint:

```
http://127.0.0.1:3233/mcp
```

The server is deliberately loopback-only. Run the Scenecap server locally
before using this package; the plugin neither launches it nor exposes it on the
network.

## Development

Keep the two manifests aligned on identity, version, description, repository,
license, and keywords. Put the MCP connection in `.mcp.json` and reference it
from the Codex manifest. Do not add agent skills, commands, or advertised tool
behavior until the running server and its workflow have been verified.

Validate a change from the repository root with:

```sh
python3 /Users/danoved/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py agent-plugin
```
