# scenecap v1 plan

## Direction

v1 uses OBS as the capture and permissions-owning backend, with the
third-party Source Record filter writing one file per prepared source.
`scenecap` will be a small local controller and session tracker; it does not
replace OBS's compositing engine or try to reimplement macOS capture.

This choice is based on a working empirical prototype:

- Multiple displays capture successfully in OBS.
- Inactive scenes render black. Prefer Studio Preview; if a Program scene must
  be activated, save the old Program scene, make the change under a guard, and
  restore it afterwards.
- Native captures 2722 and 1822 pixels wide corrupted Apple VideoToolbox output
  through stride handling. Near-native GPU scaling to aligned widths of 2688
  and 1792 pixels respectively fixed the issue.
- Source Record's vendor path can mutate output filenames, so controllers must
  discover/report the final filename rather than trust a requested one.
- Source Record is an external plugin with its own compatibility and lifecycle
  risk.
- TCC is owned by OBS. This intentionally removes the prior FFmpeg experiment's
  permission-attribution question from the v1 critical path.

The legacy AVFoundation/FFmpeg recorder is retained only as a provisional,
deferred experiment. It remains covered by its existing tests but is not the
architecture being extended for v1.

## Security and operating model

OBS stays running in the GUI (minimized is fine). Its WebSocket server must
require authentication. The first Go transport accepts only `ws://` endpoints
at literal loopback addresses and disables HTTP proxying. It asks for the
`obswebsocket.json` subprotocol, completes Hello/Identify challenge auth, and
only exposes the three read-only calls needed by `obs-doctor`.

The loopback restriction is a scenecap client policy, not a claim about the
OBS server bind address. OBS may still be LAN-reachable; use a strong password,
a host firewall, and a trusted network. Store the password in OBS, then supply
it with `SCENECAP_OBS_PASSWORD` or OBS's local plugin JSON configuration. Never
put a password in a CLI flag or shell argv.

## Current milestone: transport and compatibility preflight

`scenecap obs-doctor` defaults to `127.0.0.1:4455` and makes no OBS mutations.
It reports OBS and obs-websocket versions plus the advertised / installed
capabilities required by this backend:

- `screen_capture`
- `source_record_filter`

This is intentionally only a compatibility signal. It does not prove TCC,
hardware availability, a configured capture instance, a correct Source Record
attachment, stable filenames, or successful recording.

## Next milestones

1. Define a declarative source/session config and inspect existing scenes and
   filters without mutation. Cover screen windows and camera inputs, including
   a phone exposed to OBS as a Video Capture Device. Record the mapping from
   configured identity to vendor-mutated output filename.
2. Add narrow, guarded OBS mutations: prepare scenes/filters, prefer Preview,
   and when forced to use Program activate then restore the prior scene even on
   cancellation. No record command before this recovery behavior is tested.
3. Start and stop all prepared Source Record sources as a coordinated session;
   persist timestamps, OBS versions, source identities, requested and final
   paths, and stop outcomes in a versioned manifest.
4. Exercise multi-display, preview/program restoration, Source Record version
   compatibility, and the near-native aligned scaling workaround across real
   devices. Keep the unusual-width VideoToolbox finding as a compatibility
   constraint, not a silent automatic transform.
5. Produce editor handoff metadata and validate alignment/drift. For phone and
   other independent camera clocks, use a visible clap or pad tap with an audio
   transient to measure the real source offset. Composition, streaming, virtual
   camera, source changes mid-session, and cross-platform support remain outside
   v1.
