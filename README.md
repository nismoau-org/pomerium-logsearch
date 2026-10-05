# pomerium-logsearch

Fast, simple, read-only web UI for tailing and searching Pomerium Core logs from Docker.

## Goal
Provide a local-only web UI to tail and search JSON logs emitted by Pomerium (running in Docker) with Pomerium-specific filters. Read-only by design.

## Key decisions
- Source: Docker container running Pomerium (name configurable via `POMERIUM_CONTAINER`, default `pomerium`)
- Run mode: Docker container (self-contained), mounted with `/var/run/docker.sock`
- Bind: `127.0.0.1:8081` (localhost-only)
- Buffer: in-memory ring buffer (last 10k lines), initial load 1000 lines, no persistence
- Priority filters: allow/deny + reason, user/email, path/host, response-code
- UI: Vanilla JS, virtualized list, WebSocket for live tail, embedded static files

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
- The UI is published on host loopback only (`127.0.0.1:8081`); never change it to `0.0.0.0`.
- The compose file mounts `/var/run/docker.sock` (root-equivalent) — trusted hosts only.
- See [docker-compose.yml](docker-compose.yml) for all options (`BUFFER_SIZE`, `INIT_TAIL`, bind address).

## Security
- Localhost-only (`127.0.0.1`)
- Read-only; no disk writes by default
- Minimal surface area; designed for local debugging
- See [docs/SECURITY.md](docs/SECURITY.md) for the full security plan (secret hygiene, non-disclosure of internal configs, Docker socket caveat)

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
