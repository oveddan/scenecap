// Package obsdoctor provides read-only OBS installation diagnostics.
package obsdoctor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/oveddan/scenecap/internal/obsws"
)

const DefaultAddress = "127.0.0.1:4455"

type Report struct {
	OBSVersion       string
	WebSocketVersion string
	ScreenCapture    bool
	SourceRecord     bool
}

// Check connects to OBS and makes only GetVersion, GetInputKindList, and
// GetSourceFilterKindList requests.
func Check(ctx context.Context, address, password string) (Report, error) {
	c, err := obsws.Connect(ctx, address, password)
	if err != nil {
		return Report{}, err
	}
	defer c.Close()

	version, err := c.GetVersion(ctx)
	if err != nil {
		return Report{}, fmt.Errorf("GetVersion: %w", err)
	}
	if version.OBSVersion == "" || version.OBSWebSocketVersion == "" {
		return Report{}, errors.New("GetVersion response lacks OBS or OBS WebSocket version")
	}
	if _, err := versionMajor(version.OBSVersion); err != nil {
		return Report{}, fmt.Errorf("unsupported OBS version: %w", err)
	}
	websocketMajor, err := versionMajor(version.OBSWebSocketVersion)
	if err != nil || websocketMajor != 5 {
		return Report{}, errors.New("OBS WebSocket v5 is required")
	}

	inputs, err := c.GetInputKinds(ctx)
	if err != nil {
		return Report{}, fmt.Errorf("GetInputKindList: %w", err)
	}

	filters, err := c.GetSourceFilterKinds(ctx)
	if err != nil {
		return Report{}, fmt.Errorf("GetSourceFilterKindList: %w", err)
	}

	return Interpret(version.OBSVersion, version.OBSWebSocketVersion, inputs, filters), nil
}

func versionMajor(version string) (int, error) {
	major, _, _ := strings.Cut(version, ".")
	n, err := strconv.Atoi(major)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid version %q", version)
	}
	return n, nil
}

// Interpret converts OBS's capability lists into the stable diagnostics report.
func Interpret(obsVersion, websocketVersion string, inputs, filters []string) Report {
	return Report{
		OBSVersion:       obsVersion,
		WebSocketVersion: websocketVersion,
		ScreenCapture:    contains(inputs, "screen_capture"),
		SourceRecord:     contains(filters, "source_record_filter"),
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// DefaultConfigPath returns the current macOS obs-websocket plugin config.
func DefaultConfigPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("find home directory for OBS config: %w", err)
	}
	return filepath.Join(home, "Library", "Application Support", "obs-studio", "plugin_config", "obs-websocket", "config.json"), nil
}

// PasswordForConfig returns the environment password without looking up a
// config path. Otherwise it uses configPath, or OBS's default config when no
// explicit path was supplied.
func PasswordForConfig(configPath string) (string, error) {
	if password := os.Getenv("SCENECAP_OBS_PASSWORD"); password != "" {
		return password, nil
	}
	if configPath == "" {
		var err error
		configPath, err = DefaultConfigPath()
		if err != nil {
			return "", err
		}
	}
	return Password(configPath)
}

// Password returns the non-empty environment password when set, otherwise the
// server_password entry from configPath. Error text never includes it.
func Password(configPath string) (string, error) {
	if password := os.Getenv("SCENECAP_OBS_PASSWORD"); password != "" {
		return password, nil
	}
	info, err := os.Stat(configPath)
	if err != nil {
		return "", fmt.Errorf("inspect OBS config: %w", err)
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("OBS config is not a regular file")
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		return "", fmt.Errorf("read OBS config: %w", err)
	}
	var config map[string]json.RawMessage
	if err := json.Unmarshal(data, &config); err != nil {
		return "", fmt.Errorf("parse OBS config: %w", err)
	}
	raw, found := config["server_password"]
	if !found {
		return "", errors.New("OBS WebSocket password not found; set SCENECAP_OBS_PASSWORD or configure server_password")
	}
	var password string
	if err := json.Unmarshal(raw, &password); err != nil || password == "" {
		return "", errors.New("OBS WebSocket server_password is missing or invalid")
	}
	return password, nil
}
