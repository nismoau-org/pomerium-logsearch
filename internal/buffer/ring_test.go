package buffer

import (
	"fmt"
	"sync"
	"testing"

	"github.com/nismoau-org/pomerium-logsearch/internal/logparse"
)

func mkEntry(id string) logparse.Entry {
	return logparse.Entry{ID: id, TS: id, Raw: id, Parsed: map[string]any{"id": id}}
}

func TestAddUnderCapacity(t *testing.T) {
	r := New(10)
	for i := 0; i < 5; i++ {
		r.Add(mkEntry(fmt.Sprintf("id-%d", i)))
	}
	if got := r.Len(); got != 5 {
		t.Fatalf("Len = %d, want 5", got)
	}
	snap := r.Snapshot()
	for i, e := range snap {
		if e.ID != fmt.Sprintf("id-%d", i) {
			t.Fatalf("snap[%d] = %q", i, e.ID)
		}
	}
}

func TestEvictsOldestBeyondCapacity(t *testing.T) {
	r := New(3)
	for i := 0; i < 5; i++ {
		r.Add(mkEntry(fmt.Sprintf("id-%d", i)))
	}
	if got := r.Len(); got != 3 {
		t.Fatalf("Len = %d, want 3", got)
	}
	snap := r.Snapshot()
	want := []string{"id-2", "id-3", "id-4"}
	for i, w := range want {
		if snap[i].ID != w {
			t.Fatalf("snap[%d] = %q, want %q", i, snap[i].ID, w)
		}
	}
	if got := r.Cap(); got != 3 {
		t.Fatalf("Cap = %d, want 3", got)
	}
}

func TestSnapshotNewestPagination(t *testing.T) {
	r := New(10)
	for i := 0; i < 5; i++ {
		r.Add(mkEntry(fmt.Sprintf("id-%d", i)))
	}
	// newest first
	got := r.SnapshotNewest(2, 0)
	if len(got) != 2 || got[0].ID != "id-4" || got[1].ID != "id-3" {
		t.Fatalf("page0 = %v", got)
	}
	got = r.SnapshotNewest(2, 2)
	if len(got) != 2 || got[0].ID != "id-2" || got[1].ID != "id-1" {
		t.Fatalf("page1 = %v", got)
	}
	// offset beyond total -> empty non-nil
	got = r.SnapshotNewest(10, 99)
	if got == nil || len(got) != 0 {
		t.Fatalf("over-offset = %v, want empty non-nil", got)
	}
	// limit<=0 -> default, negative offset clamped
	got = r.SnapshotNewest(0, -5)
	if len(got) != 5 {
		t.Fatalf("default limit/clamped offset = %d, want 5", len(got))
	}
	// limit larger than available clamps
	got = r.SnapshotNewest(100, 0)
	if len(got) != 5 {
		t.Fatalf("oversize limit = %d, want 5", len(got))
	}
}

func TestConcurrentAppend(t *testing.T) {
	r := New(1000)
	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 250; i++ {
				r.Add(mkEntry(fmt.Sprintf("w%d-%d", w, i)))
			}
		}(w)
	}
	wg.Wait()
	if got := r.Len(); got != 1000 {
		t.Fatalf("Len = %d, want 1000", got)
	}
	_ = r.Snapshot()
	_ = r.SnapshotNewest(100, 0)
}
