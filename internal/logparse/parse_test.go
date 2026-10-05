package logparse

import (
	"encoding/binary"
	"strings"
	"testing"
)

func TestParseValidAuthorizeLine(t *testing.T) {
	raw := `{"level":"info","service":"authorize","time":"2026-10-04T12:20:40Z","request-id":"req-123","user":"alice@example.com","email":"alice@example.com","path":"/api/data","host":"example.com","method":"GET","response-code":403,"allow":false,"deny-why-true":"policy denied"}`
	e := ParseLine(raw, "pomerium")
	if e.ID == "" {
		t.Fatal("expected non-empty ID")
	}
	if e.TS != "2026-10-04T12:20:40Z" && !strings.HasPrefix(e.TS, "2026-10-04T12:20:40") {
		t.Fatalf("unexpected ts %q", e.TS)
	}
	p := e.Parsed
	for k, want := range map[string]string{
		"level": "info", "service": "authorize", "request-id": "req-123",
		"user": "alice@example.com", "path": "/api/data", "host": "example.com",
		"response-code": "403", "decision": "deny", "container": "pomerium",
	} {
		if got, _ := p[k].(string); got != want {
			t.Errorf("parsed[%q] = %q, want %q", k, got, want)
		}
	}
	if p["deny-why-true"] != "policy denied" {
		t.Errorf("reason field not preserved: %v", p["deny-why-true"])
	}
	if e.Raw != raw {
		t.Error("raw not preserved")
	}
}

func TestParseMalformedFallsBack(t *testing.T) {
	e := ParseLine("not json at all {{{", "pomerium")
	if e.ID == "" {
		t.Fatal("malformed line must still be emitted")
	}
	if e.Parsed["_raw"] != true {
		t.Errorf("expected _raw marker, got %v", e.Parsed)
	}
}

func TestParseEmptySkipped(t *testing.T) {
	for _, s := range []string{"", "   ", "\n\t "} {
		if e := ParseLine(s, "pomerium"); e.ID != "" {
			t.Errorf("input %q: expected zero Entry, got ID %q", s, e.ID)
		}
	}
}

func TestLevelNormalization(t *testing.T) {
	cases := map[string]string{"warning": "warn", "WARNING": "warn", "INFO": "info", "Critical": "critical"}
	for in, want := range cases {
		e := ParseLine(`{"level":"`+in+`"}`, "")
		if got, _ := e.Parsed["level"].(string); got != want {
			t.Errorf("level %q -> %q, want %q", in, got, want)
		}
	}
}

func TestFieldAliasing(t *testing.T) {
	e := ParseLine(`{"check-request-id":"chk-9","authority":"auth.example.com","status":401}`, "")
	if got := e.Parsed["request-id"]; got != "chk-9" {
		t.Errorf("request-id alias: got %v", got)
	}
	if got := e.Parsed["host"]; got != "auth.example.com" {
		t.Errorf("host alias: got %v", got)
	}
	if got := e.Parsed["response-code"]; got != "401" {
		t.Errorf("response-code alias: got %v", got)
	}
}

func TestDecisionDerivation(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{`{"allow":true}`, "allow"},
		{`{"allow":false}`, "deny"},
		{`{"deny":true}`, "deny"},
		{`{"allow-why-true":"matched policy"}`, "allow"},
		{`{"deny-why-true":"blocked"}`, "deny"},
		{`{"message":"hello"}`, ""},
	}
	for _, c := range cases {
		e := ParseLine(c.raw, "")
		got, _ := e.Parsed["decision"].(string)
		if got != c.want {
			t.Errorf("raw %s: decision = %q, want %q", c.raw, got, c.want)
		}
	}
}

func TestTimestampFallback(t *testing.T) {
	e := ParseLine(`{"message":"no time"}`, "")
	if e.TS == "" {
		t.Fatal("expected receive-time fallback")
	}
	e2 := ParseLine(`{"time":"not-a-time","message":"x"}`, "")
	if e2.TS == "" {
		t.Fatal("expected fallback for invalid time")
	}
	// epoch seconds
	e3 := ParseLine(`{"time":1791225640,"message":"x"}`, "")
	if !strings.HasPrefix(e3.TS, "2026-") {
		t.Errorf("epoch ts = %q", e3.TS)
	}
}

func TestIDsMonotonic(t *testing.T) {
	a := ParseLine(`{"m":1}`, "")
	b := ParseLine(`{"m":2}`, "")
	if a.ID == b.ID || a.ID == "" || b.ID == "" {
		t.Fatalf("IDs not unique: %q %q", a.ID, b.ID)
	}
}

func frame(payload string, stream byte) []byte {
	h := make([]byte, 8)
	h[0] = stream
	binary.BigEndian.PutUint32(h[4:], uint32(len(payload)))
	return append(h, payload...)
}

func TestDemuxDockerFrame(t *testing.T) {
	p1 := frame(`{"a":1}`, 1)
	p2 := frame(`{"b":2}`, 2)
	joined := append(p1, p2...)
	pay, rest, ok := DemuxDockerFrame(joined)
	if !ok || string(pay) != `{"a":1}` {
		t.Fatalf("first frame: ok=%v pay=%q", ok, pay)
	}
	pay2, rest2, ok2 := DemuxDockerFrame(rest)
	if !ok2 || string(pay2) != `{"b":2}` || len(rest2) != 0 {
		t.Fatalf("second frame: ok=%v pay=%q rest=%q", ok2, pay2, rest2)
	}
	// incomplete frame must report ok=false without consuming
	if _, _, ok := DemuxDockerFrame(p1[:len(p1)-2]); ok {
		t.Error("incomplete frame must not decode")
	}
	// plain NDJSON is not multiplexed
	plain := []byte("{\"x\":1}\n{\"y\":2}\n")
	if IsMultiplexed(plain) {
		t.Error("plain NDJSON misdetected as multiplexed")
	}
	if got := SplitDockerStream(plain); len(got) != 3 { // trailing newline -> empty tail
		t.Errorf("SplitDockerStream plain = %d parts, want 3", len(got))
	}
	if got := SplitDockerStream(joined); len(got) != 2 {
		t.Errorf("SplitDockerStream mux = %d parts, want 2", len(got))
	}
}
