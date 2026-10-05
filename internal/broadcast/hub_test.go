package broadcast

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/nismoau-org/pomerium-logsearch/internal/logparse"
)

func TestFanOutToMultipleSubscribers(t *testing.T) {
	h := New()
	c1, unsub1 := h.Subscribe()
	defer unsub1()
	c2, unsub2 := h.Subscribe()
	defer unsub2()

	e := logparse.Entry{ID: "1", TS: "t", Raw: "{}", Parsed: map[string]any{}}
	h.BroadcastLog(e)

	for i, ch := range []<-chan []byte{c1, c2} {
		select {
		case msg := <-ch:
			var m map[string]any
			if err := json.Unmarshal(msg, &m); err != nil {
				t.Fatalf("sub %d: invalid JSON: %v", i, err)
			}
			if m["type"] != "log" {
				t.Fatalf("sub %d: type = %v", i, m["type"])
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("sub %d: timed out waiting for broadcast", i)
		}
	}
}

func TestSlowConsumerDroppedWithoutBlocking(t *testing.T) {
	h := New()
	sub, unsub := h.Subscribe()
	defer unsub()

	// Fill the queue without reading, then overflow it.
	e := logparse.Entry{ID: "x", Raw: "{}", Parsed: map[string]any{}}
	for i := 0; i < ChanSize+50; i++ {
		h.Broadcast(e)
	}
	if got := h.Dropped(); got == 0 {
		t.Fatal("expected dropped > 0 for overfull subscriber")
	}
	if n := len(sub); n != ChanSize {
		t.Fatalf("queue len = %d, want %d (bounded)", n, ChanSize)
	}
}

func TestUnsubscribeCleansUp(t *testing.T) {
	h := New()
	_, unsub := h.Subscribe()
	if got := h.Subscribers(); got != 1 {
		t.Fatalf("Subscribers = %d, want 1", got)
	}
	unsub()
	unsub() // idempotent
	if got := h.Subscribers(); got != 0 {
		t.Fatalf("Subscribers after unsub = %d, want 0", got)
	}
}

func TestMarshalShapes(t *testing.T) {
	if string(MarshalStatus("connected", "hi")) == "" {
		t.Error("empty status message")
	}
	if string(MarshalError("boom")) == "" {
		t.Error("empty error message")
	}
}
