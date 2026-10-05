# Architecture

## Backend (Go)
- **Module**: single Go module (`github.com/nismoau-org/pomerium-logsearch` or user-defined; local only)
- **Docker API**: use `github.com/docker/docker/client` to stream container logs (`ContainerLogs` with `Follow=true`, `Tail=1000`, `ShowStdout=true`, `ShowStderr=true`)
- **Ring buffer**: fixed-capacity (10k lines) storing entries with `id`, `ts`, `raw` (original JSON string), `parsed` (normalized map)
- **Broadcaster**: fan-out new log lines to connected WebSocket clients; handle subscribe/unsubscribe cleanly
- **HTTP server**: serves embedded static UI and REST endpoints; binds `127.0.0.1:8081` by default, refuses non-loopback binds unless `ALLOW_REMOTE`/`--allow-remote` is set (see [SECURITY.md](SECURITY.md))
- **Resilience**: reconnect to Docker stream on error/container restart with exponential backoff; emit status messages over WebSocket
- **History semantics**: first connect replays `INIT_TAIL` daemon-kept lines (default 1000; bounded by the daemon's log retention), then follows live; reconnects use `Tail=100` to avoid reflooding. The ring is in-memory only — restarting this container replays just the `INIT_TAIL` window again. Nothing is ever persisted

## Frontend
- **Embedded assets**: `index.html`, `app.js`, `styles.css` embedded via `go:embed` (no build step for MVP)
- **Rendering**: vanilla JS with requestAnimationFrame-based virtualized list for high-volume logs
- **Transport**: WebSocket for live stream; `fetch` for initial buffer and container list
- **Filtering**: client-side predicates (level, allow/deny + reasons, user/email, path/host, response-code, service, request-id, method, message, time substring, absolute time range) combined with full-text/regex search over raw+parsed fields
- **UX**: sort asc/desc with live-edge follow, jump-to-live, toggleable columns (persisted with sort order in `localStorage`), pause stops autoscroll; column header row; per-column filter row + time-range calendar popup; JSON expand/collapse per row; copy buttons for key fields

## Deployment
- **Primary path: docker compose**: ship `docker-compose.yml` at repo root — one-command deploy (`POMERIUM_CONTAINER=<name> docker compose up -d`). Compose pulls the prebuilt GHCR image (`ghcr.io/nismoau-org/pomerium-logsearch:${TAG:-edge}`; deliberately no `build:` section so the file works in Portainer stacks), mounts `/var/run/docker.sock:/var/run/docker.sock`, publishes **host loopback by default** (`${HOST_BIND:-127.0.0.1}:8081:8081`), and passes config via env (`POMERIUM_CONTAINER` default `pomerium`, `BIND_ADDR` + `ALLOW_REMOTE`, `BUFFER_SIZE`, `INIT_TAIL`). Hardened runtime: `read_only: true`, `no-new-privileges`, `restart: unless-stopped`, `user: "0:0"` (socket access). Developers build from source via the `docker-compose.build.yml` override (`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`).
- **Containerized UI**: runs as its own Docker container; mounts `/var/run/docker.sock` (root-equivalent on host — trusted hosts only; the app itself only calls `ContainerList` + `ContainerLogs`). Runs as `user: "0:0"` because the socket is `root:docker/0660` on most hosts (see [SECURITY.md](SECURITY.md))
- **Networking**: publish `${HOST_BIND:-127.0.0.1}:8081:8081` (host loopback by default; `HOST_BIND` override is at your own risk — the app has no auth)
- **Runtime**: read-only filesystem, in-memory only; no disk persistence by default
- **Config**: environment variables or flags (`POMERIUM_CONTAINER`, `BIND_ADDR`, `ALLOW_REMOTE`, `BUFFER_SIZE`, `INIT_TAIL`); compose uses `${POMERIUM_CONTAINER:-pomerium}` and `${TAG:-edge}` interpolation for easy override. In-container `BIND_ADDR=0.0.0.0:8081` requires the shipped `ALLOW_REMOTE=true` (loopback guarantee comes from the `ports:` mapping)
- **Alternatives**: plain `docker run --user 0:0 -p 127.0.0.1:8081:8081 -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/nismoau-org/pomerium-logsearch:latest` also documented in README (`--user 0:0` needed for socket access, same as compose)
