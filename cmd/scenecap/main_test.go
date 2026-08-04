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
	t.Setenv("SCENECAP_TEST_ARGS", argsPath)
	real := filepath.Join(dir, "real-ffmpeg")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$SCENECAP_TEST_ARGS\"\nexit 1\n"
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
}

func TestDevicesRejectsExtraArguments(t *testing.T) {
	if err := devices([]string{"extra"}); err == nil {
		t.Fatal("devices() error = nil, want unexpected argument error")
	}
}
