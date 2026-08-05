# scenecap

`scenecap` is a macOS recording experiment built around **OBS plus the
third-party Source Record filter**. The intended v1 backend is OBS: it owns
screen/camera/microphone permissions and produces an independent file for each
source, preserving composition choices for the edit.

The legacy FFmpeg recorder remains runnable as a provisional experiment; it is
not the v1 backend and further recorder work is deferred while OBS integration
is proved.

## OBS preflight

With OBS running and its WebSocket server enabled, run the read-only check:

```sh
make build
./scenecap obs-doctor
```

It defaults to `127.0.0.1:4455`. It looks for the password first in an existing
`SCENECAP_OBS_PASSWORD` environment variable, then in OBS's local
`~/Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json`.
Use `--obs-config /path/to/config.json` to override that location. Do not put
a password on the command line: command arguments can be visible to other
local processes. The check uses only `GetVersion`, `GetInputKindList`, and
`GetSourceFilterKindList`; it changes no scene, source, filter, or recording.

For this initial slice scenecap itself will connect only to literal loopback
addresses (`127.0.0.0/8` or `::1`). That does **not** make OBS's WebSocket
listener loopback-only: OBS may listen on LAN interfaces. Leave authentication
enabled, and protect OBS with a host firewall and a trusted network policy.

`obs-doctor` verifies protocol capability advertisement and installed input /
filter kinds. It does not prove that a specific capture device works, that a
scene is configured correctly, that Source Record has been attached to every
source, or that TCC permissions have been granted. Those remain hands-on OBS
configuration and recording checks.

## Empirical constraints shaping v1

- Multi-display screen capture works through OBS.
- OBS renders inactive scenes black. Use Studio Preview when available; without
  it, Program activation must be guarded and the previous Program scene
  restored.
- Native widths of 2722 and 1822 pixels caused Apple VideoToolbox stride
  corruption. Near-native GPU scaling to 2688 and 1792 pixels respectively
  fixed it and is the working workaround.
- Source Record can mutate filenames through its vendor integration; session
  tracking must account for the resulting name rather than assume its requested
  filename is final.
- Source Record is a third-party dependency, not an OBS core feature.
- macOS TCC belongs to OBS in this design, so no permission-isolation claim is
  made for scenecap itself.

OBS should remain GUI-managed (it can be minimized), and this prototype is a
backend proof rather than a guarantee of every display, codec, or source
configuration. The next slice will model Source Record configuration and
guarded scene selection; it will not start recording until that design is
explicitly reviewed.

The old commands are kept for the existing FFmpeg experiment:

```sh
./scenecap doctor
./scenecap devices
./scenecap record --device "Capture screen 0" --out ./sessions
```

See [PLAN.md](PLAN.md) for the v1 architecture and phased plan.
