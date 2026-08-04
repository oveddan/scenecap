package recorder

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestFFmpegArgsUsesInputFramerateAndVideoToolbox(t *testing.T) {
	cfg := Config{
		Device:        "Capture screen 0",
		FPS:           30,
		Bitrate:       "20M",
		Duration:      1500 * time.Millisecond,
		CaptureCursor: true,
	}
	want := []string{
		"-hide_banner", "-nostdin", "-y",
		"-f", "avfoundation", "-capture_cursor", "1",
		"-framerate", "30", "-i", "Capture screen 0:none",
		"-map", "0:v:0", "-c:v", "h264_videotoolbox",
		"-b:v", "20M",
		"-t", "1.500", "/tmp/out.mov",
	}
	if got := ffmpegArgs(cfg, "/tmp/out.mov"); !reflect.DeepEqual(got, want) {
		t.Fatalf("ffmpegArgs() = %#v, want %#v", got, want)
	}
}

func TestRunWritesCompletedManifestAfterProbe(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	ffmpeg := writeExecutable(t, bin, "ffmpeg", "#!/bin/sh\nout=\"\"\nfor arg in \"$@\"; do out=\"$arg\"; done\nprintf media > \"$out\"\n")
	ffprobe := writeExecutable(t, bin, "ffprobe", "#!/bin/sh\nout=\"\"\nfor arg in \"$@\"; do out=\"$arg\"; done\ntest -s \"$out\" || exit 12\nprintf '%s' '{\"streams\":[{\"codec_type\":\"video\",\"width\":1920,\"height\":1080}],\"format\":{\"duration\":\"1.0\"},\"frames\":[{\"media_type\":\"video\"}]}'\n")
	now := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)

	session, err := Run(context.Background(), Config{
		Device: "Capture screen 0", FPS: 30, Bitrate: "20M",
		OutputRoot: dir, StopTimeout: time.Second,
		FFmpegPath: ffmpeg, FFprobePath: ffprobe,
		Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if session.Status != "completed" {
		t.Fatalf("status = %q, want completed", session.Status)
	}
	data, err := os.ReadFile(filepath.Join(session.Directory, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var stored Session
	if err := json.Unmarshal(data, &stored); err != nil {
		t.Fatal(err)
	}
	if stored.Validation == nil || stored.Validation.ReadableFrames != 1 {
		t.Fatalf("validation = %#v, want a readable frame", stored.Validation)
	}
}

func TestRunMarksInvalidMediaFailed(t *testing.T) {
	dir := t.TempDir()
	ffmpeg := writeExecutable(t, dir, "ffmpeg", "#!/bin/sh\nout=\"\"\nfor arg in \"$@\"; do out=\"$arg\"; done\nprintf media > \"$out\"\n")
	ffprobe := writeExecutable(t, dir, "ffprobe", "#!/bin/sh\nprintf '%s' '{\"streams\":[],\"format\":{\"duration\":\"1.0\"},\"frames\":[]}'\n")

	session, err := Run(context.Background(), Config{
		Device: "screen", FPS: 30, Bitrate: "20M", OutputRoot: dir,
		FFmpegPath: ffmpeg, FFprobePath: ffprobe,
	})
	if err == nil {
		t.Fatal("Run() error = nil, want validation error")
	}
	if session.Status != "failed" {
		t.Fatalf("status = %q, want failed", session.Status)
	}
}

func TestRunGracefullyInterruptsAfterManifestExists(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	outputRoot := filepath.Join(dir, "sessions")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	ffmpeg := writeExecutable(t, bin, "ffmpeg", `#!/bin/sh
out=""
for arg in "$@"; do out="$arg"; done
session_dir=$(dirname "$out")
test -f "$session_dir/manifest.json" || exit 11
touch "$session_dir/ready"
trap 'printf media > "$out"; exit 0' INT TERM
while :; do sleep 0.05; done
`)
	ffprobe := writeExecutable(t, bin, "ffprobe", "#!/bin/sh\nout=\"\"\nfor arg in \"$@\"; do out=\"$arg\"; done\ntest -s \"$out\" || exit 12\nprintf '%s' '{\"streams\":[{\"codec_type\":\"video\",\"width\":100,\"height\":100}],\"format\":{\"duration\":\"1.0\"},\"frames\":[{\"media_type\":\"video\"}]}'\n")

	ctx, cancel := context.WithCancel(context.Background())
	type result struct {
		session Session
		err     error
	}
	done := make(chan result, 1)
	go func() {
		session, err := Run(ctx, Config{
			Device: "screen", FPS: 30, Bitrate: "20M", OutputRoot: outputRoot,
			FFmpegPath: ffmpeg, FFprobePath: ffprobe, StopTimeout: 2 * time.Second,
		})
		done <- result{session: session, err: err}
	}()

	deadline := time.Now().Add(3 * time.Second)
	for {
		ready, _ := filepath.Glob(filepath.Join(outputRoot, "*", "ready"))
		if len(ready) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fake ffmpeg did not observe the pre-spawn manifest")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()

	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("Run() after cancellation error = %v", got.err)
		}
		if got.session.Status != "completed" {
			t.Fatalf("status = %q, want completed", got.session.Status)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Run() did not finish after cancellation")
	}
}

func TestRunPreflightsExecutablesBeforeCreatingSession(t *testing.T) {
	dir := t.TempDir()
	_, err := Run(context.Background(), Config{
		Device: "screen", FPS: 30, Bitrate: "20M", OutputRoot: dir,
		FFmpegPath: filepath.Join(dir, "missing-ffmpeg"), FFprobePath: "ffprobe",
	})
	if err == nil {
		t.Fatal("Run() error = nil, want missing executable error")
	}
	entries, readErr := os.ReadDir(dir)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if len(entries) != 0 {
		t.Fatalf("output root contains %d entries after failed preflight", len(entries))
	}
}

func writeExecutable(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}
