package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/nismoau-org/pomerium-logsearch/internal/broadcast"
	"github.com/nismoau-org/pomerium-logsearch/internal/buffer"
	"github.com/nismoau-org/pomerium-logsearch/internal/logparse"
)

func testServer() (*Server, *buffer.Ring, *broadcast.Hub) {
	ring := buffer.New(10)
	hub := broadcast.New()
	return New(ring, hub, "pomerium"), ring, hub
}

func TestBufferDefaultsAndPagination(t *testing.T) {
	s, ring, _ := testServer()
	for _, raw := range []string{`{"m":1}`, `{"m":2}`, `{"m":3}`} {
		ring.Add(logparse.ParseLine(raw, "pomerium"))
	}
	ts := httptest.NewServer(s.Routes(testrStaticFS()))
	defer ts.Close()

	// default limit
	res, err := http.Get(ts.URL + "/api/buffer")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body struct {
		Total     int              `json:"total"`
		Container string           `json:"container"`
		Lines     []logparse.Entry `json:"lines"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Total != 3 || body.Container != "pomerium" || len(body.Lines) != 3 {
		t.Fatalf("default buffer = %+v", body)
	}
	if body.Lines[0].Raw != `{"m":3}` {
		t.Errorf("newest-first order broken: %q", body.Lines[0].Raw)
	}

	// pagination boundaries: offset beyond total -> empty; negative clamped
	for url, want := range map[string]int{
		"/api/buffer?limit=1&offset=1":   1,
		"/api/buffer?limit=10&offset=99": 0,
		"/api/buffer?limit=2&offset=-5":  2,
	} {
		res, err := http.Get(ts.URL + url)
		if err != nil {
			t.Fatal(err)
		}
		var b struct {
			Lines []logparse.Entry `json:"lines"`
		}
		if err := json.NewDecoder(res.Body).Decode(&b); err != nil {
			res.Body.Close()
			t.Fatal(err)
		}
		res.Body.Close()
		if len(b.Lines) != want {
			t.Errorf("GET %s: %d lines, want %d", url, len(b.Lines), want)
		}
	}
}

func TestStaticServesUI(t *testing.T) {
	s, _, _ := testServer()
	ts := httptest.NewServer(s.Routes(testrStaticFS()))
	defer ts.Close()
	res, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET / = %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct == "" {
		t.Error("missing content type")
	}
}

func wsDial(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	return conn
}

func readMsg(t *testing.T, conn *websocket.Conn) map[string]any {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var m map[string]any
	if err := conn.ReadJSON(&m); err != nil {
		t.Fatalf("ws read: %v", err)
	}
	return m
}

func TestWSHelloAndLogFanout(t *testing.T) {
	s, ring, hub := testServer()
	ts := httptest.NewServer(s.Routes(testrStaticFS()))
	defer ts.Close()
	wsURL := "ws" + ts.URL[len("http"):] + "/ws"

	c1 := wsDial(t, wsURL)
	defer c1.Close()
	if m := readMsg(t, c1); m["type"] != "status" {
		t.Fatalf("hello = %v, want status", m)
	}

	// inject a line via the hub (as the docker streamer would)
	e := logparse.ParseLine(`{"level":"error","message":"boom"}`, "pomerium")
	ring.Add(e)
	hub.BroadcastLog(e)

	if m := readMsg(t, c1); m["type"] != "log" {
		t.Fatalf("second msg = %v, want log", m)
	}

	// second client receives subsequent lines too
	c2 := wsDial(t, wsURL)
	defer c2.Close()
	_ = readMsg(t, c2) // hello
	e2 := logparse.ParseLine(`{"level":"info","message":"hi"}`, "pomerium")
	hub.BroadcastLog(e2)
	if m := readMsg(t, c1); m["type"] != "log" {
		t.Fatalf("c1 third msg = %v", m)
	}
	if m := readMsg(t, c2); m["type"] != "log" {
		t.Fatalf("c2 second msg = %v", m)
	}

	// clean disconnect must not hang the server
	_ = c1.Close()
	_ = c2.Close()
	time.Sleep(100 * time.Millisecond)
}
