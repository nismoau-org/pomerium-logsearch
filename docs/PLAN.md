# Implementation Plan

## 1) Goals
- Tail logs from the Pomerium Docker container in real time (JSON stdout/stderr); container name configurable (`POMERIUM_CONTAINER` / `--container`, default `pomerium`)
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
- Header: container label (fixed at startup), Follow/Pause, Sort asc/desc, Jump to live, Time-range calendar popup, Clear, Search + regex, Level dropdown
- Quick filters (prominent): allow/deny tri-state, allow/deny reason contains, user/email, path/host, response-code; "more filters" row: service, request-id, method, message, time; Columns menu toggling the 11-column union grid (time, level, service, decision, code, user, path, method, host, req-id, message)
- Main: virtualized list (newest at bottom by default), compact rows with badges; click to expand full JSON with copy buttons for: request-id/check-request-id, user, email, path, host, authority, route-id, upstream-cluster
- Footer: buffer size/count, connection status (connected/connecting/reconnecting/error), last timestamp, visible count

## 5) API
- `GET /` - UI
- `GET /api/buffer` - raw buffered lines (client-side filtering/search; pagination via `limit`/`offset`)
- `WS /ws` - live stream (container fixed at startup via `POMERIUM_CONTAINER`)
- MVP has no container-selection endpoints; filtering is client-side only (see [API.md](API.md) for future items)

## 6) Performance & Safety
- Localhost-only `127.0.0.1:8081`; read-only; in-memory only
- Virtualization, debounced search (150-250ms), client-side filtering over buffer
- Reconnect with backoff on stream errors/restarts

## 7) Implementation steps
1. Scaffold Go module + embedded static files
2. Docker API client + log streaming
3. Ring buffer + normalization + WebSocket broadcaster
4. HTTP endpoints (`/api/buffer`, `WS /ws`)
5. Frontend: virtualized list + filters + search + expand/collapse
6. Dockerfile (multi-stage build)
7. **Deployment via docker compose**: ship `docker-compose.yml` at repo root (pulls the prebuilt GHCR image — no `build:` section, so the file is paste-ready for Portainer stacks; publish `${HOST_BIND:-127.0.0.1}:8081:8081` (loopback default), `POMERIUM_CONTAINER` env with `${POMERIUM_CONTAINER:-pomerium}` default, `TAG` env selecting the image tag with `${TAG:-edge}` default, `BIND_ADDR` + `ALLOW_REMOTE` (in-container bind opt-in), `BUFFER_SIZE`/`INIT_TAIL` env, `read_only` + `no-new-privileges` hardening, `user: "0:0"` for socket access) plus `docker-compose.build.yml` (developer override layering `build: .` back on for `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`) and document one-command usage in README (`POMERIUM_CONTAINER=<name> docker compose up -d` → open `http://127.0.0.1:8081`)
8. Tests (see [TESTS.md](TESTS.md)): unit (parsing, ring buffer, filters, broadcaster), HTTP/WS tests (`httptest`), integration tests behind `//go:build integration` tag
9. GitHub Actions CI/CD (see [CI-CD.md](CI-CD.md)): `ci.yml` (vet/fmt/test + docker build + integration job + gitleaks) and `release.yml` (push image to GHCR on `main` and `v*` tags); compose file verified in CI via `docker compose config`
10. `LICENSE` (MIT), `.gitignore` (secrets/binaries per [SECURITY.md](SECURITY.md)), `.dockerignore`, README + docs
