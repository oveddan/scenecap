# scenecap — plan

## Problem

OBS is annoying to set up for solo documentation recording (screen + webcam +
audio, sometimes an external capture like an LED wall or a controller).
Composited-scene tools bake layout/framing decisions in at record time. Want
a CLI/daemon tool that:

- captures each source independently (own file, own settings, own quality)
- lets composition (crop, zoom, arrangement, timing) happen later, in edit —
  full native resolution preserved for that
- is scriptable/agent-drivable (an agent can say "start recording the
  screen" without a human touching a GUI)
- aims to scope macOS Screen Recording / Camera / Mic permission to *this
  tool specifically*, not to a shared shell or interpreter — an architectural
  goal Milestone 0 must prove, not an assumed property of a Go binary

## Non-goals (v1)

- Live preview / compositing while recording
- Adding/removing sources mid-recording (prepare sources, then start
  together; stop together)
- Streaming, virtual camera, replay buffer — none of the OBS live-production
  features
- Cross-platform support beyond macOS for v1 (avfoundation-specific capture
  paths; can generalize later)

## Why Go

- Subprocess orchestration (`os/exec`) and concurrency (goroutines for N
  simultaneous ffmpeg processes) are Go's strong suit
- Compiles to a single binary and has good macOS tooling. A stable signed
  identity may help with permission scoping, but macOS TCC uses responsible
  code attribution; Milestone 0 decides whether the final runtime substrate
  can be a binary, a LaunchAgent, or must be an app bundle.
- Mature, well-documented macOS code-signing tooling for Go binaries

## Architecture

FFmpeg does all actual capture/encode work; scenecap is a thin Go
orchestrator around it.

```
scenecap record --source screen:device="Capture screen 0",fps=30
scenecap record --config session.json
scenecap pause / resume     # timeline markers; capture remains continuous
scenecap stop               # stops all source processes

scenecap combine --layout <spec> -o output.mp4   # mux/encode into one video
scenecap list                # show configured sources + recording status
```

### Per-source capture

- Each source = one `ffmpeg -f avfoundation ...` subprocess, own resolution/
  fps/quality flags, own output file. Note: legacy AVFoundation screen
  capture is a compatibility risk long-term — Apple is steering toward
  ScreenCaptureKit — but fine to start with since ffmpeg's avfoundation
  input still works today.
- Device indices (`--device 1`) are unstable across reconnects/reboots —
  persist device *names* and resolve to current index at record time. Add
  a `probe`/`devices` command to enumerate what's actually available and
  preflight each source before starting.
- A launch timestamp is not the same as "first frame captured" — device
  negotiation, permission prompts, and encoder startup add variable delay
  (can be hundreds of ms). The session manifest should capture more than
  one timestamp per source:
  - monotonic + wall-clock launch time
  - actual first/last media timestamp (from ffmpeg progress output or the
    resulting file)
  - negotiated format (actual fps/resolution, which may differ from
    requested)
  - ffmpeg command, version, and exit status
- This gets you close alignment, not frame-exact hardware sync, and won't
  by itself catch long-run drift between independent device clocks — plan
  to validate with a clap test on a 30-60 min recording before trusting it
  for longer sessions.
- Shutdown must be graceful (clean ffmpeg exit, then escalate) — killing
  ffmpeg abruptly can leave MOV/MP4 files without finalized metadata.

### Pause/resume

FFmpeg has no native mid-recording pause. Keep capture running and record
session-level pause/resume markers in the manifest. The editor handoff or
export step can remove those wall-clock intervals from every continuous
source. This spends disk space in exchange for avoiding device reacquisition,
format renegotiation, segment concat constraints, and per-source seam drift.

### Combine step

More than a single `-itsoffset` per input — `-itsoffset` only shifts input
timestamps, it doesn't create missing media, correct drift, or define
overlay/background behavior when a source ends before others. Expect to
build a generated `filter_complex` (trim, setpts/asetpts, audio delay or
silence, video freeze/filler, concat/overlay) with an explicit
output-duration policy. Also: the concat demuxer requires matching stream
properties across segments, so keep segment encoding settings consistent
within a source.

Reads sidecars for all sources in a session, computes per-source offsets
from the earliest start time, and does the final encode (H.264 or HEVC,
user-selectable quality/bitrate) into one deliverable file. Layout
(positions/sizes/crops) supplied via a simple spec (CLI flags to start; a
small JSON/YAML layout file once flags get unwieldy).

### Permission scoping

**Not settled — this is an assumption to verify, not a given.** macOS TCC
uses "responsible code" attribution: a helper process's permission can be
recorded against a launching/containing app rather than the process that
literally calls the capture API. A compiled Go binary does not automatically
get its own isolated grant just by being a static binary — that has to be
tested empirically per launch context (Terminal, an agent host, installed
location) and per permission type (screen, camera, mic — they can behave
differently).

Also: if TCC ends up attributing the grant to `/opt/homebrew/bin/ffmpeg`
rather than to scenecap, that reintroduces the shared-binary problem —
Homebrew's ffmpeg is shared by everything else on the machine that calls it.

Fallback if plain compiled-binary + external ffmpeg doesn't achieve
isolation: package scenecap as a signed `.app` bundle with a stable bundle
identifier and `NSCameraUsageDescription`/`NSMicrophoneUsageDescription` in
its `Info.plist`, with a long-lived supervisor process that owns capture
(bundling ffmpeg or calling ScreenCaptureKit directly). This is the
Milestone 0 spike below — treat it as an architectural gate, not a detail
to confirm after the fact.

Signing: ad-hoc signatures are tied to that specific build's designated
requirement — rebuilding commonly resets the TCC prompt. Use a consistent
signing identity (Developer ID or a stable dev cert), not plain ad-hoc.

"Audio" also needs to be split: `microphone`/`audio-device` (avfoundation
audio input) vs. `system-audio` (requires ScreenCaptureKit or a loopback
device like BlackHole — avfoundation alone won't capture system output).

## Milestones (each one runnable/demoable before moving to the next)

Resequenced after Codex review: TCC attribution and the need for a
persistent supervisor are foundational risks, not late-stage details, so
they move up. A CLI framework (cobra/etc.) is deliberately deferred — not
needed to learn the actual hard parts, and the stdlib is easier to reason
about for a first Go project.

0. **Environment/TCC spike** — answer the decisive question first: can a
   scenecap-owned identity hold Screen Recording, Camera, and Mic grants that
   Terminal does not confer? Test a stable signed binary from Terminal, the
   same identity as a LaunchAgent, then a signed app with a bundled/re-signed
   ffmpeg, stopping at the first reliable shape. Include launchd in the test
   matrix; verify grants across rebuild/restart, usage-description and
   hardened-runtime requirements, system-audio strategy, and
   `h264_videotoolbox` on this Mac. Record the macOS version and exact signing
   identity. This remains an interactive gate.

### Milestone 0 human-run experiment

Build once, place that unchanged binary at the path being evaluated, and use
the same explicit FFmpeg/FFprobe paths for every row. Before opening any capture
device, collect prompt-free evidence and test the hardware encoder:

```sh
./scenecap evidence --out ./evidence --case terminal \
  --ffmpeg /absolute/path/to/ffmpeg --ffprobe /absolute/path/to/ffprobe
./scenecap encoder-check --ffmpeg /absolute/path/to/ffmpeg
```

Repeat the evidence command from each launch context that already exists. Do
not install or alter a LaunchAgent merely to run this matrix.

| Case label | Existing launch context | Prompt-free evidence | Human capture action | Human observation to record |
| --- | --- | --- | --- | --- |
| `terminal` | Terminal, direct invocation | `evidence`, then `encoder-check` | `devices`, then a short `record` | Exact prompt wording and the System Settings entry shown |
| `agent-host` | The agent host, direct invocation | same commands with this case label | same short screen capture, initiated by the human | Whether attribution differs from Terminal |
| `launchd-existing` | An already-configured launchd job, if one exists | have that job invoke `evidence` | only after reviewing the evidence identity | Responsible entry and persistence after restart |
| `stable-restart` | Same path, bytes, and launch context after restart | collect a fresh evidence file | repeat the same short capture | Whether the prior decision persists without a prompt |
| `rebuilt-binary` | Same path and context after an intentional rebuild | collect evidence and compare hash/signing fields | repeat only when ready for a new prompt | Whether identity/attribution changed |

For each applicable context, test Screen Recording, Camera, and Microphone as
separate rows in the experiment log; macOS may attribute them differently. The
current recorder implements only a screen source, so camera and microphone
tests require a separate, explicitly human-run FFmpeg command until scenecap
supports those sources. Preserve the evidence JSON next to the written notes;
do not infer permission state from a successful codesign check or from an
encoder result.

Current diagnostic limitations:

- Evidence describes executables and launch context but never reads the TCC
  database and cannot say which process owns a grant.
- Codesign verification, display, requirements, and entitlement failures are
  data in the report, not evidence-collection failures and not grant status.
- Launch-context fields intentionally contain only descriptor categories and
  boolean environment hints; they omit environment values, arguments, user
  names, and parent command lines.
- `avfoundation_compiled` is a prompt-free check that FFmpeg can display help
  for that demuxer; `avfoundation_listed` is parsed from FFmpeg's compiled
  device-backend listing (`-devices`). Neither
  proves device access.
- Evidence schema version 2 represents derived compiled/listed conclusions as
  `null` when their source command failed or was truncated. A clean complete
  absence is `false`; only a clean positive marker is `true`.
- `encoder-check` uses only a generated color frame. It proves neither capture
  access nor sustained encode performance.
- Encoder-check schema version 2 reports operational status as `null` when its
  probe is canceled or times out, rather than conflating an incomplete probe
  with a completed encoder failure.
- FFmpeg diagnostic output is bounded, so unusually large listings are marked
  truncated.
- Every diagnostic subprocess has a deadline. A timeout is preserved as a
  bounded command error rather than allowing evidence collection to hang.
- Executable fingerprints are local snapshots with last-moment revalidation,
  not cryptographic attestation against a malicious filesystem. Device/inode,
  metadata, and SHA-256 comparisons reduce ordinary replacement races but do
  not remove the final pathname-to-exec interval.
- Selected scenecap, FFmpeg, and FFprobe paths must be readable, nonempty
  regular files with an executable mode bit. Execute-only binaries are
  unsupported so evidence never records an identity with an unverifiable hash.
- FFprobe is resolved again at validation time, and manifest v2 is updated with
  the identity and exact arguments actually used. If it is unavailable then,
  validation fails with the resolution diagnostic instead of silently skipping
  the probe or rejecting a legitimate symlink upgrade as stale.
0.5. **Final-shape hello world** — immediately encode the winning M0 runtime
   shape in the build. It prints its signing identity and invokes its selected
   ffmpeg's `-version`; every later milestone runs inside this same substrate.
1. **Single-source foreground session** — one declarative `record` command,
   with no mutable global config. Preflight dependencies and disk headroom,
   create the session directory, atomically write a versioned manifest before
   spawning ffmpeg, override `exec.CommandContext` cancellation so ffmpeg gets
   SIGINT before forced escalation, and ffprobe the result for nonzero duration,
   video streams, and readable frames. The initial implementation covers the
   process, manifest, and validation core; capture remains provisional until
   Milestone 0 is complete.
2. **Session format hardening** — append-only event history and recovery data,
   actual negotiated media properties, ffmpeg/macOS versions, disk space and
   bytes written, and a `recover` command for interrupted sessions.
3. **Supervisor + minimal CLI** — Unix-socket control, `start`/`status`/
   `stop`. This is core architecture (something must stay alive to own the
   ffmpeg processes across separate CLI invocations), not an optional
   agent-control add-on — moved up from originally being the last
   milestone.
4. **Multi-source capture** — concurrent sources via goroutines, preflight
   via the `probe` command, coordinated start/stop, partial-start rollback,
   disk-space checks, then a long (30-60 min) drift test.
5. **Alignment proof** — a diagnostic combine or a manual Premiere-import
   workflow, validated with a clap test, before committing to a general
   layout engine.
6. **Editor handoff** — emit an editor-friendly timeline (FCPXML or another
   format proven to import cleanly into Premiere) with source offsets. Native
   combine and layout generation are post-v1 unless handoff is insufficient.
7. **Pause/resume** — write shared logical timeline markers while continuous
   capture keeps running; apply them during editor handoff/export.
8. **Distribution** — notarization, installation, upgrades, and identity
   stability. The runtime artifact shape and bundled-vs-system ffmpeg decision
   are made immediately after Milestone 0, not deferred here.

## Open questions

- Layout spec format for `combine` — flags vs. a JSON/YAML file — defer
  until Milestone 4 when the actual pain point is clear
- Whether `combine` should live in scenecap at all vs. just being "here are
  your synced source files + timestamps, bring your own editor" (Premiere,
  per earlier conversation) — Milestones 1-3 don't depend on this answer
- HEVC vs H.264 default for combine output — revisit once hardware encoder
  access from ffmpeg on this Mac is confirmed
