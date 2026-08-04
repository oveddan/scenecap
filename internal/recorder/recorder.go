package recorder

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const manifestVersion = 1

type Config struct {
	Device           string
	FPS              int
	Bitrate          string
	OutputRoot       string
	Duration         time.Duration
	CaptureCursor    bool
	StopTimeout      time.Duration
	MinimumFreeBytes uint64
	FFmpegPath       string
	FFprobePath      string
	Now              func() time.Time
}

type Session struct {
	Version         int         `json:"version"`
	ID              string      `json:"id"`
	Directory       string      `json:"directory"`
	Status          string      `json:"status"`
	StartedAt       time.Time   `json:"started_at"`
	EndedAt         *time.Time  `json:"ended_at,omitempty"`
	FFmpeg          CommandInfo `json:"ffmpeg"`
	Output          string      `json:"output"`
	ExitError       string      `json:"exit_error,omitempty"`
	FFmpegExitError string      `json:"ffmpeg_exit_error,omitempty"`
	FFmpegStderr    string      `json:"ffmpeg_stderr,omitempty"`
	Validation      *Probe      `json:"validation,omitempty"`
}

type CommandInfo struct {
	Executable string   `json:"executable"`
	Arguments  []string `json:"arguments"`
}

type Probe struct {
	DurationSeconds float64 `json:"duration_seconds"`
	VideoStreams    int     `json:"video_streams"`
	ReadableFrames  int64   `json:"readable_frames,omitempty"`
	Width           int     `json:"width,omitempty"`
	Height          int     `json:"height,omitempty"`
}

func Run(ctx context.Context, cfg Config) (Session, error) {
	if err := cfg.defaults(); err != nil {
		return Session{}, err
	}
	if err := preflight(cfg); err != nil {
		return Session{}, err
	}
	now := cfg.Now().UTC()
	id := now.Format("20060102T150405.000000000Z")
	if err := os.MkdirAll(cfg.OutputRoot, 0o755); err != nil {
		return Session{}, fmt.Errorf("create output root: %w", err)
	}
	dir := filepath.Join(cfg.OutputRoot, id)
	if err := os.Mkdir(dir, 0o755); err != nil {
		return Session{}, fmt.Errorf("create session directory: %w", err)
	}

	output := filepath.Join(dir, "screen.mov")
	args := ffmpegArgs(cfg, output)
	session := Session{
		Version:   manifestVersion,
		ID:        id,
		Directory: dir,
		Status:    "recording",
		StartedAt: now,
		FFmpeg: CommandInfo{
			Executable: cfg.FFmpegPath,
			Arguments:  append([]string(nil), args...),
		},
		Output: output,
	}
	manifest := filepath.Join(dir, "manifest.json")
	if err := writeManifest(manifest, session); err != nil {
		return session, err
	}

	cmd := exec.CommandContext(ctx, cfg.FFmpegPath, args...)
	cmd.Stdout = os.Stdout
	stderr := newTailBuffer(64 * 1024)
	cmd.Stderr = io.MultiWriter(os.Stderr, stderr)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return cmd.Process.Signal(os.Interrupt)
	}
	cmd.WaitDelay = cfg.StopTimeout
	runErr := cmd.Run()

	ended := cfg.Now().UTC()
	session.EndedAt = &ended
	if runErr != nil {
		session.FFmpegExitError = runErr.Error()
		session.FFmpegStderr = stderr.String()
	}
	if runErr != nil && ctx.Err() == nil {
		session.Status = "failed"
		session.ExitError = runErr.Error()
	} else {
		session.Status = "validating"
	}
	if err := writeManifest(manifest, session); err != nil {
		return session, err
	}

	probe, probeErr := inspect(cfg.FFprobePath, output)
	if probeErr != nil {
		session.Status = "failed"
		if session.ExitError == "" {
			session.ExitError = probeErr.Error()
		}
	} else {
		session.Validation = &probe
		if session.Status != "failed" {
			session.Status = "completed"
		}
	}
	if err := writeManifest(manifest, session); err != nil {
		return session, err
	}
	if session.Status == "failed" {
		return session, errors.New(session.ExitError)
	}
	return session, nil
}

func (cfg *Config) defaults() error {
	if cfg.Device == "" {
		return errors.New("device is required")
	}
	if cfg.FPS <= 0 {
		return errors.New("fps must be positive")
	}
	if cfg.Bitrate == "" {
		return errors.New("bitrate is required")
	}
	if cfg.OutputRoot == "" {
		return errors.New("output root is required")
	}
	if cfg.StopTimeout <= 0 {
		cfg.StopTimeout = 10 * time.Second
	}
	if cfg.FFmpegPath == "" {
		cfg.FFmpegPath = "ffmpeg"
	}
	if cfg.FFprobePath == "" {
		cfg.FFprobePath = "ffprobe"
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return nil
}

func preflight(cfg Config) error {
	for _, executable := range []string{cfg.FFmpegPath, cfg.FFprobePath} {
		if _, err := exec.LookPath(executable); err != nil {
			return fmt.Errorf("required executable %q: %w", executable, err)
		}
	}
	if err := os.MkdirAll(cfg.OutputRoot, 0o755); err != nil {
		return fmt.Errorf("create output root: %w", err)
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(cfg.OutputRoot, &stat); err != nil {
		return fmt.Errorf("check free disk space: %w", err)
	}
	free := uint64(stat.Bavail) * uint64(stat.Bsize)
	if free < cfg.MinimumFreeBytes {
		return fmt.Errorf("insufficient disk space: %d bytes free, require at least %d", free, cfg.MinimumFreeBytes)
	}
	return nil
}

func ffmpegArgs(cfg Config, output string) []string {
	cursor := "0"
	if cfg.CaptureCursor {
		cursor = "1"
	}
	args := []string{
		"-hide_banner", "-nostdin", "-y",
		"-f", "avfoundation",
		"-capture_cursor", cursor,
		"-framerate", strconv.Itoa(cfg.FPS),
		"-i", cfg.Device + ":none",
		"-map", "0:v:0",
		"-c:v", "h264_videotoolbox",
		"-b:v", cfg.Bitrate,
	}
	if cfg.Duration > 0 {
		args = append(args, "-t", formatDuration(cfg.Duration))
	}
	return append(args, output)
}

func formatDuration(d time.Duration) string {
	return strconv.FormatFloat(d.Seconds(), 'f', 3, 64)
}

func writeManifest(path string, session Session) error {
	data, err := json.MarshalIndent(session, "", "  ")
	if err != nil {
		return fmt.Errorf("encode manifest: %w", err)
	}
	data = append(data, '\n')
	tmp := path + ".tmp"
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("write manifest: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return fmt.Errorf("write manifest: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return fmt.Errorf("sync manifest: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close manifest: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("commit manifest: %w", err)
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return fmt.Errorf("open manifest directory: %w", err)
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return fmt.Errorf("sync manifest directory: %w", err)
	}
	return nil
}

type probeDocument struct {
	Streams []struct {
		CodecType string `json:"codec_type"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
	Frames []struct {
		MediaType string `json:"media_type"`
	} `json:"frames"`
}

func inspect(ffprobePath, output string) (Probe, error) {
	cmd := exec.Command(ffprobePath,
		"-v", "error", "-read_intervals", "%+#1", "-show_frames",
		"-show_entries", "frame=media_type:stream=codec_type,width,height:format=duration",
		"-of", "json", output,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	data, err := cmd.Output()
	if err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail != "" {
			return Probe{}, fmt.Errorf("ffprobe output: %w: %s", err, detail)
		}
		return Probe{}, fmt.Errorf("ffprobe output: %w", err)
	}
	var doc probeDocument
	if err := json.Unmarshal(data, &doc); err != nil {
		return Probe{}, fmt.Errorf("parse ffprobe output: %w", err)
	}
	duration, err := strconv.ParseFloat(doc.Format.Duration, 64)
	if err != nil || duration <= 0 {
		return Probe{}, fmt.Errorf("recording has invalid duration %q", doc.Format.Duration)
	}
	result := Probe{DurationSeconds: duration}
	for _, stream := range doc.Streams {
		if stream.CodecType != "video" {
			continue
		}
		result.VideoStreams++
		if result.Width == 0 {
			result.Width = stream.Width
			result.Height = stream.Height
		}
	}
	if result.VideoStreams == 0 {
		return Probe{}, errors.New("recording contains no video stream")
	}
	for _, frame := range doc.Frames {
		if frame.MediaType == "video" {
			result.ReadableFrames++
		}
	}
	if result.ReadableFrames == 0 {
		return Probe{}, errors.New("recording contains no readable video frames")
	}
	return result, nil
}

type tailBuffer struct {
	limit int
	mu    sync.Mutex
	data  []byte
}

func newTailBuffer(limit int) *tailBuffer { return &tailBuffer{limit: limit} }

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, p...)
	if len(b.data) > b.limit {
		b.data = append([]byte(nil), b.data[len(b.data)-b.limit:]...)
	}
	return len(p), nil
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.data)
}
