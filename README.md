# scenecap

`scenecap` is an experimental macOS recorder that keeps each capture source in
its own high-quality file for later editing. The project is currently proving
its most important architectural assumption: which executable macOS assigns
Screen Recording, Camera, and Microphone permissions to when FFmpeg performs
the capture.

The first runnable slice is a single-source foreground screen recorder. It
writes a session manifest before starting FFmpeg, shuts FFmpeg down gracefully
on `SIGINT`/`SIGTERM`, and validates the resulting file with `ffprobe`.

```sh
make build
./scenecap doctor
./scenecap evidence --out ./evidence --case terminal-baseline
./scenecap encoder-check
./scenecap devices
./scenecap record --device "Capture screen 0" --out ./sessions
```

`evidence` and `encoder-check` are prompt-free diagnostics: they do not open or
enumerate AVFoundation devices. Evidence JSON records bounded tool and signing
diagnostics, hashes the exact executables, and is atomically installed at the
requested path. If `--out` names a directory (or a new path without a `.json`
extension), scenecap generates a timestamped filename inside it.
The captured FFmpeg `-devices` output is a list of compiled device backends, not
an enumeration of attached cameras, microphones, or screens; it is the source
for `avfoundation_listed`, while `-formats` remains general build evidence.
Evidence schema version 2 uses `null` for compiled/listed conclusions when the
supporting command failed or its bounded output was truncated; `false` is
reserved for a complete, successful query that did not find the capability.
Diagnostic subprocesses have a per-command deadline. Tool fingerprints include
device/inode, size, modification time, mode/owner, and SHA-256 and are checked
again around command use; a change fails the operation instead of emitting a
known-stale identity.

`encoder-check` reports `h264_videotoolbox` as two separate facts: whether
FFmpeg lists it and whether a one-frame synthetic `lavfi` encode actually
works. A listed encoder can still be non-operational, in which case the command
prints JSON diagnostics and exits nonzero.
Encoder-check schema version 2 applies the same `true`/`false`/`null` rule to
the encoder listing. Its operational result is `null` when cancellation or a
timeout prevented the probe from completing, `false` for a completed failed
probe, and `true` only for a completed successful encode.

`devices` and `record` cross the privacy boundary and may trigger macOS privacy
prompts. Both accept `--ffmpeg`; `record` also accepts `--ffprobe`. See
[PLAN.md](PLAN.md) for the human-run TCC experiment and limitations. No command
reads or resets the TCC database, installs a LaunchAgent, changes signing state,
or claims that a permission has been granted.

Executable identity is a local evidence snapshot, not a cryptographic
attestation against a malicious or concurrently controlled filesystem. The
last-moment fingerprint checks narrow ordinary replacement races but cannot
eliminate the interval between checking a pathname and the kernel executing it.
Selected scenecap, FFmpeg, and FFprobe tools must be readable, nonempty regular
files with an executable mode bit. Execute-only binaries are unsupported:
scenecap fails with an inspection error instead of emitting an identity whose
SHA-256 it could not verify.
Record manifests resolve FFprobe again when recording ends, store that current
identity and the exact probe arguments, and then validate with it. This permits
a legitimate FFprobe symlink upgrade during a long recording while keeping the
manifest aligned with the executable actually used.
