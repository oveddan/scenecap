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
network. If the server uses a custom `SCENECAP_PORT`, update `.mcp.json` to the
same port or configure the MCP client directly with that matching URL.

For local development, start the server from the repository root and connect
either client directly:

```sh
pnpm run build
pnpm start
claude mcp add --transport http scenecap http://127.0.0.1:3233/mcp
codex mcp add scenecap --url http://127.0.0.1:3233/mcp
```

The last two commands configure a local MCP connection; they are not
marketplace installation commands. Run only the command for the client being
tested. The checked-in bundle remains the shared source for eventual plugin
distribution.

## Development

Keep the two manifests aligned on identity, version, description, repository,
license, and keywords. Put the MCP connection in `.mcp.json` and reference it
from the Codex manifest. Do not add agent skills, commands, or advertised tool
behavior until the running server and its workflow have been verified.

Validate a change from the repository root with:

```sh
pnpm run check
pnpm run smoke # with OBS and the sidecar running
```

The automated plugin test keeps the Claude and Codex identities, versions,
repositories, and MCP endpoint aligned and rejects premature `skills/` or
`commands/` content. Skills remain deferred until live tool use establishes a
stable operating workflow.
