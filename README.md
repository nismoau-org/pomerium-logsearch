# pomerium-logsearch

Fast, simple, read-only web UI for tailing and searching Pomerium Core logs from Docker.

## Goal
Provide a local-only web UI to tail and search JSON logs emitted by Pomerium (running in Docker) with Pomerium-specific filters. Read-only by design.

## Key decisions
- Source: Docker container `pomerium-github-pomerium-1` (single container only)
- Run mode: Docker container (self-contained), mounted with `/var/run/docker.sock`
- Bind: `127.0.0.1:8081` (localhost-only)
- Buffer: in-memory ring buffer (last 10k lines), initial load 1000 lines, no persistence
- Priority filters: allow/deny + reason, user/email, path/host, response-code
- UI: Vanilla JS, virtualized list, WebSocket for live tail, embedded static files

## Quickstart
1. Build UI container image
2. Run UI container with docker socket mounted, published on `127.0.0.1:8081:8081`
3. Open http://127.0.0.1:8081

## Security
- Localhost-only (`127.0.0.1`)
- Read-only; no disk writes by default
- Minimal surface area; designed for local debugging
