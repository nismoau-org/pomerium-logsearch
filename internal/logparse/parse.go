// Package logparse splits Docker log streams and parses NDJSON lines into
// normalized entries. All parsing is defensive: malformed input never panics
// and per-line size caps bound memory use (see docs/SECURITY.md).
package logparse

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const (
	// MaxRawBytes caps a single stored raw line.
	MaxRawBytes = 256 * 1024
	// MaxMessageBytes caps the fallback message kept from a malformed line.
	MaxMessageBytes = 8 * 1024
	// MaxFrameBytes bounds a single Docker multiplexed frame we will decode.
	MaxFrameBytes = 16 << 20
)

// Entry is the JSON shape served by GET /api/buffer and WS /ws.
type Entry struct {
	ID     string         `json:"id"`
	TS     string         `json:"ts"`
	Raw    string         `json:"raw"`
	Parsed map[string]any `json:"parsed"`
}

var idCounter atomic.Uint64

// nextID returns a unique, increasing "<unixnano>-<counter>" id.
func nextID() string {
	n := idCounter.Add(1)
	return fmt.Sprintf("%d-%d", time.Now().UTC().UnixNano(), n)
}

// ParseLine parses one NDJSON log line from container into an Entry.
// Empty/blank input yields a zero Entry (ID == ""); callers must skip those.
func ParseLine(raw string, container string) Entry {
	now := time.Now().UTC()
	if strings.TrimSpace(raw) == "" {
		return Entry{}
	}
	truncated := false
	if len(raw) > MaxRawBytes {
		raw = raw[:MaxRawBytes]
		truncated = true
	}
	trimmed := strings.TrimSpace(raw)

	var m map[string]any
	if err := json.Unmarshal([]byte(trimmed), &m); err != nil || m == nil {
		msg := trimmed
		if len(msg) > MaxMessageBytes {
			msg = msg[:MaxMessageBytes]
		}
		parsed := map[string]any{"_raw": true, "message": msg}
		if truncated {
			parsed["_truncated"] = true
		}
		if container != "" {
			parsed["container"] = container
		}
		return Entry{ID: nextID(), TS: now.Format(time.RFC3339Nano), Raw: raw, Parsed: parsed}
	}

	parsed := make(map[string]any, len(m)+2)
	for k, v := range m {
		parsed[k] = v
	}

	ts := now.Format(time.RFC3339Nano)
	if t, ok := parseTime(m["time"]); ok {
		ts = t
	}

	if v, ok := m["level"]; ok {
		if s, ok := v.(string); ok {
			lvl := strings.ToLower(s)
			if lvl == "warning" {
				lvl = "warn"
			}
			parsed["level"] = lvl
		}
	}
	if s, ok := firstString(m, "service", "service-name", "logger"); ok {
		parsed["service"] = s
	}
	if s, ok := firstString(m, "message", "msg"); ok {
		parsed["message"] = s
	}
	if s, ok := firstString(m, "request-id", "check-request-id"); ok {
		parsed["request-id"] = s
	}
	if s, ok := firstString(m, "host", "authority"); ok {
		parsed["host"] = s
	}
	if v, ok := firstPresent(m, "response-code", "status", "status-code"); ok {
		if s, ok := stringifyCode(v); ok {
			parsed["response-code"] = s
		}
	}
	if d := decision(m); d != "" {
		parsed["decision"] = d
	}
	if container != "" {
		parsed["container"] = container
	}
	if truncated {
		parsed["_truncated"] = true
	}
	return Entry{ID: nextID(), TS: ts, Raw: raw, Parsed: parsed}
}

// decision derives "allow"/"deny"/"" from Pomerium authorize fields.
// The four reason fields are preserved verbatim via the map copy in ParseLine.
func decision(m map[string]any) string {
	if b, ok := asBool(m["allow"]); ok {
		if b {
			return "allow"
		}
		return "deny"
	}
	if b, ok := asBool(m["deny"]); ok && b {
		return "deny"
	}
	if hasValue(m["allow-why-true"]) {
		return "allow"
	}
	if hasValue(m["deny-why-true"]) {
		return "deny"
	}
	return ""
}

// parseTime renders the log "time" field as RFC3339Nano, accepting RFC3339
// strings and epoch seconds/millis/micros/nanos (numeric or string).
func parseTime(v any) (string, bool) {
	switch t := v.(type) {
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return "", false
		}
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
			if tm, err := time.Parse(layout, s); err == nil {
				return tm.UTC().Format(time.RFC3339Nano), true
			}
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return formatEpoch(f), true
		}
		return "", false
	case float64:
		return formatEpoch(t), true
	case float32:
		return formatEpoch(float64(t)), true
	case int:
		return formatEpoch(float64(t)), true
	case int64:
		return formatEpoch(float64(t)), true
	case uint64:
		return formatEpoch(float64(t)), true
	default:
		return "", false
	}
}

func formatEpoch(f float64) string {
	var tm time.Time
	switch {
	case f >= 1e17 || f <= -1e17: // nanoseconds
		tm = time.Unix(0, int64(f)).UTC()
	case f >= 1e14 || f <= -1e14: // microseconds
		tm = time.Unix(0, int64(f)*1e3).UTC()
	case f >= 1e11 || f <= -1e11: // milliseconds
		tm = time.Unix(0, int64(f)*1e6).UTC()
	default: // seconds (may carry a fractional part)
		sec, frac := math.Modf(f)
		tm = time.Unix(int64(sec), int64(frac*1e9)).UTC()
	}
	return tm.Format(time.RFC3339Nano)
}

func firstString(m map[string]any, keys ...string) (string, bool) {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok := v.(string); ok && s != "" {
				return s, true
			}
		}
	}
	return "", false
}

func firstPresent(m map[string]any, keys ...string) (any, bool) {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			return v, true
		}
	}
	return nil, false
}

func stringifyCode(v any) (string, bool) {
	switch t := v.(type) {
	case nil:
		return "", false
	case string:
		return t, t != ""
	case float64:
		if t == math.Trunc(t) && math.Abs(t) < 1e15 {
			return strconv.FormatInt(int64(t), 10), true
		}
		return strconv.FormatFloat(t, 'f', -1, 64), true
	case bool:
		return strconv.FormatBool(t), true
	default:
		return fmt.Sprint(t), true
	}
}

func asBool(v any) (bool, bool) {
	switch t := v.(type) {
	case bool:
		return t, true
	case string:
		if b, err := strconv.ParseBool(strings.TrimSpace(t)); err == nil {
			return b, true
		}
		return false, false
	case float64:
		return t != 0, true
	default:
		return false, false
	}
}

func hasValue(v any) bool {
	if v == nil {
		return false
	}
	if s, ok := v.(string); ok {
		return s != ""
	}
	return true
}

// headerValid reports whether p starts with a plausible Docker multiplexed
// frame header: stream byte 0-2, three zero bytes, big-endian uint32 size.
func headerValid(p []byte) bool {
	if len(p) < 8 {
		return false
	}
	if p[0] > 2 {
		return false
	}
	if p[1] != 0 || p[2] != 0 || p[3] != 0 {
		return false
	}
	size := binary.BigEndian.Uint32(p[4:8])
	return size <= MaxFrameBytes
}

// IsMultiplexed reports whether p begins with a plausible non-empty Docker
// multiplexed-stream frame. Plain NDJSON starts with "{" (0x7B), so it never
// matches the stream-type byte.
func IsMultiplexed(p []byte) bool {
	if !headerValid(p) {
		return false
	}
	return binary.BigEndian.Uint32(p[4:8]) > 0
}

// StripDockerHeader removes a single leading 8-byte multiplex header,
// returning b unchanged when no header is present.
func StripDockerHeader(b []byte) []byte {
	if IsMultiplexed(b) {
		return b[8:]
	}
	return b
}

// DemuxDockerFrame pops one complete multiplexed frame off the front of p,
// returning its payload and the remainder. ok is false when p holds no
// header or only an incomplete frame (caller must read more).
func DemuxDockerFrame(p []byte) (payload, rest []byte, ok bool) {
	if !headerValid(p) {
		return nil, p, false
	}
	size := binary.BigEndian.Uint32(p[4:8])
	if size == 0 {
		return []byte{}, p[8:], true
	}
	if uint64(len(p)) < 8+uint64(size) {
		return nil, p, false
	}
	return p[8 : 8+size], p[8+size:], true
}

// SplitDockerStream splits a stream chunk into payloads: multiplexed frames
// are demuxed when the chunk starts with a valid frame header, otherwise the
// chunk is treated as plain NDJSON and split on newlines. A trailing
// incomplete frame is dropped (streaming callers must buffer across reads;
// see DemuxDockerFrame).
func SplitDockerStream(p []byte) [][]byte {
	if !IsMultiplexed(p) {
		return bytes.Split(p, []byte{'\n'})
	}
	var out [][]byte
	for len(p) > 0 {
		payload, rest, ok := DemuxDockerFrame(p)
		if !ok {
			break
		}
		out = append(out, payload)
		p = rest
	}
	return out
}
