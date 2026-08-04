package tooling

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestResolveExecutablePreservesAbsoluteAndResolvesSymlink(t *testing.T) {
	dir := t.TempDir()
	target := writeTool(t, dir, "real-tool")
	link := filepath.Join(dir, "linked-tool")
	if err := os.Symlink(filepath.Base(target), link); err != nil {
		t.Fatal(err)
	}
	absolute, canonical, err := ResolveExecutable(link)
	if err != nil {
		t.Fatal(err)
	}
	if absolute != link {
		t.Fatalf("absolute = %q, want %q", absolute, link)
	}
	wantCanonical, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatal(err)
	}
	if canonical != wantCanonical {
		t.Fatalf("canonical = %q, want %q", canonical, wantCanonical)
	}
}

func TestWriteEvidenceWritesValidJSONWithoutTempAndRepresentsCodesignFailures(t *testing.T) {
	dir := t.TempDir()
	tool := writeTool(t, dir, "tool")
	runner := &fakeRunner{}
	now := time.Date(2026, 8, 4, 1, 2, 3, 4, time.UTC)
	path, evidence, err := WriteEvidence(context.Background(), EvidenceOptions{
		OutputPath: dir,
		Case:       "Terminal baseline",
		FFmpeg:     tool,
		FFprobe:    tool,
		Executable: tool,
		Now:        func() time.Time { return now },
		Runner:     runner,
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := "scenecap-evidence-terminal-baseline-20260804T010203.000000004Z.json"; filepath.Base(path) != want {
		t.Fatalf("filename = %q, want %q", filepath.Base(path), want)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var stored Evidence
	if err := json.Unmarshal(data, &stored); err != nil {
		t.Fatalf("evidence is not JSON: %v", err)
	}
	if evidence.Executables["ffmpeg"].Codesign.Verification.Error == "" || stored.Executables["scenecap"].Codesign.Display.Error == "" {
		t.Fatal("codesign failures were not represented in evidence")
	}
	if !isTrue(evidence.FFmpeg.AVFoundationCompiled) || !isTrue(stored.FFmpeg.AVFoundationCompiled) {
		t.Fatal("AVFoundation positive help marker was not parsed as compiled")
	}
	if !isTrue(evidence.FFmpeg.AVFoundationListed) || !isTrue(stored.FFmpeg.AVFoundationListed) {
		t.Fatal("AVFoundation was not parsed from the FFmpeg devices listing")
	}
	ffmpegPath := evidence.Executables["ffmpeg"].CanonicalPath
	wantDevicesCall := []string{ffmpegPath, "-hide_banner", "-devices"}
	if !containsCall(runner.Calls(), wantDevicesCall) {
		t.Fatalf("runner calls do not contain FFmpeg devices query %#v: %#v", wantDevicesCall, runner.Calls())
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".tmp-") {
			t.Fatalf("temporary evidence file remains: %s", entry.Name())
		}
	}
}

func TestExecRunnerCapsCombinedOutput(t *testing.T) {
	result := (ExecRunner{}).Run(context.Background(), "/bin/sh", []string{"-c", "while :; do printf 1234567890; i=$((i+1)); test $i -ge 1000 && break; done"}, 127)
	if result.Error != "" {
		t.Fatalf("Run() error = %q", result.Error)
	}
	if len(result.Output) > 127 {
		t.Fatalf("output length = %d, want <= 127", len(result.Output))
	}
	if !result.Truncated {
		t.Fatal("truncated = false, want true")
	}
	if result.Status != CommandCompleted {
		t.Fatalf("status = %q, want completed", result.Status)
	}
}

func TestExecRunnerTimesOutHangingProcessGroup(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "hang")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf 'started\\n'\nwhile :; do sleep 10; done\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	result := (ExecRunner{Timeout: 500 * time.Millisecond}).Run(context.Background(), script, nil, 1024)
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("hanging command returned after %s, want under 2s", elapsed)
	}
	if !strings.Contains(result.Error, "timed out") {
		t.Fatalf("error = %q, want timeout diagnostic", result.Error)
	}
	if result.Output != "started" {
		t.Fatalf("output = %q, want bounded pre-timeout output", result.Output)
	}
	if result.Status != CommandTimedOut {
		t.Fatalf("status = %q, want timed_out", result.Status)
	}
}

func TestInspectFileIdentityRejectsUnsafeTargets(t *testing.T) {
	dir := t.TempDir()
	tests := []struct {
		name    string
		prepare func(string) error
		want    string
	}{
		{
			name: "non executable",
			prepare: func(path string) error {
				return os.WriteFile(path, []byte("not executable"), 0o644)
			},
			want: "no executable permission bits",
		},
		{
			name: "empty",
			prepare: func(path string) error {
				return os.WriteFile(path, nil, 0o755)
			},
			want: "is empty",
		},
		{
			name: "fifo",
			prepare: func(path string) error {
				return syscall.Mkfifo(path, 0o755)
			},
			want: "not a regular file",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, strings.ReplaceAll(tc.name, " ", "-"))
			if err := tc.prepare(path); err != nil {
				t.Fatal(err)
			}
			started := time.Now()
			_, err := InspectFileIdentity(path)
			if elapsed := time.Since(started); elapsed > time.Second {
				t.Fatalf("inspection blocked for %s", elapsed)
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want substring %q", err, tc.want)
			}
		})
	}
}

func TestInspectFileIdentityUsesOpenedDescriptorMetadata(t *testing.T) {
	dir := t.TempDir()
	path := writeTool(t, dir, "metadata-tool")
	identity, err := InspectFileIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if identity.Device == 0 || identity.Inode == 0 {
		t.Fatalf("device/inode = %d/%d, want descriptor fingerprint", identity.Device, identity.Inode)
	}
	if identity.Size != info.Size() || identity.ModifiedUTC.IsZero() || identity.SHA256 == "" {
		t.Fatalf("identity metadata = %#v, want size, mtime, and hash", identity)
	}
}

func TestInspectFileIdentityRejectsExecuteOnlyTarget(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can read execute-only files, so this permission check is not meaningful")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "execute-only")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o111); err != nil {
		t.Fatal(err)
	}
	_, err := InspectFileIdentity(path)
	if err == nil {
		t.Fatal("InspectFileIdentity() error = nil, want unreadable executable error")
	}
	if message := err.Error(); !strings.Contains(message, "open executable") || !strings.Contains(strings.ToLower(message), "permission denied") {
		t.Fatalf("error = %q, want actionable open/permission diagnostic", message)
	}
}

func TestEncoderCheckSurfacesIdentityChangedDuringProbe(t *testing.T) {
	dir := t.TempDir()
	tool := writeTool(t, dir, "ffmpeg-changing")
	runner := &mutatingRunner{base: &fakeRunner{}, path: tool, match: "-f lavfi"}
	_, err := CheckEncoder(context.Background(), runner, tool)
	if err == nil || !strings.Contains(err.Error(), "identity changed") {
		t.Fatalf("error = %v, want identity-changed diagnostic", err)
	}
}

func TestEvidenceSurfacesIdentityChangedDuringCapabilities(t *testing.T) {
	dir := t.TempDir()
	tool := writeTool(t, dir, "evidence-changing")
	runner := &mutatingRunner{base: &fakeRunner{}, path: tool, match: "-formats"}
	path := filepath.Join(dir, "evidence.json")
	_, _, err := WriteEvidence(context.Background(), EvidenceOptions{
		OutputPath: path,
		FFmpeg:     tool,
		FFprobe:    tool,
		Executable: tool,
		Runner:     runner,
	})
	if err == nil || !strings.Contains(err.Error(), "identity changed") {
		t.Fatalf("error = %v, want identity-changed diagnostic", err)
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Fatalf("evidence file exists after stale identity: %v", statErr)
	}
}

func TestWriteEvidenceCancellationWritesNoArtifact(t *testing.T) {
	dir := t.TempDir()
	tool := writeTool(t, dir, "tool")
	tests := []struct {
		name         string
		setup        func(context.CancelFunc, *fakeRunner) Runner
		cancelBefore bool
	}{
		{
			name:         "after executable collection boundary",
			setup:        func(_ context.CancelFunc, runner *fakeRunner) Runner { return runner },
			cancelBefore: true,
		},
		{
			name: "after FFmpeg inspection boundary",
			setup: func(cancel context.CancelFunc, runner *fakeRunner) Runner {
				return runnerFunc(func(ctx context.Context, name string, args []string, limit int) CommandResult {
					result := runner.Run(ctx, name, args, limit)
					if strings.Contains(strings.Join(args, " "), "-formats") {
						cancel()
					}
					return result
				})
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			runner := tc.setup(cancel, &fakeRunner{})
			if tc.cancelBefore {
				cancel()
			}
			path := filepath.Join(dir, strings.ReplaceAll(tc.name, " ", "-")+".json")
			_, _, err := WriteEvidence(ctx, EvidenceOptions{
				OutputPath: path,
				FFmpeg:     tool, FFprobe: tool, Executable: tool, Runner: runner,
			})
			if err == nil || !strings.Contains(err.Error(), "context canceled") {
				t.Fatalf("error = %v, want context canceled", err)
			}
			if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
				t.Fatalf("evidence artifact exists after cancellation: %v", statErr)
			}
		})
	}
}

func TestEncoderCheckSeparatesListedFromOperationalAndNeverUsesAVFoundation(t *testing.T) {
	dir := t.TempDir()
	tool := writeTool(t, dir, "ffmpeg")
	runner := &fakeRunner{probeError: "hardware encoder failed"}
	result, err := CheckEncoder(context.Background(), runner, tool)
	if err != nil {
		t.Fatal(err)
	}
	if !isTrue(result.Listed) {
		t.Fatal("Listed = false, want true")
	}
	if !isFalse(result.Operational) {
		t.Fatalf("Operational = %#v, want false", result.Operational)
	}
	for _, call := range runner.Calls() {
		if strings.Contains(strings.ToLower(strings.Join(call, " ")), "avfoundation") {
			t.Fatalf("encoder check used AVFoundation: %#v", call)
		}
	}
	if !reflect.DeepEqual(runner.probeArgs, EncoderProbeArgs()) {
		t.Fatalf("probe args = %#v, want %#v", runner.probeArgs, EncoderProbeArgs())
	}
}

func TestEncoderCheckOperationalIsUnknownWhenProbeIncomplete(t *testing.T) {
	dir := t.TempDir()
	tool := writeTool(t, dir, "ffmpeg")
	for _, status := range []CommandStatus{CommandCanceled, CommandTimedOut} {
		t.Run(string(status), func(t *testing.T) {
			runner := &probeStatusRunner{base: &fakeRunner{}, status: status}
			result, err := CheckEncoder(context.Background(), runner, tool)
			if err != nil {
				t.Fatal(err)
			}
			if result.Operational != nil {
				t.Fatalf("Operational = %#v, want unknown for %s probe", result.Operational, status)
			}
			if result.Probe.Status != status {
				t.Fatalf("probe status = %q, want %q", result.Probe.Status, status)
			}
		})
	}
}

func TestAVFoundationCompiledRejectsUnknownFormatOutput(t *testing.T) {
	runner := runnerFunc(func(_ context.Context, _ string, args []string, _ int) CommandResult {
		if strings.Contains(strings.Join(args, " "), "demuxer=avfoundation") {
			return CommandResult{Output: "Unknown format 'avfoundation'."}
		}
		return CommandResult{}
	})
	capabilities := inspectFFmpeg(context.Background(), runner, "/fake/ffmpeg")
	if capabilities.AVFoundationCompiled == nil || *capabilities.AVFoundationCompiled {
		t.Fatalf("avfoundation_compiled = %#v, want false", capabilities.AVFoundationCompiled)
	}
}

func TestDerivedCapabilityConclusionsAreUnknownForIncompleteOutput(t *testing.T) {
	runner := runnerFunc(func(_ context.Context, _ string, args []string, _ int) CommandResult {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "-devices"):
			return CommandResult{Output: " D  avfoundation", Truncated: true}
		case strings.Contains(joined, "-encoders"):
			return CommandResult{Output: " V..... h264_videotoolbox", Error: "exit status 1"}
		case strings.Contains(joined, "demuxer=avfoundation"):
			return CommandResult{Output: "Demuxer avfoundation [AVFoundation input device]:", Truncated: true}
		default:
			return CommandResult{}
		}
	})
	capabilities := inspectFFmpeg(context.Background(), runner, "/fake/ffmpeg")
	if capabilities.AVFoundationCompiled != nil || capabilities.AVFoundationListed != nil || capabilities.H264VideoToolboxListed != nil {
		t.Fatalf("derived conclusions = compiled:%#v listed:%#v encoder:%#v, want all unknown",
			capabilities.AVFoundationCompiled, capabilities.AVFoundationListed, capabilities.H264VideoToolboxListed)
	}
}

type fakeRunner struct {
	mu         sync.Mutex
	calls      [][]string
	probeArgs  []string
	probeError string
}

type mutatingRunner struct {
	mu      sync.Mutex
	base    *fakeRunner
	path    string
	match   string
	changed bool
}

type probeStatusRunner struct {
	base   *fakeRunner
	status CommandStatus
}

func (r *probeStatusRunner) Run(ctx context.Context, name string, args []string, limit int) CommandResult {
	if strings.Contains(strings.Join(args, " "), "-f lavfi") {
		return CommandResult{Status: r.status, Error: "probe did not complete"}
	}
	return r.base.Run(ctx, name, args, limit)
}

func (r *mutatingRunner) Run(ctx context.Context, name string, args []string, limit int) CommandResult {
	result := r.base.Run(ctx, name, args, limit)
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.changed && strings.Contains(strings.Join(args, " "), r.match) {
		r.changed = true
		_ = os.WriteFile(r.path, []byte("#!/bin/sh\n# executable changed during inspection\nexit 0\n"), 0o755)
	}
	return result
}

type runnerFunc func(context.Context, string, []string, int) CommandResult

func (f runnerFunc) Run(ctx context.Context, name string, args []string, limit int) CommandResult {
	return f(ctx, name, args, limit)
}

func (r *fakeRunner) Run(_ context.Context, name string, args []string, _ int) CommandResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	call := append([]string{name}, args...)
	r.calls = append(r.calls, call)
	joined := strings.Join(args, " ")
	switch {
	case name == "codesign":
		return CommandResult{Output: "unsigned", Error: "exit status 1"}
	case name == "sw_vers":
		return CommandResult{Output: "test-value"}
	case strings.Contains(joined, "-encoders"):
		return CommandResult{Output: " V..... h264_videotoolbox VideoToolbox H.264 Encoder"}
	case strings.Contains(joined, "-formats"):
		return CommandResult{Output: " DE matroska Matroska"}
	case strings.Contains(joined, "-devices"):
		return CommandResult{Output: " D  avfoundation AVFoundation input device"}
	case strings.Contains(joined, "-hwaccels"):
		return CommandResult{Output: "Hardware acceleration methods:\nvideotoolbox"}
	case strings.Contains(joined, "demuxer=avfoundation"):
		return CommandResult{Output: "Demuxer avfoundation [AVFoundation input device]:"}
	case strings.Contains(joined, "-f lavfi"):
		r.probeArgs = append([]string(nil), args...)
		return CommandResult{Output: "probe diagnostics", Error: r.probeError}
	default:
		return CommandResult{Output: "version output"}
	}
}

func (r *fakeRunner) Calls() [][]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([][]string, len(r.calls))
	for i := range r.calls {
		result[i] = append([]string(nil), r.calls[i]...)
	}
	return result
}

func containsCall(calls [][]string, want []string) bool {
	for _, call := range calls {
		if reflect.DeepEqual(call, want) {
			return true
		}
	}
	return false
}

func isTrue(value *bool) bool {
	return value != nil && *value
}

func isFalse(value *bool) bool {
	return value != nil && !*value
}

func writeTool(t *testing.T, dir, name string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}
