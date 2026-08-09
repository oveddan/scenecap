# scenecap — plan

## Problem

Recording a solo demo often needs a screen (sometimes several displays), a
phone camera, microphone/audio, and separate high-quality assets for editing.
OBS already handles macOS capture permissions, device integration, encoders,
and recording reliability well. What it lacks is a deliberately constrained,
chat-friendly control layer.

`scenecap` will make OBS controllable from Claude Code and Codex without
turning either agent into a general-purpose OBS remote control.

## Architecture

OBS is the capture engine. It owns source configuration, macOS permissions,
Source Record outputs, camera and display capture, encoding, and final media
files. A TypeScript MCP server runs as a singleton local sidecar and owns
scenecap's session and safety state. Claude Code and Codex connect through a
shared plugin package that contains only the connection/install packaging.

```text
Claude Code / Codex plugins
             │ MCP
             ▼
TypeScript scenecap sidecar (one local process)
             │ OBS WebSocket, localhost
             ▼
OBS capture engine → Source Record / camera / display files
```

The singleton is important: multiple chat sessions must not race over the same
recording. A fixed listening port only prevents duplicate HTTP listeners; it
does not prove which process owns a future recording mutation. An atomic
per-user inter-process lock now establishes that owner independently of the
chosen HTTP port. That owner will also hold snapshots of temporary OBS state
and the information needed to restore it after a session.

Crash recovery for the process lock is deliberately fail-closed. A stale or
unreadable `~/.scenecap/mcp.lock` is never automatically removed because a
reader could otherwise delete a newly published owner (an ABA race). After a
crash, confirm no sidecar process remains, then inspect and remove that lock
manually. Startup errors identify active, stale, and unreadable locks without
revealing OBS credentials.

### Security model

- The sidecar and OBS WebSocket listen on loopback only. Do not expose them to
  a LAN, the public internet, or a tunnel.
- MCP starts with read-only status and preflight. Mutating calls are small,
  named operations with clear confirmation semantics; there is no raw
  `call_obs`/generic WebSocket passthrough tool.
- Before a mutation, capture enough OBS state to restore temporary changes.
- Report outputs and failures clearly. `ffprobe` is an optional post-recording
  validation dependency only; FFmpeg is not used to capture or encode.

### Plugin packaging

Ship one `agent-plugin/` bundle compatible with both Claude Code and Codex.
It configures how each host connects to the local sidecar and carries
documentation appropriate to installation. It does not grant network access
or replace the sidecar's loopback restrictions.

Do **not** create a recording-driving skill yet. First use the real tools
against OBS and observe the recurring decisions, failure modes, and recovery
steps. Package those tested practices as a skill only once they are stable.

## Initial tool surface

Start with one read-only preflight tool:

- `get_status`: exactly three read-only capability requests: OBS/version,
  screen-capture capability, and Source Record filter capability. Recording
  state and output location are future status evolution, after the associated
  recording controls exist.

Then introduce narrow tools in this order:

1. `list_capture_targets` — discover valid displays, windows, camera sources,
   and existing OBS capture sources; never require guessed identifiers.
2. `preview_capture_target` — provide a safe preview/description to confirm a
   selected display, window, or camera before recording.
3. `configure_capture_target` and `get_session` — persist one discovered
   target on an allowlisted OBS input, record a shared recovery contract, and
   express intended capture outputs including a phone camera and multi-display
   capture. Configure an owned per-source Source Record filter with inherited
   OBS-profile defaults and bounded output overrides.
4. `start_recording` and `stop_recording` — explicit recording mutations with
   ownership and output reporting.
5. `restore_obs_state` — restore a snapshot after temporary configuration.

Source configuration applies encoder-safe aligned dimensions only to its
per-source Source Record encoder. When it applies encoder settings, the sidecar must use that
documented aligned-dimension workaround rather than creating a recording that
silently fails or is distorted; it must not blindly alter a camera preset or
scene transform to achieve alignment.

## Migration status

The existing Go CLI and its direct FFmpeg capture path are retired/superseded
as the forward-looking design. That tree is frozen, unverified legacy and is
excluded from the default TypeScript check. Keep it in place during migration:
it is useful evidence for prior manifest, graceful shutdown, and validation
work. Do not delete it merely to make the repository look TypeScript-only. New
capture behavior belongs in OBS plus the TypeScript sidecar.

## Milestones

0. **Repository and runtime scaffold** — add TypeScript build/test tooling,
   an executable MCP server entry point, configuration schema, and the shared
   Claude Code/Codex plugin connection metadata. Bind only to loopback.
1. **Read-only OBS handshake** — implement `get_status`; test no-OBS,
   unavailable WebSocket, authentication failure, and reachable OBS states.
   This is the first runnable acceptance slice.
2. **Discovery and preview** — implement capture-target listing and preview;
   prove selection of a phone camera and more than one display without guessed
   IDs.
3. **Session configuration** — model Source Record and other requested source
   outputs, validate output destinations, calculate/communicate any required
   dimension alignment, and persist a restorable OBS snapshot.
4. **Controlled recording** — add `start_recording`, `stop_recording`, and
   `restore_obs_state`; enforce a single active scenecap session and verify
   the reported recording outputs. Add optional `ffprobe` validation only
   after an output exists.
5. **Real-world hardening** — exercise the tools in actual chat-led recording
   sessions; improve recovery around OBS restarts, inactive scenes/black
   frames, source availability, and partial output failures.
6. **Skill extraction** — only after Milestone 5 reveals repeatable,
   well-tested operator practice, create a Claude/Codex skill from that
   evidence.

## Non-goals (v1)

- Reimplementing OBS capture, encoding, or macOS permission handling in
  scenecap.
- A generic unrestricted OBS command transport.
- Exposing recording controls off the local machine.
- Automatic changes to an OBS scene without a tool call that states the
  intended mutation.
- Streaming, virtual camera, and other live-production features not needed
  for recorded documentation.
