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
./scenecap devices
./scenecap record --device "Capture screen 0" --out ./sessions
```

`devices` may trigger macOS privacy prompts. Run `doctor` first; it only checks
installed tools and encoder availability. See [PLAN.md](PLAN.md) for the TCC
gate that must be resolved before the packaging shape is considered stable.

