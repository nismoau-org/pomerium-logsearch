# Implementation Plan

## 1) Goals
- Tail logs from `pomerium-github-pomerium-1` in real time (JSON stdout/stderr)
- Fast simple web UI bound to localhost only (read-only)
- Search/full-text + regex, field filters: level, service, request-id, user, email, path, host, allow/deny (+reasons), response-code, message
- JSON expand per line, pause/follow, virtualized list
- Single Go binary, minimal dependencies
- Run as Docker container (self-contained) with `/var/run/docker.sock` mounted on `127.0.0.1:8081`

## 2) Architecture
- Backend (Go): Docker API client streams logs (Follow=true, Tail=1000, ShowStdout/Stderr), ring buffer (last 10k lines), HTTP+WebSocket, embedded static UI
- Frontend: embedded `index.html`/`app.js`/`styles.css` via `go:embed`, vanilla JS, virtualized list
- Containerization: distroless/static binary in Docker image

## 3) Log processing
- Split NDJSON, parse JSON; fallback to raw if malformed
- Normalize: time, level, service, message, request-id/check-request-id, user, email, path, host, method, query, allow/deny and reasons, response-code/status, authority, upstream-cluster, ip, route-id, container
- Preserve raw JSON for expand/collapse

## 4) UI
- Header: container (fixed to `pomerium-github-pomerium-1`), Follow/Pause, Clear, Search + regex, Level dropdown (all/trace/debug/info/warn/error)
- Quick filters (prominent): allow/deny tri-state, allow/deny reason contains, user/email, path/host, response-code (exact or partial)
- Main: virtualized list (newest at bottom), compact rows with badges; click to expand full JSON with copy buttons for: request-id/check-request-id, user, email, path, host, authority, route-id
- Footer: buffer size/count, connection status (connected/connecting/reconnecting/error), last timestamp

## 5) API
- `GET /` - UI
- `GET /api/containers` - list containers
- `GET /api/buffer` - query buffered logs with filters
- `WS /ws?container=<name>` - live stream

## 6) Performance & Safety
- Localhost-only `127.0.0.1:8081`; read-only; in-memory only
- Virtualization, debounced search (150-250ms), client-side filtering over buffer
- Reconnect with backoff on stream errors/restarts

## 7) Implementation steps
1. Scaffold Go module + embedded static files
2. Docker API client + log streaming
3. Ring buffer + normalization + WebSocket broadcaster
4. HTTP endpoints (containers, buffer)
5. Frontend: virtualized list + filters + search + expand/collapse
6. Dockerfile (multi-stage build)
7. `docker-compose.example.yml`
8. GitHub Actions CI/CD (see [CI-CD.md](CI-CD.md)): `ci.yml` (vet/fmt/test + docker build) and `release.yml` (push image to GHCR on `main` and `v*` tags)
9. README + docs
