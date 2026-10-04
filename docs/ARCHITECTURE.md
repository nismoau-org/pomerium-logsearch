# Architecture

## Backend (Go)
- **Module**: single Go module (`github.com/justin/pomerium-logsearch` or user-defined; local only)
- **Docker API**: use `github.com/docker/docker/client` to stream container logs (`ContainerLogs` with `Follow=true`, `Tail=1000`, `ShowStdout=true`, `ShowStderr=true`)
- **Ring buffer**: fixed-capacity (10k lines) storing entries with `id`, `ts`, `raw` (original JSON string), `parsed` (normalized map)
- **Broadcaster**: fan-out new log lines to connected WebSocket clients; handle subscribe/unsubscribe cleanly
- **HTTP server**: serves embedded static UI and REST endpoints; bind to `127.0.0.1:8081` only
- **Resilience**: reconnect to Docker stream on error/container restart with exponential backoff; emit status messages over WebSocket

## Frontend
- **Embedded assets**: `index.html`, `app.js`, `styles.css` embedded via `go:embed` (no build step for MVP)
- **Rendering**: vanilla JS with requestAnimationFrame-based virtualized list for high-volume logs
- **Transport**: WebSocket for live stream; `fetch` for initial buffer and container list
- **Filtering**: client-side predicates (level, allow/deny, user/email, path/host, response-code) combined with full-text/regex search over raw+parsed fields
- **UX**: newest at bottom, follow auto-scrolls, pause stops autoscroll; JSON expand/collapse per row; copy buttons for key fields

## Deployment
- **Containerized UI**: runs as its own Docker container; mounts `/var/run/docker.sock:/var/run/docker.sock` (read-only access not strictly required for logs API, but keep read-only intent)
- **Networking**: publish `127.0.0.1:8081:8081` only (localhost-bound)
- **Runtime**: read-only, in-memory only; no disk persistence by default
- **Config**: environment variables or flags (`POMERIUM_CONTAINER`, `BIND_ADDR`, `BUFFER_SIZE`, `INIT_TAIL`)
