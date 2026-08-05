// Package obsws implements the small read-only portion of OBS WebSocket v5
// that scenecap currently needs. It intentionally supports only local ws://
// endpoints; remote OBS control is out of scope for this first slice.
package obsws

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/coder/websocket"
)

const (
	opHello           = 0
	opIdentify        = 1
	opIdentified      = 2
	opRequest         = 6
	opRequestResponse = 7
)

var (
	ErrNonLoopback = errors.New("OBS WebSocket address must be a loopback host")
	ErrClosed      = errors.New("OBS WebSocket client is closed")
)

// RequestError is returned when OBS received a request but did not accept it.
// Its fields are returned by OBS and never contain authentication material.
type RequestError struct {
	RequestType string
	Code        int
	Comment     string
}

func (e *RequestError) Error() string {
	if e.Comment != "" {
		return fmt.Sprintf("OBS request %s failed (%d): %s", e.RequestType, e.Code, e.Comment)
	}
	return fmt.Sprintf("OBS request %s failed (%d)", e.RequestType, e.Code)
}

// Client is safe for concurrent requests.
type Client struct {
	conn *websocket.Conn

	writeMu sync.Mutex
	mu      sync.Mutex
	pending map[string]chan response
	closed  bool
	done    chan struct{}
	nextID  atomic.Uint64
}

type envelope struct {
	Op int             `json:"op"`
	D  json.RawMessage `json:"d"`
}

type hello struct {
	OBSWebSocketVersion string `json:"obsWebSocketVersion"`
	RPCVersion          int    `json:"rpcVersion"`
	Authentication      *struct {
		Challenge string `json:"challenge"`
		Salt      string `json:"salt"`
	} `json:"authentication"`
}

type identified struct {
	NegotiatedRPCVersion int `json:"negotiatedRpcVersion"`
}

type identify struct {
	RPCVersion         int    `json:"rpcVersion"`
	Authentication     string `json:"authentication,omitempty"`
	EventSubscriptions int    `json:"eventSubscriptions"`
}

type response struct {
	RequestType   string `json:"requestType"`
	RequestID     string `json:"requestId"`
	RequestStatus struct {
		Result  bool   `json:"result"`
		Code    int    `json:"code"`
		Comment string `json:"comment"`
	} `json:"requestStatus"`
	ResponseData json.RawMessage `json:"responseData"`
}

// ValidateAddress rejects anything other than a literal loopback host and a
// numeric TCP port. The address must be host:port, not a URL or hostname.
func ValidateAddress(address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil || host == "" || port == "" {
		return fmt.Errorf("invalid OBS WebSocket address %q (want host:port)", address)
	}
	n, err := strconv.ParseUint(port, 10, 16)
	if err != nil || n == 0 {
		return fmt.Errorf("invalid OBS WebSocket port %q", port)
	}
	ip, err := netip.ParseAddr(host)
	if err != nil || !(ip == netip.IPv6Loopback() || (ip.Is4() && ip.As4()[0] == 127)) {
		return ErrNonLoopback
	}
	return nil
}

// Connect performs the OBS Hello/Identify handshake. Password is used only to
// derive the challenge response and is never included in returned errors.
func Connect(ctx context.Context, address, password string) (*Client, error) {
	if err := ValidateAddress(address); err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "ws", Host: address}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	conn, _, err := websocket.Dial(ctx, u.String(), &websocket.DialOptions{
		HTTPClient:   &http.Client{Transport: transport},
		Subprotocols: []string{"obswebsocket.json"},
	})
	if err != nil {
		return nil, fmt.Errorf("dial OBS WebSocket: %w", err)
	}
	fail := func(err error) (*Client, error) {
		_ = conn.Close(websocket.StatusProtocolError, "handshake failed")
		return nil, err
	}

	first, err := readEnvelope(ctx, conn)
	if err != nil {
		return fail(fmt.Errorf("read OBS Hello: %w", err))
	}
	if first.Op != opHello {
		return fail(fmt.Errorf("OBS protocol: expected Hello, got op %d", first.Op))
	}
	var h hello
	if err := json.Unmarshal(first.D, &h); err != nil {
		return fail(fmt.Errorf("parse OBS Hello: %w", err))
	}
	if h.RPCVersion < 1 {
		return fail(errors.New("OBS protocol: Hello has no usable RPC version"))
	}
	if h.Authentication == nil {
		return fail(errors.New("OBS WebSocket authentication is required by scenecap"))
	}
	if password == "" {
		return fail(errors.New("OBS WebSocket requires a password; set SCENECAP_OBS_PASSWORD or provide a config file"))
	}
	id := identify{RPCVersion: 1, Authentication: authentication(password, h.Authentication.Salt, h.Authentication.Challenge), EventSubscriptions: 0}
	if err := writeEnvelope(ctx, conn, opIdentify, id); err != nil {
		return fail(fmt.Errorf("send OBS Identify: %w", err))
	}
	second, err := readEnvelope(ctx, conn)
	if err != nil {
		return fail(fmt.Errorf("read OBS Identified: %w", err))
	}
	if second.Op != opIdentified {
		return fail(fmt.Errorf("OBS authentication or protocol negotiation failed (got op %d)", second.Op))
	}
	var identified identified
	if err := json.Unmarshal(second.D, &identified); err != nil {
		return fail(fmt.Errorf("parse OBS Identified: %w", err))
	}
	if identified.NegotiatedRPCVersion != 1 {
		return fail(fmt.Errorf("OBS protocol: expected negotiated RPC version 1, got %d", identified.NegotiatedRPCVersion))
	}

	c := &Client{conn: conn, pending: make(map[string]chan response), done: make(chan struct{})}
	go c.readLoop()
	return c, nil
}

func authentication(password, salt, challenge string) string {
	secret := sha256.Sum256([]byte(password + salt))
	secret64 := base64.StdEncoding.EncodeToString(secret[:])
	response := sha256.Sum256([]byte(secret64 + challenge))
	return base64.StdEncoding.EncodeToString(response[:])
}

func (c *Client) request(ctx context.Context, requestType string, requestData any) (json.RawMessage, error) {
	if requestType == "" {
		return nil, errors.New("OBS request type is required")
	}
	var data *json.RawMessage
	if requestData != nil {
		encoded, err := json.Marshal(requestData)
		if err != nil {
			return nil, fmt.Errorf("encode OBS request data: %w", err)
		}
		value := json.RawMessage(encoded)
		data = &value
	}
	id := fmt.Sprintf("scenecap-%d", c.nextID.Add(1))
	ch := make(chan response, 1)
	if err := c.addPending(id, ch); err != nil {
		return nil, err
	}
	defer c.removePending(id)

	request := struct {
		RequestType string           `json:"requestType"`
		RequestID   string           `json:"requestId"`
		RequestData *json.RawMessage `json:"requestData,omitempty"`
	}{requestType, id, data}
	c.writeMu.Lock()
	err := writeEnvelope(ctx, c.conn, opRequest, request)
	c.writeMu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("send OBS request: %w", err)
	}

	select {
	case r := <-ch:
		if !r.RequestStatus.Result {
			return nil, &RequestError{RequestType: r.RequestType, Code: r.RequestStatus.Code, Comment: r.RequestStatus.Comment}
		}
		return r.ResponseData, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.done:
		return nil, ErrClosed
	}
}

// Version is the response to OBS's read-only GetVersion request.
type Version struct {
	OBSVersion          string `json:"obsVersion"`
	OBSWebSocketVersion string `json:"obsWebSocketVersion"`
}

// GetVersion queries the OBS and obs-websocket versions.
func (c *Client) GetVersion(ctx context.Context) (Version, error) {
	data, err := c.request(ctx, "GetVersion", nil)
	if err != nil {
		return Version{}, err
	}
	var version Version
	if err := json.Unmarshal(data, &version); err != nil {
		return Version{}, fmt.Errorf("parse GetVersion response: %w", err)
	}
	return version, nil
}

// GetInputKinds queries available OBS input kinds.
func (c *Client) GetInputKinds(ctx context.Context) ([]string, error) {
	data, err := c.request(ctx, "GetInputKindList", nil)
	if err != nil {
		return nil, err
	}
	var result struct {
		InputKinds []string `json:"inputKinds"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("parse GetInputKindList response: %w", err)
	}
	return result.InputKinds, nil
}

// GetSourceFilterKinds queries available source filter kinds.
func (c *Client) GetSourceFilterKinds(ctx context.Context) ([]string, error) {
	data, err := c.request(ctx, "GetSourceFilterKindList", nil)
	if err != nil {
		return nil, err
	}
	var result struct {
		SourceFilterKinds []string `json:"sourceFilterKinds"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("parse GetSourceFilterKindList response: %w", err)
	}
	return result.SourceFilterKinds, nil
}

// Close cleanly closes the WebSocket and unblocks outstanding requests.
func (c *Client) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	c.mu.Unlock()
	return c.conn.Close(websocket.StatusNormalClosure, "scenecap closing")
}

func (c *Client) addPending(id string, ch chan response) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return ErrClosed
	}
	c.pending[id] = ch
	return nil
}

func (c *Client) removePending(id string) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func (c *Client) readLoop() {
	defer close(c.done)
	for {
		env, err := readEnvelope(context.Background(), c.conn)
		if err != nil {
			return
		}
		if env.Op != opRequestResponse {
			continue
		}
		var r response
		if err := json.Unmarshal(env.D, &r); err != nil || r.RequestID == "" {
			continue
		}
		c.mu.Lock()
		ch := c.pending[r.RequestID]
		c.mu.Unlock()
		if ch != nil {
			select {
			case ch <- r:
			default:
			}
		}
	}
}

func readEnvelope(ctx context.Context, conn *websocket.Conn) (envelope, error) {
	typ, data, err := conn.Read(ctx)
	if err != nil {
		return envelope{}, err
	}
	if typ != websocket.MessageText {
		return envelope{}, errors.New("OBS protocol sent a non-text WebSocket message")
	}
	var env envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return envelope{}, fmt.Errorf("decode OBS message: %w", err)
	}
	return env, nil
}

func writeEnvelope(ctx context.Context, conn *websocket.Conn, op int, data any) error {
	payload, err := json.Marshal(struct {
		Op int `json:"op"`
		D  any `json:"d"`
	}{op, data})
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, payload)
}
