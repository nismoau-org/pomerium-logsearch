# pomerium-logsearch

Fast, simple, read-only web UI for tailing and searching Pomerium Core logs from Docker.

## Goal
Provide a local-only web UI to tail and search JSON logs emitted by Pomerium (running in Docker) with Pomerium-specific filters. Read-only by design.

## Key decisions
- Source: Docker container running Pomerium (name configurable via `POMERIUM_CONTAINER`, default `pomerium`)
- Run mode: Docker container (self-contained), mounted with `/var/run/docker.sock`
- Bind: `127.0.0.1:8081` (localhost-only; `HOST_BIND` deploy-time override exists — LAN exposure is at your own risk, see Security)
- Buffer: in-memory ring buffer (last 10k lines), initial load 1000 lines, no persistence
- Filters: allow/deny + reason, user/email, path/host, response-code, service, request-id, method, message, time substring, absolute time-range picker (all client-side, AND-combined)
- UI: Vanilla JS, virtualized list, WebSocket live tail, sort asc/desc, jump-to-live, toggleable columns, embedded static files

## Quickstart (docker compose)
1. Pull and run the prebuilt image (no build step — this `docker-compose.yml`
   has no `build:` section, so it is also paste-ready for Portainer stacks):
   ```sh
   POMERIUM_CONTAINER=<your-pomerium-container> docker compose up -d
   ```
   (`POMERIUM_CONTAINER` must match `docker ps` output; default: `pomerium`.
   `TAG=latest` selects the latest `v*` release instead of the default `edge`.)
2. Open http://127.0.0.1:8081
3. Stop with `docker compose down`

Developers — build from source instead of pulling:
```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Notes:
- The UI is published on host loopback only (`127.0.0.1:8081`) via `HOST_BIND` (default); setting `HOST_BIND=0.0.0.0` exposes an unauthenticated UI to the LAN — prefer an authenticated reverse proxy or SSH tunnel instead.
- The compose file mounts `/var/run/docker.sock` (root-equivalent) and runs as `user: "0:0"` (required for socket access) — trusted hosts only.
- See [docker-compose.yml](docker-compose.yml) for all options (`POMERIUM_CONTAINER`, `TAG`, `HOST_BIND`, `BIND_ADDR`, `ALLOW_REMOTE`, `BUFFER_SIZE`, `INIT_TAIL`).

## Security
- Localhost-only (`127.0.0.1`)
- Read-only; no disk writes by default
- Minimal surface area; designed for local debugging
- See [docs/SECURITY.md](docs/SECURITY.md) for the full security plan (secret hygiene, non-disclosure of internal configs, Docker socket caveat)

## Troubleshooting
- **Refuses to start**: `refusing to bind non-loopback address "0.0.0.0:8081"` — the shipped compose already sets the required `ALLOW_REMOTE=true`; if you see this you are running an old stack file or a bare binary without `--allow-remote`.
- **Empty logs** (`/api/buffer` shows `total: 0`): the container can't read the Docker socket (needs `user: "0:0"`, shipped in compose), `POMERIUM_CONTAINER` doesn't match `docker ps` on that host, or the target's log driver keeps no stdout/stderr (check `docker logs <name>` on the host first).
- **UI stuck on `reconnecting`**: the page loads but the browser's WebSocket upgrade fails. Verify the server is innocent with `curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==" http://<host>:8081/ws` (expect `101`); if that works, something on the network path (VPN, filter, proxy) mangles `Upgrade` headers while passing plain GETs.
- **Portainer `listing workers for Build` errors**: the stack file contains a `build:` section — use the shipped pull-only `docker-compose.yml` (set stack env vars instead of editing YAML: `POMERIUM_CONTAINER`, `TAG`, `HOST_BIND`).

## Documentation
- [docs/PLAN.md](docs/PLAN.md) — implementation plan
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — backend/frontend/deployment architecture
- [docs/UI-SPEC.md](docs/UI-SPEC.md) — UI specification
- [docs/API.md](docs/API.md) — HTTP/WebSocket API
- [docs/TESTS.md](docs/TESTS.md) — test plan
- [docs/CI-CD.md](docs/CI-CD.md) — GitHub Actions pipeline
- [docs/SECURITY.md](docs/SECURITY.md) — security & hygiene plan

## License
MIT (LICENSE added during implementation)
