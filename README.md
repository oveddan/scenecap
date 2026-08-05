# scenecap

`scenecap` is a local, chat-controlled recording orchestrator for macOS. OBS
remains the capture engine: it owns sources, permissions, encoding, and output
files. A singleton TypeScript MCP sidecar provides the narrow, safe control
surface that Claude Code and Codex use to inspect and operate that OBS setup.

The intended workflow is to ask an agent to discover and preview capture
targets, configure the requested OBS sources, and explicitly start or stop a
recording. The result can keep independent sources for editing rather than
baking a composited layout at record time.

## Current direction

Issue #3 supersedes the direct Go + FFmpeg capture path as the active
architecture. That implementation is retained in this repository for
reference and regression evidence; it is not deleted as part of the
migration. FFmpeg is no longer in the capture path. `ffprobe` may remain an
optional, best-effort post-recording validator where it adds useful evidence.

The initial TypeScript server is intentionally read-only. Its first useful tool
is `get_status`, limited to the OBS/version, screen-capture capability, and
Source Record filter capability checks. Recording state and output reporting
remain later status evolution, after recording controls exist.

## Target architecture

```text
Claude Code / Codex
        │  MCP
        ▼
scenecap TypeScript sidecar (singleton, localhost only)
        │  OBS WebSocket
        ▼
OBS: sources, permissions, capture, encoding, files
```

The sidecar is the single local owner of recording-session state. The fixed
port prevents two HTTP listeners from starting, while an atomic per-user
inter-process lock prevents a second sidecar on any port from becoming another
owner. Future mutation tools will build on that boundary so separate agents
cannot race to start or stop OBS.

If the sidecar crashes, its lock is intentionally **not** removed
automatically: automatic stale-lock recovery can race with a newly starting
owner. First confirm that no `scenecap` sidecar process remains; then inspect
and remove `~/.scenecap/mcp.lock` manually before restarting. An unreadable
lock is handled the same way. The startup error distinguishes an active PID,
a stale PID, and an unreadable lock without exposing OBS credentials.

A shared Claude Code/Codex plugin package provides the connection metadata for
this MCP server. We will create recording-driving skills only after using the
real tools enough to identify the stable operational knowledge worth
packaging.

## Setup and initial use

Prerequisites: Node.js 22 or later, pnpm 10, and a running local OBS instance
with WebSocket authentication enabled. Install and configure OBS Source Record
when you need isolated source files; the initial capability check reports
whether its filter is available.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start
```

The built sidecar listens only at `http://127.0.0.1:3233/mcp`. Keep it running,
then connect a local client directly:

```sh
claude mcp add --transport http scenecap http://127.0.0.1:3233/mcp
codex mcp add scenecap --url http://127.0.0.1:3233/mcp
```

These are local MCP connection commands, not marketplace installation
commands. The shared development bundle lives in [`agent-plugin/`](agent-plugin/)
and points both hosts at the same endpoint. It connects to the sidecar; it does
not launch it.

### Configuration

The sidecar always binds to `127.0.0.1`. It reads configuration in this order:

- Set `SCENECAP_OBS_PASSWORD` to use that password directly (the legacy
  `OBS_WEBSOCKET_PASSWORD` is also accepted). In this mode OBS is assumed to
  be `127.0.0.1` on `SCENECAP_OBS_PORT`, defaulting to `4455`.
- Otherwise it reads OBS's WebSocket JSON configuration from
  `SCENECAP_OBS_CONFIG`, or by default from
  `~/Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json`.
  That file must provide a non-empty password; its host, if present, must be
  exactly `127.0.0.1`. `SCENECAP_OBS_PORT` overrides its configured port.
- Set `SCENECAP_PORT` to change the MCP HTTP port from its default of `3233`.
  Because [`agent-plugin/.mcp.json`](agent-plugin/.mcp.json) contains the
  literal default endpoint, a custom port also requires updating that file (or
  configuring the client directly with the matching URL).

All configured ports must be numeric values from 1 through 65535.

For development validation, run:

```sh
pnpm run check
pnpm run build
```

`pnpm run check` lints and type-checks the TypeScript/config surface, runs the
server tests, and verifies that both plugin manifests and `.mcp.json` remain in
sync. The retained Go/FFmpeg tree is frozen, unverified legacy and is
intentionally excluded from this default check.

For a live smoke test, leave OBS and `pnpm start` running in one terminal, then
use the repository's installed MCP SDK client from another:

```sh
pnpm run smoke
```

The command connects over Streamable HTTP, lists tools, calls `get_status`, and
prints both responses. It does not mutate OBS.

Skills remain deliberately deferred until real sessions using these tools
establish a stable workflow worth packaging.

## Planned tools

After `get_status` is proven, the server will add narrow tools rather than a
generic OBS passthrough:

- `list_capture_targets` and `preview_capture_target`
- `configure_session` and `get_session`
- `start_recording` and `stop_recording`
- `restore_obs_state`

The tools must cover the practical capture cases: OBS Source Record for
isolated source files, a phone camera source, and multi-display selection.
They will discover and preview targets instead of relying on guessed window or
display IDs. Configuration will account for encoder-safe aligned dimensions
when an OBS source has an odd or otherwise unsupported size.

## Safety boundaries

- Both OBS WebSocket and the MCP sidecar bind to loopback only; neither is a
  network-exposed remote-control service.
- `get_status` and preflight inspection are read-only. Starting, stopping, or
  changing OBS state is explicit and observable.
- Future mutation tools will snapshot temporary OBS state before changing it
  and restore it on request or safe cleanup.
- Future recording tools will report the final output path and, when
  configured, use `ffprobe` only to validate the completed file—not to capture
  or encode it.

See [PLAN.md](PLAN.md) for the migration milestones.
