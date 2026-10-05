// Package buffer holds the in-memory ring of recent log entries.
package buffer

import (
	"sync"

	"github.com/nismoau-org/pomerium-logsearch/internal/logparse"
)

const (
	// DefaultCap is the default ring capacity (BUFFER_SIZE).
	DefaultCap = 10000
	// DefaultLimit is the default /api/buffer page size.
	DefaultLimit = 1000
)

// Ring is a thread-safe fixed-capacity ring buffer. Once full, each Add
// evicts the oldest entry. Snapshots copy entries out under lock.
type Ring struct {
	mu    sync.RWMutex
	buf   []logparse.Entry
	start int // index of the oldest entry
	count int // number of live entries (<= len(buf))
}

// New returns a Ring with the given capacity (<=0 selects DefaultCap).
func New(capacity int) *Ring {
	if capacity <= 0 {
		capacity = DefaultCap
	}
	return &Ring{buf: make([]logparse.Entry, capacity)}
}

// Add appends e, evicting the oldest entry when full.
func (r *Ring) Add(e logparse.Entry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.buf) == 0 {
		return
	}
	if r.count < len(r.buf) {
		r.buf[(r.start+r.count)%len(r.buf)] = e
		r.count++
		return
	}
	r.buf[r.start] = e
	r.start = (r.start + 1) % len(r.buf)
}

// at returns the i-th oldest entry; the caller must hold the lock.
func (r *Ring) at(i int) logparse.Entry {
	return r.buf[(r.start+i)%len(r.buf)]
}

// Snapshot returns all entries oldest-first.
func (r *Ring) Snapshot() []logparse.Entry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]logparse.Entry, r.count)
	for i := 0; i < r.count; i++ {
		out[i] = r.at(i)
	}
	return out
}

// SnapshotNewest returns up to limit entries newest-first, skipping offset
// entries from the newest (offset 0 = newest first, for /api/buffer
// pagination). limit <= 0 selects DefaultLimit; negative offsets clamp to 0;
// offset beyond the total yields an empty (non-nil) slice.
func (r *Ring) SnapshotNewest(limit, offset int) []logparse.Entry {
	if limit <= 0 {
		limit = DefaultLimit
	}
	if offset < 0 {
		offset = 0
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if offset >= r.count {
		return []logparse.Entry{}
	}
	avail := r.count - offset
	if limit > avail {
		limit = avail
	}
	out := make([]logparse.Entry, limit)
	for i := 0; i < limit; i++ {
		out[i] = r.at(r.count - 1 - offset - i)
	}
	return out
}

// Len returns the number of buffered entries.
func (r *Ring) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.count
}

// Cap returns the ring capacity (immutable after New).
func (r *Ring) Cap() int {
	return len(r.buf)
}
