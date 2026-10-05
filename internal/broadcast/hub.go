// Package broadcast fans log entries and status messages out to WebSocket
// subscribers. Messages are pre-encoded JSON; slow consumers never block the
// producer (their message is dropped and counted).
package broadcast

import (
	"encoding/json"
	"sync"
	"sync/atomic"

	"github.com/nismoau-org/pomerium-logsearch/internal/logparse"
)

// ChanSize bounds each subscriber queue; overflow drops (never blocks).
const ChanSize = 256

// Hub keeps the subscriber set. The zero value is unusable; use New.
type Hub struct {
	mu      sync.Mutex
	subs    map[chan []byte]struct{}
	dropped atomic.Uint64
}

// New returns an empty Hub.
func New() *Hub {
	return &Hub{subs: make(map[chan []byte]struct{})}
}

// Subscribe registers a subscriber, returning its channel and an unsubscribe
// func. Unsubscribe is idempotent; it removes the channel from the set and
// closes it. Callers must invoke it (typically deferred) to avoid leaks.
func (h *Hub) Subscribe() (<-chan []byte, func()) {
	ch := make(chan []byte, ChanSize)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	var once sync.Once
	unsub := func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subs, ch)
			h.mu.Unlock()
			close(ch)
		})
	}
	return ch, unsub
}

// broadcast sends one pre-encoded message to all subscribers without
// blocking; full subscriber queues drop the message and bump Dropped.
func (h *Hub) broadcast(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- msg:
		default:
			h.dropped.Add(1)
		}
	}
}

// MarshalLog encodes a log message as sent on the wire.
func MarshalLog(e logparse.Entry) []byte {
	msg, _ := json.Marshal(map[string]any{"type": "log", "line": e})
	return msg
}

// MarshalStatus encodes a status message as sent on the wire.
func MarshalStatus(state, message string) []byte {
	msg, _ := json.Marshal(map[string]any{"type": "status", "state": state, "message": message})
	return msg
}

// MarshalError encodes an error message as sent on the wire.
func MarshalError(message string) []byte {
	msg, _ := json.Marshal(map[string]any{"type": "error", "message": message})
	return msg
}

// Broadcast fans out one log entry (alias BroadcastLog).
func (h *Hub) Broadcast(e logparse.Entry) { h.broadcast(MarshalLog(e)) }

// BroadcastLog fans out one log entry.
func (h *Hub) BroadcastLog(e logparse.Entry) { h.Broadcast(e) }

// BroadcastStatus fans out a status message (connected/connecting/
// reconnecting/disconnected/error).
func (h *Hub) BroadcastStatus(state, message string) { h.broadcast(MarshalStatus(state, message)) }

// BroadcastError fans out an error message.
func (h *Hub) BroadcastError(message string) { h.broadcast(MarshalError(message)) }

// Dropped returns the total messages dropped for slow consumers.
func (h *Hub) Dropped() uint64 { return h.dropped.Load() }

// Subscribers returns the current subscriber count.
func (h *Hub) Subscribers() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}
