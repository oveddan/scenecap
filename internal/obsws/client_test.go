package obsws_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/oveddan/scenecap/internal/obsws"
)

func TestConnectChallengeAuthenticationAndReadRequests(t *testing.T) {
	const password = "not-logged"
	server := newServer(t, func(ctx context.Context, c *websocket.Conn) {
		write(t, ctx, c, 0, map[string]any{"obsWebSocketVersion": "5.5.0", "rpcVersion": 1, "authentication": map[string]string{"salt": "salt", "challenge": "challenge"}})
		identify := read(t, ctx, c)
		if identify.Op != 1 {
			panic(fmt.Sprintf("Identify op = %d, want 1", identify.Op))
		}
		var d struct {
			RPCVersion     int    `json:"rpcVersion"`
			Authentication string `json:"authentication"`
		}
		decode(t, identify.D, &d)
		if d.RPCVersion != 1 || d.Authentication != challengeResponse(password, "salt", "challenge") {
			panic("Identify did not use the expected RPC v1 challenge response")
		}
		write(t, ctx, c, 2, map[string]any{"negotiatedRpcVersion": 1})
		for i := 0; i < 3; i++ {
			request := read(t, ctx, c)
			var d struct {
				RequestType string `json:"requestType"`
				RequestID   string `json:"requestId"`
			}
			decode(t, request.D, &d)
			var data any
			switch d.RequestType {
			case "GetVersion":
				data = map[string]any{"obsVersion": "31.0.0", "obsWebSocketVersion": "5.5.0", "availableRequests": []string{"CallVendorRequest"}}
			case "GetInputKindList":
				data = map[string]any{"inputKinds": []string{"screen_capture"}}
			case "GetSourceFilterKindList":
				data = map[string]any{"sourceFilterKinds": []string{"source_record_filter"}}
			default:
				panic(fmt.Sprintf("unexpected request %q", d.RequestType))
			}
			write(t, ctx, c, 7, map[string]any{"requestType": d.RequestType, "requestId": d.RequestID, "requestStatus": map[string]any{"result": true, "code": 100}, "responseData": data})
		}
	})

	c, err := obsws.Connect(context.Background(), serverAddr(server), password)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	version, err := c.GetVersion(context.Background())
	if err != nil || version.OBSVersion != "31.0.0" {
		t.Fatalf("GetVersion() = %#v, %v", version, err)
	}
	inputs, err := c.GetInputKinds(context.Background())
	if err != nil || len(inputs) != 1 || inputs[0] != "screen_capture" {
		t.Fatalf("GetInputKinds() = %#v, %v", inputs, err)
	}
	filters, err := c.GetSourceFilterKinds(context.Background())
	if err != nil || len(filters) != 1 || filters[0] != "source_record_filter" {
		t.Fatalf("GetSourceFilterKinds() = %#v, %v", filters, err)
	}
}

func TestConnectFailedAuthenticationDoesNotExposePassword(t *testing.T) {
	const password = "do-not-leak"
	server := newServer(t, func(ctx context.Context, c *websocket.Conn) {
		write(t, ctx, c, 0, map[string]any{"rpcVersion": 1, "authentication": map[string]string{"salt": "s", "challenge": "c"}})
		_ = read(t, ctx, c)
		write(t, ctx, c, 5, map[string]any{"authentication": map[string]string{"reason": "Authentication Failed"}})
	})
	_, err := obsws.Connect(context.Background(), serverAddr(server), password)
	if err == nil || strings.Contains(err.Error(), password) {
		t.Fatalf("Connect() error = %v; it must fail without exposing password", err)
	}
}

func TestConnectRejectsProtocolErrorAndRequestHonorsCancellation(t *testing.T) {
	t.Run("Hello without authentication", func(t *testing.T) {
		server := newServer(t, func(ctx context.Context, c *websocket.Conn) {
			write(t, ctx, c, 0, map[string]any{"rpcVersion": 1})
		})
		_, err := obsws.Connect(context.Background(), serverAddr(server), "x")
		if err == nil || !strings.Contains(err.Error(), "authentication") {
			t.Fatalf("Connect() error = %v, want authentication error", err)
		}
	})
	t.Run("malformed Identified", func(t *testing.T) {
		server := newServer(t, func(ctx context.Context, c *websocket.Conn) {
			write(t, ctx, c, 0, map[string]any{"rpcVersion": 1, "authentication": map[string]string{"salt": "s", "challenge": "c"}})
			_ = read(t, ctx, c)
			write(t, ctx, c, 2, map[string]any{"negotiatedRpcVersion": "one"})
		})
		_, err := obsws.Connect(context.Background(), serverAddr(server), "x")
		if err == nil || !strings.Contains(err.Error(), "Identified") {
			t.Fatalf("Connect() error = %v, want malformed Identified error", err)
		}
	})
	t.Run("request cancellation", func(t *testing.T) {
		server := newServer(t, func(ctx context.Context, c *websocket.Conn) {
			write(t, ctx, c, 0, map[string]any{"rpcVersion": 1, "authentication": map[string]string{"salt": "s", "challenge": "c"}})
			_ = read(t, ctx, c)
			write(t, ctx, c, 2, map[string]any{"negotiatedRpcVersion": 1})
			_ = read(t, ctx, c) // Deliberately never respond.
			<-ctx.Done()
		})
		c, err := obsws.Connect(context.Background(), serverAddr(server), "x")
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		defer cancel()
		_, err = c.GetVersion(ctx)
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("GetVersion() error = %v, want deadline exceeded", err)
		}
	})
}

func TestRequestsCorrelateOutOfOrderAndIgnoreEvents(t *testing.T) {
	server := newServer(t, func(ctx context.Context, c *websocket.Conn) {
		write(t, ctx, c, 0, map[string]any{"rpcVersion": 1, "authentication": map[string]string{"salt": "s", "challenge": "c"}})
		_ = read(t, ctx, c)
		write(t, ctx, c, 2, map[string]any{"negotiatedRpcVersion": 1})
		first, second := read(t, ctx, c), read(t, ctx, c)
		var one, two struct{ RequestID, RequestType string }
		decode(t, first.D, &one)
		decode(t, second.D, &two)
		write(t, ctx, c, 5, map[string]any{"eventType": "CurrentProgramSceneChanged"})
		respond := func(d struct{ RequestID, RequestType string }) {
			data := map[string]any{"inputKinds": []string{"screen_capture"}}
			if d.RequestType == "GetSourceFilterKindList" {
				data = map[string]any{"sourceFilterKinds": []string{"source_record_filter"}}
			}
			write(t, ctx, c, 7, map[string]any{"requestType": d.RequestType, "requestId": d.RequestID, "requestStatus": map[string]any{"result": true, "code": 100}, "responseData": data})
		}
		respond(two)
		respond(one)
	})
	c, err := obsws.Connect(context.Background(), serverAddr(server), "x")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	inputsDone := make(chan error, 1)
	filtersDone := make(chan error, 1)
	inputResult := make(chan []string, 1)
	filterResult := make(chan []string, 1)
	go func() { result, err := c.GetInputKinds(context.Background()); inputResult <- result; inputsDone <- err }()
	go func() {
		result, err := c.GetSourceFilterKinds(context.Background())
		filterResult <- result
		filtersDone <- err
	}()
	if err := <-inputsDone; err != nil {
		t.Fatalf("GetInputKinds() error = %v", err)
	}
	if err := <-filtersDone; err != nil {
		t.Fatalf("GetSourceFilterKinds() error = %v", err)
	}
	if got := <-inputResult; len(got) != 1 || got[0] != "screen_capture" {
		t.Fatalf("GetInputKinds() = %#v", got)
	}
	if got := <-filterResult; len(got) != 1 || got[0] != "source_record_filter" {
		t.Fatalf("GetSourceFilterKinds() = %#v", got)
	}
}

func TestRequestFailureAndCloseUnblock(t *testing.T) {
	t.Run("OBS failure", func(t *testing.T) {
		server := newServer(t, func(ctx context.Context, c *websocket.Conn) {
			write(t, ctx, c, 0, map[string]any{"rpcVersion": 1, "authentication": map[string]string{"salt": "s", "challenge": "c"}})
			_ = read(t, ctx, c)
			write(t, ctx, c, 2, map[string]any{"negotiatedRpcVersion": 1})
			request := read(t, ctx, c)
			var d struct{ RequestID, RequestType string }
			decode(t, request.D, &d)
			write(t, ctx, c, 7, map[string]any{"requestType": d.RequestType, "requestId": d.RequestID, "requestStatus": map[string]any{"result": false, "code": 203, "comment": "not supported"}})
		})
		c, err := obsws.Connect(context.Background(), serverAddr(server), "x")
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		_, err = c.GetInputKinds(context.Background())
		var requestErr *obsws.RequestError
		if !errors.As(err, &requestErr) || requestErr.Code != 203 || requestErr.Comment != "not supported" {
			t.Fatalf("GetInputKinds() error = %v, want request failure", err)
		}
	})
	t.Run("Close unblocks", func(t *testing.T) {
		server := newServer(t, func(ctx context.Context, c *websocket.Conn) {
			write(t, ctx, c, 0, map[string]any{"rpcVersion": 1, "authentication": map[string]string{"salt": "s", "challenge": "c"}})
			_ = read(t, ctx, c)
			write(t, ctx, c, 2, map[string]any{"negotiatedRpcVersion": 1})
			_ = read(t, ctx, c)
			<-ctx.Done()
		})
		c, err := obsws.Connect(context.Background(), serverAddr(server), "x")
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { _, err := c.GetInputKinds(context.Background()); done <- err }()
		time.Sleep(10 * time.Millisecond)
		_ = c.Close() // The deliberately non-cooperating fake may skip close handshake.
		select {
		case err := <-done:
			if !errors.Is(err, obsws.ErrClosed) {
				t.Fatalf("blocked request error = %v, want ErrClosed", err)
			}
		case <-time.After(time.Second):
			t.Fatal("Close did not unblock request")
		}
	})
}

func TestValidateAddress(t *testing.T) {
	for _, tt := range []struct {
		address string
		valid   bool
	}{
		{"127.0.0.1:4455", true},
		{"127.255.255.255:1", true},
		{"[::1]:4455", true},
		{"localhost:4455", false},
		{"10.0.0.1:4455", false},
		{"127.0.0.1:0", false},
		{"127.0.0.1:65536", false},
		{"127.0.0.1:http", false},
		{"ws://127.0.0.1:4455", false},
	} {
		err := obsws.ValidateAddress(tt.address)
		if (err == nil) != tt.valid {
			t.Errorf("ValidateAddress(%q) = %v, valid=%t", tt.address, err, tt.valid)
		}
	}
}

type envelope struct {
	Op int             `json:"op"`
	D  json.RawMessage `json:"d"`
}

type fakeServer struct {
	*httptest.Server
	errs chan error
}

func newServer(t *testing.T, handler func(context.Context, *websocket.Conn)) *fakeServer {
	t.Helper()
	server := &fakeServer{errs: make(chan error, 8)}
	server.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"obswebsocket.json"}})
		if err != nil {
			server.errs <- err
			return
		}
		defer c.CloseNow()
		defer func() {
			if recovered := recover(); recovered != nil {
				server.errs <- fmt.Errorf("fake OBS handler: %v", recovered)
			}
		}()
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		handler(ctx, c)
	}))
	t.Cleanup(func() {
		server.Close()
		select {
		case err := <-server.errs:
			t.Error(err)
		default:
		}
	})
	return server
}

func serverAddr(server *fakeServer) string { return strings.TrimPrefix(server.URL, "http://") }

func read(t *testing.T, ctx context.Context, c *websocket.Conn) envelope {
	t.Helper()
	_, data, err := c.Read(ctx)
	if err != nil {
		panic(err)
	}
	var env envelope
	decode(t, data, &env)
	return env
}

func write(t *testing.T, ctx context.Context, c *websocket.Conn, op int, d any) {
	t.Helper()
	data, err := json.Marshal(envelope{Op: op, D: mustJSON(t, d)})
	if err != nil {
		panic(err)
	}
	if err := c.Write(ctx, websocket.MessageText, data); err != nil {
		panic(err)
	}
}

func mustJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}

func decode(t *testing.T, data []byte, result any) {
	t.Helper()
	if err := json.Unmarshal(data, result); err != nil {
		panic(err)
	}
}

func challengeResponse(password, salt, challenge string) string {
	secret := sha256.Sum256([]byte(password + salt))
	secret64 := base64.StdEncoding.EncodeToString(secret[:])
	response := sha256.Sum256([]byte(secret64 + challenge))
	return base64.StdEncoding.EncodeToString(response[:])
}
