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

### Filtering / search
- Level filter (exact + alias match)
- `allow`/`deny` tri-state filters (true/false/omit)
- Reason contains filter matches any of the four reason fields
- User/email, path/host (with `authority` fallback), response-code exact/partial
- Full-text: case-insensitive substring over raw + parsed values
- Regex: valid pattern matches; invalid pattern → error returned (no server panic), UI shows message
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
- `GET /api/containers` returns fixture/default container JSON
- `GET /api/buffer` with no params → default limit 1000
- `GET /api/buffer` with each filter param (`level`, `allow`, `deny`, `resp`, `user`, `path`, `host`, `q`, `regex=true`) → correct subset
- Invalid regex `q&regex=true` → 400 with error JSON
- `GET /api/buffer` `offset`/`limit` pagination boundaries (0, >total, negative → clamped)
- Bind address: server listens only on configured `127.0.0.1:8081` (config test)

## 4) WebSocket tests

- Connect `/ws` → receive `status` connected message
- Inject line into broadcaster → client receives `log` message with `id/ts/raw/parsed`
- Multiple clients receive same lines
- Disconnect cleanly; server side cleans up subscriber

## 5) Frontend tests (lightweight, optional for MVP)

MVP: manual smoke checklist (below). Optional automation later:
- **Option A**: Playwright against a mocked server (static UI + fixture `/api/buffer`) — covers rendering, filters, expand/collapse, follow/pause
- **Option B**: keep JS thin; cover logic (filter predicates) by extracting to a small pure-JS module and testing with `node --test`

Recommend Option B first if automating; defer for MVP.

## 6) Manual smoke checklist (pre-release)

Run against real Pomerium container `pomerium-github-pomerium-1`:

1. `docker compose -f docker-compose.example.yml up --build`
2. Open `http://127.0.0.1:8081`
3. Initial buffer loads (≈1000 lines), footer shows `connected`
4. Live tail: new lines appear, autoscroll follows
5. Pause stops autoscroll; Follow resumes to bottom
6. Search: plain text finds matches; regex toggle works; invalid regex shows error
7. Level dropdown filters correctly
8. Allow/Deny tri-state + reason filter on authorize logs
9. User/email, path/host, response-code filters
10. Click row → full JSON expands; copy buttons work (request-id, user, path, host)
11. Restart Pomerium container → UI reconnects, streaming resumes (status shows reconnecting → connected)
12. Restart UI container → buffer refills from initial tail
13. Confirm no exposure: `curl -H "Host: evil" http://127.0.0.1:8081` works locally only; not reachable from another host
14. High-volume check: burst logs remain responsive (scroll/search smooth)

## 7) Performance checks (informal)

- Buffer at max (10k lines): scroll + filter latency feels instant (client-side virtualization)
- WebSocket with rapid log burst (e.g. loop of 1000 lines/s) → no UI freeze, dropped frames only if any
- Memory stable while tailing (UI container RSS stays bounded; ring buffer cap enforced)

## 8) CI integration

From [CI-CD.md](CI-CD.md):
- `ci.yml` → `test` job: `go vet ./...`, `gofmt -l .`, `go test -race ./...` (unit + HTTP/WS tests)
- `ci.yml` → `docker` job: image builds
- Integration tests (`//go:build integration`): run in CI only if a Docker daemon is available on the runner (GitHub-hosted runners have Docker) — either include in `test` job with `go test -race -tags integration ./...` or a separate `integration` job; default plan: separate job so failures are isolated

## Implementation checklist
- [ ] Unit: parsing/normalization + fixtures from real Pomerium log lines
- [ ] Unit: ring buffer + concurrency (`-race`)
- [ ] Unit: filter/search predicates (incl. invalid regex)
- [ ] Unit: broadcaster fan-out
- [ ] HTTP API tests (`httptest`) for `/`, `/api/containers`, `/api/buffer` (all params)
- [ ] WS tests (subscribe, receive, multi-client)
- [ ] Integration tests behind `//go:build integration` tag (streaming, reconnect, demux, missing container)
- [ ] Add `integration` job to `ci.yml`
- [ ] Frontend: manual smoke checklist per release; optional `node --test` for filter predicates
