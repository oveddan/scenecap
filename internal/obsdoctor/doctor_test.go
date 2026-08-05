package obsdoctor

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestPasswordFromConfigAndEnvironment(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{"server_password":"from-file","server_port":4455}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SCENECAP_OBS_PASSWORD", "")
	password, err := PasswordForConfig(path)
	if err != nil || password != "from-file" {
		t.Fatalf("PasswordForConfig() = %q, %v", password, err)
	}
	t.Setenv("SCENECAP_OBS_PASSWORD", "from-env")
	password, err = PasswordForConfig("")
	if err != nil || password != "from-env" {
		t.Fatalf("PasswordForConfig() env = %q, %v", password, err)
	}
}

func TestPasswordRejectsInvalidConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"server_password":false}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SCENECAP_OBS_PASSWORD", "")
	if _, err := Password(path); err == nil {
		t.Fatal("Password() error = nil, want invalid password error")
	}
}

func TestInterpret(t *testing.T) {
	report := Interpret("31.0", "5.5", []string{"screen_capture"}, []string{"source_record_filter"})
	if !report.ScreenCapture || !report.SourceRecord {
		t.Fatalf("Interpret() = %#v, want all capabilities", report)
	}
	report = Interpret("31.0", "5.5", nil, nil)
	if report.ScreenCapture || report.SourceRecord {
		t.Fatalf("Interpret() = %#v, want missing capabilities", report)
	}
}

func TestVersionMajor(t *testing.T) {
	if got, err := versionMajor("31.0.1"); err != nil || got != 31 {
		t.Fatalf("versionMajor() = %d, %v", got, err)
	}
	if _, err := versionMajor("five"); err == nil {
		t.Fatal("versionMajor() accepted an invalid version")
	}
}

func TestCheckUsesOnlyExpectedReadRequests(t *testing.T) {
	requests := make(chan []string, 1)
	errs := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				errs <- fmt.Errorf("fake OBS handler: %v", recovered)
			}
		}()
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"obswebsocket.json"}})
		if err != nil {
			panic(err)
		}
		defer conn.CloseNow()
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		fakeWrite(ctx, conn, 0, map[string]any{"rpcVersion": 1, "authentication": map[string]string{"salt": "s", "challenge": "c"}})
		_ = fakeRead(ctx, conn)
		fakeWrite(ctx, conn, 2, map[string]any{"negotiatedRpcVersion": 1})
		got := make([]string, 0, 3)
		for range 3 {
			request := fakeRead(ctx, conn)
			var d struct {
				RequestID   string `json:"requestId"`
				RequestType string `json:"requestType"`
			}
			if err := json.Unmarshal(request.D, &d); err != nil {
				panic(err)
			}
			got = append(got, d.RequestType)
			data := any(map[string]any{"obsVersion": "31.0", "obsWebSocketVersion": "5.5"})
			if d.RequestType == "GetInputKindList" {
				data = map[string]any{"inputKinds": []string{"screen_capture"}}
			}
			if d.RequestType == "GetSourceFilterKindList" {
				data = map[string]any{"sourceFilterKinds": []string{"source_record_filter"}}
			}
			fakeWrite(ctx, conn, 7, map[string]any{"requestType": d.RequestType, "requestId": d.RequestID, "requestStatus": map[string]any{"result": true, "code": 100}, "responseData": data})
		}
		requests <- got
	}))
	t.Cleanup(server.Close)

	report, err := Check(context.Background(), strings.TrimPrefix(server.URL, "http://"), "password")
	if err != nil {
		t.Fatal(err)
	}
	if !report.ScreenCapture || !report.SourceRecord {
		t.Fatalf("Check() = %#v", report)
	}
	select {
	case err := <-errs:
		t.Fatal(err)
	case got := <-requests:
		want := []string{"GetVersion", "GetInputKindList", "GetSourceFilterKindList"}
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("requests = %v, want %v", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("fake OBS did not receive diagnostics requests")
	}
}

type fakeEnvelope struct {
	Op int             `json:"op"`
	D  json.RawMessage `json:"d"`
}

func fakeRead(ctx context.Context, conn *websocket.Conn) fakeEnvelope {
	_, data, err := conn.Read(ctx)
	if err != nil {
		panic(err)
	}
	var message fakeEnvelope
	if err := json.Unmarshal(data, &message); err != nil {
		panic(err)
	}
	return message
}

func fakeWrite(ctx context.Context, conn *websocket.Conn, op int, data any) {
	raw, err := json.Marshal(data)
	if err != nil {
		panic(err)
	}
	payload, err := json.Marshal(fakeEnvelope{Op: op, D: raw})
	if err != nil {
		panic(err)
	}
	if err := conn.Write(ctx, websocket.MessageText, payload); err != nil {
		panic(err)
	}
}
