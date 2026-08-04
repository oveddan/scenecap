package tooling

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
)

const (
	EvidenceVersion = 2
	outputLimit     = 32 * 1024
	commandTimeout  = 20 * time.Second
)

type CommandResult struct {
	Output    string `json:"output"`
	Truncated bool   `json:"truncated,omitempty"`
	Error     string `json:"error,omitempty"`
}

type Runner interface {
	Run(context.Context, string, []string, int) CommandResult
}

type ExecRunner struct {
	// Timeout bounds each invocation even when the caller supplies a context
	// without a deadline. Zero selects the production default.
	Timeout time.Duration
}

func (r ExecRunner) Run(ctx context.Context, name string, args []string, limit int) CommandResult {
	if limit <= 0 {
		limit = outputLimit
	}
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = commandTimeout
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var output limitedBuffer
	output.limit = limit
	cmd := exec.CommandContext(runCtx, name, args...)
	cmd.Stdout = &output
	cmd.Stderr = &output
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return err
	}
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	result := CommandResult{Output: strings.TrimSpace(output.String()), Truncated: output.truncated}
	switch {
	case err != nil && errors.Is(runCtx.Err(), context.DeadlineExceeded):
		result.Error = fmt.Sprintf("command timed out after %s", timeout)
	case err != nil && errors.Is(runCtx.Err(), context.Canceled):
		result.Error = "command canceled"
	case err != nil:
		result.Error = err.Error()
	}
	return result
}

type limitedBuffer struct {
	mu        sync.Mutex
	data      []byte
	limit     int
	truncated bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := b.limit - len(b.data)
	if remaining > 0 {
		if remaining > len(p) {
			remaining = len(p)
		}
		b.data = append(b.data, p[:remaining]...)
	}
	if remaining < len(p) {
		b.truncated = true
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.data)
}

type ExecutableIdentity struct {
	Requested     string         `json:"requested"`
	AbsolutePath  string         `json:"absolute_path"`
	CanonicalPath string         `json:"canonical_path"`
	SHA256        string         `json:"sha256"`
	Mode          string         `json:"mode"`
	OwnerUID      uint32         `json:"owner_uid"`
	OwnerGID      uint32         `json:"owner_gid"`
	Device        uint64         `json:"device"`
	Inode         uint64         `json:"inode"`
	Size          int64          `json:"size"`
	ModifiedUTC   time.Time      `json:"modified_utc"`
	Version       CommandResult  `json:"version"`
	Codesign      CodesignReport `json:"codesign"`
}

type FileIdentity struct {
	Requested     string    `json:"requested"`
	AbsolutePath  string    `json:"absolute_path"`
	CanonicalPath string    `json:"canonical_path"`
	SHA256        string    `json:"sha256"`
	Mode          string    `json:"mode"`
	OwnerUID      uint32    `json:"owner_uid"`
	OwnerGID      uint32    `json:"owner_gid"`
	Device        uint64    `json:"device"`
	Inode         uint64    `json:"inode"`
	Size          int64     `json:"size"`
	ModifiedUTC   time.Time `json:"modified_utc"`
}

type CodesignReport struct {
	Verification CommandResult `json:"verification"`
	Display      CommandResult `json:"display"`
	Requirements CommandResult `json:"requirements"`
	Entitlements CommandResult `json:"entitlements"`
}

// ResolveExecutable resolves PATH and symlinks before a command is spawned.
func ResolveExecutable(requested string) (absolute, canonical string, err error) {
	if requested == "" {
		return "", "", errors.New("empty executable path")
	}
	resolved := requested
	if !strings.ContainsRune(requested, os.PathSeparator) {
		resolved, err = exec.LookPath(requested)
		if err != nil {
			return "", "", fmt.Errorf("resolve executable %q: %w", requested, err)
		}
	}
	absolute, err = filepath.Abs(resolved)
	if err != nil {
		return "", "", fmt.Errorf("make executable path absolute: %w", err)
	}
	canonical, err = filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", "", fmt.Errorf("resolve executable symlinks: %w", err)
	}
	canonical, err = filepath.Abs(canonical)
	if err != nil {
		return "", "", fmt.Errorf("make canonical executable path absolute: %w", err)
	}
	return absolute, canonical, nil
}

func InspectExecutable(ctx context.Context, runner Runner, requested string, versionArgs []string) (ExecutableIdentity, error) {
	basic, err := InspectFileIdentity(requested)
	if err != nil {
		return ExecutableIdentity{}, err
	}
	identity := ExecutableIdentity{
		Requested:     basic.Requested,
		AbsolutePath:  basic.AbsolutePath,
		CanonicalPath: basic.CanonicalPath,
		SHA256:        basic.SHA256,
		Mode:          basic.Mode,
		OwnerUID:      basic.OwnerUID,
		OwnerGID:      basic.OwnerGID,
		Device:        basic.Device,
		Inode:         basic.Inode,
		Size:          basic.Size,
		ModifiedUTC:   basic.ModifiedUTC,
		Version:       runner.Run(ctx, basic.CanonicalPath, versionArgs, outputLimit),
		Codesign: CodesignReport{
			Verification: runner.Run(ctx, "codesign", []string{"--verify", "--verbose=4", basic.CanonicalPath}, outputLimit),
			Display:      runner.Run(ctx, "codesign", []string{"--display", "--verbose=4", basic.CanonicalPath}, outputLimit),
			Requirements: runner.Run(ctx, "codesign", []string{"--display", "--requirements", "-", basic.CanonicalPath}, outputLimit),
			Entitlements: runner.Run(ctx, "codesign", []string{"--display", "--entitlements", ":-", basic.CanonicalPath}, outputLimit),
		},
	}
	if err := VerifyFileIdentity(basic); err != nil {
		return ExecutableIdentity{}, err
	}
	return identity, nil
}

func InspectFileIdentity(requested string) (FileIdentity, error) {
	absolute, canonical, err := ResolveExecutable(requested)
	if err != nil {
		return FileIdentity{}, err
	}
	pathInfo, err := os.Stat(canonical)
	if err != nil {
		return FileIdentity{}, fmt.Errorf("stat executable %q: %w", canonical, err)
	}
	if err := validateExecutable(canonical, pathInfo); err != nil {
		return FileIdentity{}, err
	}
	fd, err := syscall.Open(canonical, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return FileIdentity{}, fmt.Errorf("open executable %q without following symlinks: %w", canonical, err)
	}
	file := os.NewFile(uintptr(fd), canonical)
	if file == nil {
		_ = syscall.Close(fd)
		return FileIdentity{}, fmt.Errorf("open executable %q: invalid file descriptor", canonical)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return FileIdentity{}, fmt.Errorf("stat opened executable %q: %w", canonical, err)
	}
	if err := validateExecutable(canonical, info); err != nil {
		return FileIdentity{}, err
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return FileIdentity{}, fmt.Errorf("hash executable %q: %w", canonical, err)
	}
	uid, gid, device, inode := fileMetadata(info)
	return FileIdentity{
		Requested:     requested,
		AbsolutePath:  absolute,
		CanonicalPath: canonical,
		SHA256:        hex.EncodeToString(hash.Sum(nil)),
		Mode:          info.Mode().String(),
		OwnerUID:      uid,
		OwnerGID:      gid,
		Device:        device,
		Inode:         inode,
		Size:          info.Size(),
		ModifiedUTC:   info.ModTime().UTC(),
	}, nil
}

func validateExecutable(path string, info os.FileInfo) error {
	if !info.Mode().IsRegular() {
		return fmt.Errorf("executable %q is not a regular file (%s)", path, info.Mode().Type())
	}
	if info.Size() == 0 {
		return fmt.Errorf("executable %q is empty", path)
	}
	if info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("executable %q has no executable permission bits (mode %s)", path, info.Mode())
	}
	return nil
}

func fileMetadata(info os.FileInfo) (uid, gid uint32, device, inode uint64) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, 0, 0
	}
	return stat.Uid, stat.Gid, uint64(stat.Dev), uint64(stat.Ino)
}

func (i ExecutableIdentity) FileIdentity() FileIdentity {
	return FileIdentity{
		Requested:     i.Requested,
		AbsolutePath:  i.AbsolutePath,
		CanonicalPath: i.CanonicalPath,
		SHA256:        i.SHA256,
		Mode:          i.Mode,
		OwnerUID:      i.OwnerUID,
		OwnerGID:      i.OwnerGID,
		Device:        i.Device,
		Inode:         i.Inode,
		Size:          i.Size,
		ModifiedUTC:   i.ModifiedUTC,
	}
}

func VerifyFileIdentity(expected FileIdentity) error {
	current, err := InspectFileIdentity(expected.CanonicalPath)
	if err != nil {
		return fmt.Errorf("revalidate executable identity: %w", err)
	}
	if expected.CanonicalPath != current.CanonicalPath ||
		expected.SHA256 != current.SHA256 ||
		expected.Mode != current.Mode ||
		expected.OwnerUID != current.OwnerUID ||
		expected.OwnerGID != current.OwnerGID ||
		expected.Device != current.Device ||
		expected.Inode != current.Inode ||
		expected.Size != current.Size ||
		!expected.ModifiedUTC.Equal(current.ModifiedUTC) {
		return fmt.Errorf("executable identity changed for %q (was device=%d inode=%d size=%d sha256=%s; now device=%d inode=%d size=%d sha256=%s)",
			expected.CanonicalPath, expected.Device, expected.Inode, expected.Size, expected.SHA256,
			current.Device, current.Inode, current.Size, current.SHA256)
	}
	return nil
}

type EvidenceOptions struct {
	OutputPath string
	Case       string
	FFmpeg     string
	FFprobe    string
	Executable string
	Now        func() time.Time
	Runner     Runner
}

type Evidence struct {
	Version       int                           `json:"version"`
	Case          string                        `json:"case,omitempty"`
	TimestampUTC  time.Time                     `json:"timestamp_utc"`
	OS            OSInfo                        `json:"os"`
	WorkingDir    string                        `json:"working_directory"`
	UID           int                           `json:"uid"`
	EUID          int                           `json:"euid"`
	PID           int                           `json:"pid"`
	PPID          int                           `json:"ppid"`
	LaunchContext LaunchContext                 `json:"launch_context"`
	Executables   map[string]ExecutableIdentity `json:"executables"`
	FFmpeg        FFmpegCapabilities            `json:"ffmpeg_capabilities"`
}

type OSInfo struct {
	ProductName    string `json:"product_name,omitempty"`
	ProductVersion string `json:"product_version,omitempty"`
	BuildVersion   string `json:"build_version,omitempty"`
	Architecture   string `json:"architecture"`
	Error          string `json:"error,omitempty"`
}

type LaunchContext struct {
	StdinKind      string `json:"stdin_kind"`
	StdoutKind     string `json:"stdout_kind"`
	StderrKind     string `json:"stderr_kind"`
	TerminalHint   bool   `json:"terminal_environment_present"`
	SSHHint        bool   `json:"ssh_environment_present"`
	CIHint         bool   `json:"ci_environment_present"`
	LaunchdJobHint bool   `json:"launchd_job_environment_present"`
}

type FFmpegCapabilities struct {
	Formats                CommandResult `json:"formats"`
	Devices                CommandResult `json:"devices"`
	Encoders               CommandResult `json:"encoders"`
	HWAccels               CommandResult `json:"hwaccels"`
	AVFoundationHelp       CommandResult `json:"avfoundation_help"`
	AVFoundationCompiled   *bool         `json:"avfoundation_compiled"`
	AVFoundationListed     *bool         `json:"avfoundation_listed"`
	H264VideoToolboxListed *bool         `json:"h264_videotoolbox_listed"`
}

func WriteEvidence(ctx context.Context, opts EvidenceOptions) (string, Evidence, error) {
	if opts.OutputPath == "" {
		return "", Evidence{}, errors.New("--out is required")
	}
	if opts.FFmpeg == "" {
		opts.FFmpeg = "ffmpeg"
	}
	if opts.FFprobe == "" {
		opts.FFprobe = "ffprobe"
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Runner == nil {
		opts.Runner = ExecRunner{}
	}
	if opts.Executable == "" {
		var err error
		opts.Executable, err = os.Executable()
		if err != nil {
			return "", Evidence{}, fmt.Errorf("find scenecap executable: %w", err)
		}
	}
	now := opts.Now().UTC()
	path, err := evidenceOutputPath(opts.OutputPath, opts.Case, now)
	if err != nil {
		return "", Evidence{}, err
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", Evidence{}, fmt.Errorf("get working directory: %w", err)
	}
	evidence := Evidence{
		Version:       EvidenceVersion,
		Case:          opts.Case,
		TimestampUTC:  now,
		OS:            inspectOS(ctx, opts.Runner),
		WorkingDir:    cwd,
		UID:           os.Getuid(),
		EUID:          os.Geteuid(),
		PID:           os.Getpid(),
		PPID:          os.Getppid(),
		LaunchContext: inspectLaunchContext(),
		Executables:   make(map[string]ExecutableIdentity, 3),
	}
	for name, spec := range map[string]struct {
		path string
		args []string
	}{
		"scenecap": {opts.Executable, []string{"version"}},
		"ffmpeg":   {opts.FFmpeg, []string{"-version"}},
		"ffprobe":  {opts.FFprobe, []string{"-version"}},
	} {
		identity, err := InspectExecutable(ctx, opts.Runner, spec.path, spec.args)
		if err != nil {
			return "", Evidence{}, fmt.Errorf("inspect %s: %w", name, err)
		}
		evidence.Executables[name] = identity
	}
	ffmpegPath := evidence.Executables["ffmpeg"].CanonicalPath
	ffmpegIdentity := evidence.Executables["ffmpeg"].FileIdentity()
	evidence.FFmpeg = inspectFFmpeg(ctx, opts.Runner, ffmpegPath)
	if err := VerifyFileIdentity(ffmpegIdentity); err != nil {
		return "", Evidence{}, err
	}
	data, err := json.MarshalIndent(evidence, "", "  ")
	if err != nil {
		return "", Evidence{}, fmt.Errorf("encode evidence: %w", err)
	}
	data = append(data, '\n')
	if err := atomicWrite(path, data, 0o644); err != nil {
		return "", Evidence{}, err
	}
	return path, evidence, nil
}

func inspectOS(ctx context.Context, runner Runner) OSInfo {
	result := OSInfo{Architecture: runtime.GOARCH}
	fields := []struct {
		flag string
		dest *string
	}{
		{"-productName", &result.ProductName},
		{"-productVersion", &result.ProductVersion},
		{"-buildVersion", &result.BuildVersion},
	}
	var errs []string
	for _, field := range fields {
		got := runner.Run(ctx, "sw_vers", []string{field.flag}, 1024)
		*field.dest = strings.TrimSpace(got.Output)
		if got.Error != "" {
			errs = append(errs, field.flag+": "+got.Error)
		}
	}
	result.Error = strings.Join(errs, "; ")
	return result
}

func inspectLaunchContext() LaunchContext {
	return LaunchContext{
		StdinKind:      descriptorKind(os.Stdin),
		StdoutKind:     descriptorKind(os.Stdout),
		StderrKind:     descriptorKind(os.Stderr),
		TerminalHint:   os.Getenv("TERM") != "",
		SSHHint:        os.Getenv("SSH_CONNECTION") != "" || os.Getenv("SSH_TTY") != "",
		CIHint:         os.Getenv("CI") != "",
		LaunchdJobHint: os.Getenv("LAUNCH_JOBKEY_LABEL") != "",
	}
}

func descriptorKind(file *os.File) string {
	info, err := file.Stat()
	if err != nil {
		return "unknown"
	}
	mode := info.Mode()
	switch {
	case mode&os.ModeCharDevice != 0:
		return "character_device"
	case mode&os.ModeNamedPipe != 0:
		return "pipe"
	case mode.IsRegular():
		return "file"
	default:
		return "other"
	}
}

func inspectFFmpeg(ctx context.Context, runner Runner, path string) FFmpegCapabilities {
	formats := runner.Run(ctx, path, []string{"-hide_banner", "-formats"}, outputLimit)
	devices := runner.Run(ctx, path, []string{"-hide_banner", "-devices"}, outputLimit)
	encoders := runner.Run(ctx, path, []string{"-hide_banner", "-encoders"}, outputLimit)
	hwaccels := runner.Run(ctx, path, []string{"-hide_banner", "-hwaccels"}, outputLimit)
	avHelp := runner.Run(ctx, path, []string{"-hide_banner", "-h", "demuxer=avfoundation"}, outputLimit)
	return FFmpegCapabilities{
		Formats:                formats,
		Devices:                devices,
		Encoders:               encoders,
		HWAccels:               hwaccels,
		AVFoundationHelp:       avHelp,
		AVFoundationCompiled:   avFoundationCompiled(avHelp),
		AVFoundationListed:     listedConclusion(devices, "avfoundation"),
		H264VideoToolboxListed: listedConclusion(encoders, "h264_videotoolbox"),
	}
}

func avFoundationCompiled(result CommandResult) *bool {
	if result.Error != "" || result.Truncated {
		return nil
	}
	lower := strings.ToLower(result.Output)
	compiled := !strings.Contains(lower, "unknown format") &&
		strings.Contains(lower, "demuxer avfoundation [")
	return &compiled
}

func listedConclusion(result CommandResult, name string) *bool {
	if result.Error != "" || result.Truncated {
		return nil
	}
	listed := componentListed(result.Output, name)
	return &listed
}

func componentListed(output, name string) bool {
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == name {
			return true
		}
	}
	return false
}

type EncoderCheck struct {
	Version     int                `json:"version"`
	Executable  ExecutableIdentity `json:"ffmpeg"`
	Listed      *bool              `json:"h264_videotoolbox_listed"`
	Operational bool               `json:"h264_videotoolbox_operational"`
	Listing     CommandResult      `json:"encoder_listing"`
	Probe       CommandResult      `json:"operational_probe"`
}

func CheckEncoder(ctx context.Context, runner Runner, requested string) (EncoderCheck, error) {
	if runner == nil {
		runner = ExecRunner{}
	}
	if requested == "" {
		requested = "ffmpeg"
	}
	identity, err := InspectExecutable(ctx, runner, requested, []string{"-version"})
	if err != nil {
		return EncoderCheck{}, err
	}
	expected := identity.FileIdentity()
	listing := runner.Run(ctx, identity.CanonicalPath, []string{"-hide_banner", "-encoders"}, outputLimit)
	if err := VerifyFileIdentity(expected); err != nil {
		return EncoderCheck{}, err
	}
	probe := runner.Run(ctx, identity.CanonicalPath, EncoderProbeArgs(), outputLimit)
	if err := VerifyFileIdentity(expected); err != nil {
		return EncoderCheck{}, err
	}
	return EncoderCheck{
		Version:     2,
		Executable:  identity,
		Listed:      listedConclusion(listing, "h264_videotoolbox"),
		Operational: probe.Error == "",
		Listing:     listing,
		Probe:       probe,
	}, nil
}

func EncoderProbeArgs() []string {
	return []string{
		"-hide_banner", "-nostdin", "-loglevel", "info",
		"-f", "lavfi", "-i", "color=size=64x64:rate=1:duration=1",
		"-frames:v", "1", "-an", "-c:v", "h264_videotoolbox",
		"-f", "null", "-",
	}
}

func evidenceOutputPath(requested, caseLabel string, now time.Time) (string, error) {
	info, err := os.Stat(requested)
	if err == nil && info.IsDir() {
		return filepath.Join(requested, evidenceFilename(caseLabel, now)), nil
	}
	if err == nil {
		return requested, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("inspect evidence output: %w", err)
	}
	if strings.HasSuffix(requested, string(os.PathSeparator)) || !strings.EqualFold(filepath.Ext(requested), ".json") {
		if err := os.MkdirAll(requested, 0o755); err != nil {
			return "", fmt.Errorf("create evidence output directory: %w", err)
		}
		return filepath.Join(requested, evidenceFilename(caseLabel, now)), nil
	}
	if err := os.MkdirAll(filepath.Dir(requested), 0o755); err != nil {
		return "", fmt.Errorf("create evidence output parent: %w", err)
	}
	return requested, nil
}

func evidenceFilename(caseLabel string, now time.Time) string {
	name := "scenecap-evidence"
	if label := safeLabel(caseLabel); label != "" {
		name += "-" + label
	}
	return name + "-" + now.UTC().Format("20060102T150405.000000000Z") + ".json"
}

func safeLabel(value string) string {
	var out strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(value) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			out.WriteRune(r)
			lastDash = false
		} else if !lastDash && out.Len() > 0 {
			out.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(out.String(), "-")
}

func atomicWrite(path string, data []byte, mode os.FileMode) (retErr error) {
	dir := filepath.Dir(path)
	file, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("create evidence temporary file: %w", err)
	}
	tmp := file.Name()
	defer func() {
		_ = file.Close()
		if retErr != nil {
			_ = os.Remove(tmp)
		}
	}()
	if err := file.Chmod(mode); err != nil {
		return fmt.Errorf("set evidence mode: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		return fmt.Errorf("write evidence: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync evidence: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close evidence: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("commit evidence: %w", err)
	}
	directory, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("open evidence directory: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync evidence directory: %w", err)
	}
	return nil
}
