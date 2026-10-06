# Test Plan

## Overview
Testing strategy for `pomerium-logsearch`. All tests runnable locally with `go test ./...` and in CI (see [CI-CD.md](CI-CD.md) — the `ci.yml` job runs `go vet`, `gofmt`, and `go test -race ./...`).

## 1) Unit tests (Go, `go test ./...`)

### Log parsing / normalization
- Parse a valid NDJSON line (sample from real Pomerium output) → normalized fields (`level`, `service`, `message`, `time`, `request-id`, `user`, `email`, `path`, `host`, `allow`/`deny` + reasons, `response-code`, etc.)
- Malformed JSON line → falls back to raw storage, no panic, entry still emitted
- Empty lines / Docker stream header bytes are skipped or demuxed correctly
- Timestamps: valid RFC3339 parsed; missing/invalid `time` falls back to receive time
- Level normalization: `warning` → `warn`, `critical`/`fatal`/`panic` grouped correctly; unknown level kept as-is
- Field aliasing: `response-code` vs `status`, `request-id` vs `check-request-id`, `authority` vs `host`

### Ring buffer
- Append under capacity → grows to N
- Append beyond capacity → evicts oldest, keeps newest 10k (configurable)
- IDs are monotonic; `ts` ordering preserved
- Snapshot under concurrent append (race detector: `-race`)

### Filtering / search (client-side in MVP)
MVP filtering/search runs in the browser over the in-memory buffer; Go only serves raw lines. Predicate tests target the JS filter module (`web/filters.js`, automated via `node --test web/filters.test.js` in CI):
- Level filter (exact + alias match)
- `allow`/`deny` tri-state filters (true/false/omit)
- Reason contains filter matches any of the four reason fields
- User/email, path/host (with `authority` fallback), response-code exact/partial
- Service, request-id (`request-id` + `check-request-id`), method, message, time-substring filters
- Absolute time range (`timeFrom`/`timeTo` epoch bounds; unparseable timestamps excluded while a range is active)
- Full-text: case-insensitive substring over raw + parsed values
- Regex: valid pattern matches; invalid pattern → UI shows error (no crash)
- Combined predicates (AND semantics)

### Broadcaster
- Fan-out to multiple WS subscribers; slow consumer dropped or back-pressured without blocking others
- Subscribe/unsubscribe cleans up (no goroutine leaks — verify with `-race` + leak check optional)

## 2) Integration tests (Go, Docker required)

Guard with build tag or env check so CI can skip when no Docker daemon:
```go
//go:build integration
```

- **Streaming**: start test container (e.g. `alpine` writing known JSON lines to stdout) → connect Docker client → assert first lines received, buffer populated
- **Tail option**: container with >N lines → initial `Tail=1000` respected (buffer ≤ 1000)
- **Follow/reconnect**: stop container → assert `status` reconnecting → restart → stream resumes
- **stdout/stderr demux**: lines from both streams parsed correctly (Docker multiplexed frames)
- **Missing container**: `ContainerLogs` error → `status` error surfaced over WS/API, no crash

Use a fixture container built from a tiny Dockerfile or `docker run alpine sh -c '...'` with deterministic output; skip test if `docker` unavailable (`t.Skip`).

## 3) HTTP API tests (`net/http/httptest`)

- `GET /` serves UI (200, `text/html`)
- `GET /api/buffer` with no params → default limit 1000
- `GET /api/buffer` `offset`/`limit` pagination boundaries (0, >total, negative → clamped); response includes `total` and `container`
- No server-side filter params in MVP (filtering is client-side; if added later, test each param → correct subset)
- Bind address: server listens only on configured `127.0.0.1:8081` (config test)

## 4) WebSocket tests

- Connect `/ws` → receive `status` connected message
- Inject line into broadcaster → client receives `log` message with `id/ts/raw/parsed`
- Multiple clients receive same lines
- Disconnect cleanly; server side cleans up subscriber

## 5) Frontend tests

- **JS predicate tests** (`web/filters.test.js`, run in CI via `node --test web/filters.test.js`): level aliases, decision inference (bools + reason fields), every column filter, generic custom-field queries, time-range bounds, invalid-regex error, AND-combination.
- Manual smoke checklist (below) covers rendering, expand/collapse, follow/pause/sort/columns/time-range.
- Deferred: Playwright against a mocked server (static UI + fixture `/api/buffer`) if browser-level automation is ever needed.

## 6) Manual smoke checklist (pre-release)

Run against real Pomerium container `pomerium`:

1. `POMERIUM_CONTAINER=<name> docker compose up -d` (pulls `:edge`; defaults) — or build from source: `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`
2. Open `http://127.0.0.1:8081`
3. Initial buffer loads (≈1000 lines), footer shows `connected`
4. Live tail: new lines appear, autoscroll follows
5. Pause stops autoscroll; Follow resumes to bottom; any manual scroll that leaves the view off the live edge auto-pauses (incoming batches never drag a held position)
6. Search: plain text finds matches; regex toggle works; invalid regex shows error
7. Level header popup: dropdown filters correctly, dismisses on select, header shows marker
8. Decision header popup: Allow/Deny tri-state + reason input filter authorize logs; header shows marker
9. Text header inline edit: click User/Path/Code header, type to filter live, Enter/Escape/outside-click commits back to label with marker
10. Click row → full JSON expands; copy buttons work (request-id, user, path, host)
11. Restart Pomerium container → UI reconnects, streaming resumes (status shows reconnecting → connected)
12. Restart UI container → buffer refills from initial tail
13. Confirm no exposure: `curl -H "Host: evil" http://127.0.0.1:8081` works locally only; not reachable from another host
14. High-volume check: burst logs remain responsive (scroll/search smooth)
15. Sort toggle: newest-first puts newest at top; oldest-first restores newest at bottom; follow pins to the live edge in both orders
16. Jump to live: after scrolling away (paused), jumps to newest rows and resumes follow
17. Columns button: grouped per log type; enable all columns → list scrolls horizontally (no wrapping/clipping), header stays aligned while scrolling; blanks render for rows lacking the key; enable a discovered field and add one by name → both render, filter, and survive reload; drag a header edge to resize (min = header text, double-click resets); toggles + widths + custom columns + sort survive reload via localStorage
18. Service/Req ID/Method/Host/Message headers: click to edit inline, each narrows the list (AND with search)
19. Time header popup: starts collapsed with live tail following; preset (e.g. Last 1 hour) narrows to that window; custom From/To via calendar works; Start-after-end shows an error; Apply/Clear/Escape closes the popup; Reset filters clears everything

## 7) Performance checks (informal)

- Buffer at max (10k lines): scroll + filter latency feels instant (client-side virtualization)
- WebSocket with rapid log burst (e.g. loop of 1000 lines/s) → no UI freeze, dropped frames only if any
- Memory stable while tailing (UI container RSS stays bounded; ring buffer cap enforced)

## 8) CI integration

From [CI-CD.md](CI-CD.md):
- `ci.yml` → `test` job: `go vet ./...`, `gofmt -l .`, `go test -race ./...` (unit + HTTP/WS tests), `go build ./...`
- `ci.yml` → `frontend` job: `node --test web/filters.test.js` (JS predicate tests)
- `ci.yml` → `docker` job: image builds; both compose files validated via `docker compose config`
- `ci.yml` → `security` job: `gitleaks-action@v3` (requires `GITLEAKS_LICENSE` repo/org secret for org repos)
- Integration tests (`//go:build integration`): separate `integration` job (`go test -race -tags integration ./...`) so failures are isolated

## Implementation checklist
- [x] Unit: parsing/normalization + fixtures from real Pomerium log lines
- [x] Unit: ring buffer + concurrency (`-race`)
- [x] Unit: broadcaster fan-out
- [x] HTTP API tests (`httptest`) for `/` and `/api/buffer` (pagination)
- [x] WS tests (subscribe, receive, multi-client)
- [x] Integration tests behind `//go:build integration` tag (streaming, reconnect, demux, missing container)
- [x] Add `integration` job to `ci.yml`
- [x] Frontend: `node --test` predicate tests in CI + manual smoke checklist per release
