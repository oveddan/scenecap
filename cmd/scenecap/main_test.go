package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestDevicesUsesExplicitResolvedFFmpegAndExactArguments(t *testing.T) {
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "args")
	executablePath := filepath.Join(dir, "executable")
	t.Setenv("SCENECAP_TEST_ARGS", argsPath)
	t.Setenv("SCENECAP_TEST_EXECUTABLE", executablePath)
	real := filepath.Join(dir, "real-ffmpeg")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$SCENECAP_TEST_ARGS\"\nprintf '%s\\n' \"$0\" > \"$SCENECAP_TEST_EXECUTABLE\"\nexit 1\n"
	if err := os.WriteFile(real, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "ffmpeg")
	if err := os.Symlink(filepath.Base(real), link); err != nil {
		t.Fatal(err)
	}
	if err := devices([]string{"--ffmpeg", link}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	want := []string{"-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("arguments = %#v, want %#v", got, want)
	}
	executed, err := os.ReadFile(executablePath)
	if err != nil {
		t.Fatal(err)
	}
	wantExecutable, err := filepath.EvalSymlinks(real)
	if err != nil {
		t.Fatal(err)
	}
	if gotExecutable := strings.TrimSpace(string(executed)); gotExecutable != wantExecutable {
		t.Fatalf("executed path = %q, want canonical %q", gotExecutable, wantExecutable)
	}
}

func TestDoctorRejectsExtraArguments(t *testing.T) {
	if err := doctor([]string{"extra"}); err == nil {
		t.Fatal("doctor() error = nil, want unexpected argument error")
	}
}

func TestDevicesRejectsExtraArguments(t *testing.T) {
	if err := devices([]string{"extra"}); err == nil {
		t.Fatal("devices() error = nil, want unexpected argument error")
	}
}
