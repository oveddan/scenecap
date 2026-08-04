package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/oveddan/scenecap/internal/recorder"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "scenecap: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		printUsage()
		return nil
	}

	switch args[0] {
	case "doctor":
		return doctor(args[1:])
	case "devices":
		return devices()
	case "record":
		return record(args[1:])
	case "help", "-h", "--help":
		printUsage()
		return nil
	default:
		return fmt.Errorf("unknown command %q\n\n%s", args[0], usage)
	}
}

func doctor(args []string) error {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	ffmpeg := fs.String("ffmpeg", "ffmpeg", "path to the selected ffmpeg executable")
	ffprobe := fs.String("ffprobe", "ffprobe", "path to the selected ffprobe executable")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	fmt.Printf("platform: %s/%s\n", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS != "darwin" {
		return errors.New("capture is supported only on macOS")
	}

	for _, name := range []string{*ffmpeg, *ffprobe} {
		path, err := exec.LookPath(name)
		if err != nil {
			return fmt.Errorf("%s not found in PATH", name)
		}
		fmt.Printf("%s: %s\n", name, path)
	}

	out, err := exec.Command(*ffmpeg, "-hide_banner", "-encoders").CombinedOutput()
	if err != nil {
		return fmt.Errorf("inspect FFmpeg encoders: %w", err)
	}
	if !strings.Contains(string(out), "h264_videotoolbox") {
		return errors.New("FFmpeg does not provide h264_videotoolbox")
	}
	fmt.Println("encoder: h264_videotoolbox available")
	fmt.Println("TCC: unverified; run the experiment in PLAN.md before relying on permission isolation")
	return nil
}

func devices() error {
	cmd := exec.Command("ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", "")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	// FFmpeg exits non-zero after listing because no output was requested.
	err := cmd.Run()
	var exitErr *exec.ExitError
	if err != nil && !errors.As(err, &exitErr) {
		return fmt.Errorf("list AVFoundation devices: %w", err)
	}
	return nil
}

func record(args []string) error {
	fs := flag.NewFlagSet("record", flag.ContinueOnError)
	device := fs.String("device", "Capture screen 0", "AVFoundation screen device name")
	fps := fs.Int("fps", 30, "requested input frame rate")
	bitrate := fs.String("bitrate", "20M", "capture video bitrate")
	out := fs.String("out", "./sessions", "parent directory for the new session")
	duration := fs.Duration("duration", 0, "optional recording duration, such as 10s")
	cursor := fs.Bool("cursor", true, "capture the mouse cursor")
	minFree := fs.Uint64("min-free-gb", 10, "minimum free disk space required before recording")
	ffmpeg := fs.String("ffmpeg", "ffmpeg", "path to the selected ffmpeg executable")
	ffprobe := fs.String("ffprobe", "ffprobe", "path to the selected ffprobe executable")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if *fps <= 0 {
		return errors.New("--fps must be positive")
	}
	if *duration < 0 {
		return errors.New("--duration cannot be negative")
	}
	const gib = uint64(1024 * 1024 * 1024)
	if *minFree > ^uint64(0)/gib {
		return errors.New("--min-free-gb is too large")
	}
	if strings.Contains(*device, ":") {
		return errors.New("--device cannot contain ':' because AVFoundation uses it as a stream separator")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	session, err := recorder.Run(ctx, recorder.Config{
		Device:           *device,
		FPS:              *fps,
		Bitrate:          *bitrate,
		OutputRoot:       *out,
		Duration:         *duration,
		CaptureCursor:    *cursor,
		StopTimeout:      10 * time.Second,
		MinimumFreeBytes: *minFree * gib,
		FFmpegPath:       *ffmpeg,
		FFprobePath:      *ffprobe,
	})
	if session.Directory != "" {
		fmt.Printf("session: %s\n", session.Directory)
	}
	return err
}

func printUsage() {
	fmt.Print(usage)
}

const usage = `usage: scenecap <command> [options]

commands:
  doctor   check local runtime prerequisites without opening capture devices
  devices  list AVFoundation devices (may trigger macOS privacy prompts)
  record   record one screen source in the foreground
`
