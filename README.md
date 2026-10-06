# pomerium-logsearch

<p align="center">
  <img src="assets/logo-shield.svg" width="120" alt="pomerium-logsearch logo">
</p>

**A friendly log viewer that sits alongside your Pomerium zero-trust proxy.**

If you run Pomerium Core in Docker, its logs are lines of JSON buried in `docker logs` — hard to scan and impossible to filter. This tool gives you a fast web page for watching those logs live and searching them, with filters that understand Pomerium fields (allow/deny decisions, users, request IDs, client IPs…). It changes nothing about Pomerium and needs no Pomerium configuration: it simply reads your Pomerium container's log stream and presents it readably.

<details>
<summary>Logo concepts</summary>

| Logscope | Shield tail | Filter funnel |
| --- | --- | --- |
| ![Logscope: a magnifier over log lines](assets/logo-scope.svg) | ![Shield tail: a shield with log lines and a live cursor](assets/logo-shield.svg) | ![Filter funnel: log lines narrowing through a funnel to one result](assets/logo-funnel.svg) |
| Searching the stream | Zero-trust roots, live tail | Narrowing logs to signal |

</details>

## How it fits in

- **You already have:** Docker, plus a Pomerium container running in it (often named `pomerium` — check with `docker ps`).
- **You add:** this container. It reads Pomerium's log output through the Docker socket and serves a local web UI at http://127.0.0.1:8081 (your machine only, not your network).
- **Read-only by design:** it never writes to disk — logs live in memory (the last 10,000 lines) — and never touches your Pomerium setup.

## What you can do with it

- **Watch logs live** as requests arrive, **pause** to look around, and **jump back to live** when ready.
- **Search everything** (plain text or regex).
- **Filter by column** — click any column header: log level, allow/deny decision plus reason, user, client IP (with a Public/Private toggle), path, host, forwarded-for, request ID, message, or time range. Active filters show right in the header.
- **Click a value to isolate it** — click a request ID (or IP, host, etc.) in any row to filter to just that; click again to clear.
- **Shape the table** — show or hide any column (including any field found in your logs), and drag header edges to resize.
- **Inspect a row** — expand it for pretty-printed JSON with one-click copy buttons for key fields.
- **Sort** oldest-first or newest-first.

## Quickstart

You need Docker running and your Pomerium container running. First find your Pomerium container's exact name:

```sh
docker ps --format '{{.Names}}'
```

Then start this tool (replace `<your-pomerium-container>` with that name; the default is `pomerium`):

```sh
POMERIUM_CONTAINER=<your-pomerium-container> docker compose up -d
```

Then open http://127.0.0.1:8081 in your browser. To stop it later: `docker compose down`.

Notes:
- The ready-made `docker-compose.yml` pulls the prebuilt image (no build step) and also works pasted into Portainer stacks. `TAG=latest` selects the latest `v*` release instead of the default `edge`.
- Developers — build from source instead of pulling:
  ```sh
  docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
  ```
- The UI listens on host loopback only (`127.0.0.1:8081`). Setting `HOST_BIND=0.0.0.0` would expose an unauthenticated UI to your LAN — prefer an authenticated reverse proxy or SSH tunnel instead.
- The compose file mounts `/var/run/docker.sock` (powerful — equivalent to root on the host) and runs as `user: "0:0"` (required to read the socket) — trusted hosts only.
- See [docker-compose.yml](docker-compose.yml) for all options (`POMERIUM_CONTAINER`, `TAG`, `HOST_BIND`, `BIND_ADDR`, `ALLOW_REMOTE`, `BUFFER_SIZE`, `INIT_TAIL`).

## Troubleshooting

- **No logs showing?** Check the basics on the host first: does `docker logs <your-pomerium-container>` print lines? If yes, make sure `POMERIUM_CONTAINER` matches `docker ps` exactly and the stack runs as `user: "0:0"` (shipped in the compose file) so it can read the Docker socket.
- **Refuses to start**: `refusing to bind non-loopback address "0.0.0.0:8081"` — the shipped compose already sets the required `ALLOW_REMOTE=true`; if you see this you are running an old stack file or a bare binary without `--allow-remote`.
- **UI stuck on `reconnecting`**: the page loads but the browser's live-update connection fails. Verify the server is innocent (any random nonce works as the key — it is sent in cleartext on every handshake by design, so use a fresh one, never a pasted value):
  ```sh
  KEY=$(openssl rand -base64 16)
  curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: $KEY" http://<host>:8081/ws
  ```
  Expect `101 Switching Protocols`. If that works, something on the network path (VPN, filter, proxy) mangles `Upgrade` headers while passing plain GETs.
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
