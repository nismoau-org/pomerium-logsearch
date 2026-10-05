// Package server serves the embedded UI, the /api/buffer endpoint and the
// live WS /ws stream. Filtering is client-side only: the server ships raw
// buffered lines and broadcasts every new line to all subscribers.
package server

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"github.com/nismoau-org/pomerium-logsearch/internal/broadcast"
	"github.com/nismoau-org/pomerium-logsearch/internal/buffer"
)

const (
	wsWriteTimeout = 10 * time.Second
	wsPingInterval = 30 * time.Second
	wsPongWait     = 60 * time.Second
)

// Server wires the ring buffer and hub to HTTP routes.
type Server struct {
	ring      *buffer.Ring
	hub       *broadcast.Hub
	container string
	upgrader  websocket.Upgrader
}

// New returns a Server for containerName backed by ring and hub.
func New(ring *buffer.Ring, hub *broadcast.Hub, containerName string) *Server {
	return &Server{
		ring:      ring,
		hub:       hub,
		container: containerName,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			CheckOrigin:     checkOrigin,
		},
	}
}

// Routes builds the HTTP handler. staticFS is the embedded web directory
// (files at its root: index.html, app.js, styles.css).
func (s *Server) Routes(staticFS fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleStatic(staticFS))
	mux.HandleFunc("/api/buffer", s.handleBuffer)
	mux.HandleFunc("/ws", s.handleWS)
	return mux
}

// checkOrigin accepts origin-less clients (curl, tests), loopback origins,
// and same-origin requests; anything else is rejected at upgrade time.
func checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" {
		return false
	}
	oh := strings.ToLower(u.Hostname())
	if oh == "localhost" || oh == "::1" || oh == "127.0.0.1" || strings.HasPrefix(oh, "127.") {
		return true
	}
	if ip := net.ParseIP(oh); ip != nil && ip.IsLoopback() {
		return true
	}
	rh := strings.ToLower(r.Host)
	if h, _, err := net.SplitHostPort(rh); err == nil {
		rh = h
	}
	rh = strings.Trim(rh, "[]")
	return oh == rh
}

func (s *Server) handleStatic(staticFS fs.FS) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if strings.Contains(p, "..") || strings.Contains(p, "\\") {
			http.NotFound(w, r)
			return
		}
		data, err := fs.ReadFile(staticFS, p)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		switch {
		case strings.HasSuffix(p, ".html"):
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
		case strings.HasSuffix(p, ".js"):
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		case strings.HasSuffix(p, ".css"):
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
		case strings.HasSuffix(p, ".json"):
			w.Header().Set("Content-Type", "application/json")
		case strings.HasSuffix(p, ".svg"):
			w.Header().Set("Content-Type", "image/svg+xml")
		}
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(data)
	}
}

// handleBuffer serves {"total","container","lines"} newest-first with
// limit/offset pagination. No server-side filtering (client-side only).
func (s *Server) handleBuffer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	limit := queryInt(q.Get("limit"), 1000)
	offset := queryInt(q.Get("offset"), 0)
	resp := map[string]any{
		"total":     s.ring.Len(),
		"container": s.container,
		"lines":     s.ring.SnapshotNewest(limit, offset),
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(resp)
}

func queryInt(v string, def int) int {
	if strings.TrimSpace(v) == "" {
		return def
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		return def
	}
	return n
}

// handleWS upgrades the connection, sends a unicast connected status, then
// forwards hub messages until either side disconnects.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return // handshake failed (e.g. rejected origin); Upgrade wrote the error
	}
	defer conn.Close()

	sub, unsub := s.hub.Subscribe()
	defer unsub()

	conn.SetReadLimit(512)
	conn.SetReadDeadline(time.Now().Add(wsPongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(wsPongWait))
		return nil
	})
	// Read pump: the client sends nothing; draining observes close/ping.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.NextReader(); err != nil {
				return
			}
		}
	}()

	// Unicast hello (not a hub broadcast: this client only).
	conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
	hello := broadcast.MarshalStatus("connected",
		fmt.Sprintf("streaming logs from container %q", s.container))
	if err := conn.WriteMessage(websocket.TextMessage, hello); err != nil {
		return
	}

	ticker := time.NewTicker(wsPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case msg, ok := <-sub:
			if !ok {
				return
			}
			conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
