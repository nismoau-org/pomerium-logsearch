# Security Plan

Hygiene and security requirements for `pomerium-logsearch`. The project is **general in nature**: it must not depend on or disclose any specific internal environment.

## 1) Secret hygiene (never leak API keys / tokens)

- **No secrets in the repo**: no API keys, tokens, passwords, certificates, private keys, or session cookies in source, docs, config, fixtures, or commit history.
- **No secrets in examples**: docs and sample configs use placeholders only (`<token>`, `changeme`, `example.com`). Never paste real values "temporarily".
- **.gitignore first**: `.env`, `*.pem`, `*.key`, `*.crt`, `credentials*`, `config.local.yaml`, `docker-compose.override.yml` are ignored from day one.
- **Log safety**: the UI tails logs that may contain sensitive fields (Pomerium can log cookies, tokens, request bodies if configured). Requirements:
  - never persist log content to disk (in-memory only, as decided)
  - never forward logs outside the host (no telemetry, no analytics, no external endpoints)
  - treat all log data as potentially sensitive in the UI (local-only bind)
- **CI secrets**: GitHub Actions uses the built-in `GITHUB_TOKEN` for GHCR plus `GITLEAKS_LICENSE` (repo/org secret from gitleaks.io — required by `gitleaks-action@v3` for organization repos). No long-lived registry passwords, no other personal access tokens; rotate the license secret if it is ever exposed and document rotation if more secrets are added.
- **Pre-commit (optional but recommended)**: `gitleaks` / `detect-secrets` pre-commit hook to block accidental key commits before they reach history (history rewriting after a leak is painful).
- **If a secret is ever committed**: rotate it immediately, then purge from history (`git filter-repo` or BFG) and force-push only after rotation — rotation comes first.

## 2) Internal network / environment non-disclosure

- **No internal identifiers in docs or code**: docs use generic examples only:
  - container name: `pomerium` (configurable via `POMERIUM_CONTAINER` env / CLI flag) — no environment-specific names like `<org>-<repo>-<n>`
  - hostnames: `example.com`, `localhost` — no internal DNS names
  - IPs: `127.0.0.1` only — no RFC1918 ranges (`10.x`, `192.168.x`, `172.16-31.x`) or internal service IPs in docs/examples
  - ports: documented defaults (`8081`) only — no custom internal port layouts
- **No deployment details**: no company-specific topology, cluster names, registry paths, project/repo names of internal systems, or infrastructure screenshots.
- **No real log samples**: test fixtures are synthetic or fully anonymized (no real emails, user IDs, tokens, internal URLs from production logs).
- **README/docs review before publishing**: search docs for internal names, hostnames, IPs, and keys before every release.

## 3) Runtime security

- **Localhost-only by default**: bind `127.0.0.1:8081`; refuse `0.0.0.0` unless explicitly overridden by a flag (e.g. `--allow-remote`), and warn loudly if used.
  - Exception that proves the rule: the shipped `docker-compose.yml` sets `BIND_ADDR=0.0.0.0:8081` **plus** `ALLOW_REMOTE=true`, because a process in a container network namespace must listen on all interfaces to receive its published port — the localhost-only guarantee there comes from the host `ports:` mapping (`127.0.0.1:8081:8081`). Running the binary directly on a host keeps the `127.0.0.1` default.
- **No auth → therefore no remote**: because the MVP has no authentication, remote exposure must never be the default. If remote access is ever needed, add auth first (reverse proxy with auth, or basic auth built in) — treat as a prerequisite, not a follow-up.
- **Docker socket is root-equivalent**: mounting `/var/run/docker.sock` grants full control of the host Docker daemon. Mitigations:
  - README must state this plainly (trusted host, local-only tool)
  - never expose the UI (or the socket) to untrusted networks
  - prefer read-only intent in code: only call `ContainerList` + `ContainerLogs`; no other Docker API usage
  - the shipped `docker-compose.yml` sets `user: "0:0"` because the socket is `root:docker/0660` on most hosts and a non-root user gets permission denied (empty buffer, no error in stdout). This grants nothing beyond what the socket mount already implies; `read_only` + `no-new-privileges` still apply.
- **Read-only by design**: the app performs no writes to the Docker API, no file writes (in-memory buffer), no outbound network calls except localhost WebSocket/HTTP with the browser.
- **Input validation**: JSON lines parsed defensively (size cap per line, no panic on malformed input); regex search compiled with error handling (invalid pattern → 400, no server panic).
- **Dependency hygiene**: minimal dependencies; `go mod tidy` + `go.sum` committed; periodic `govulncheck ./...`; pin base images by digest where practical.

## 4) Project generality

- The project must work for **any** Pomerium Docker deployment, not one specific environment:
  - container name fully configurable (`POMERIUM_CONTAINER` env / `--container` flag; fixed at startup — no container-selection UI in MVP)
  - no hardcoded internal names in code (constants/docs use generic examples)
  - docs describe behavior generically ("any container running Pomerium")
- If a feature only makes sense for one internal setup, it does not belong in this project.

## 5) Publishing hygiene (source safety)

Repo status: now **public** (`nismoau-org/pomerium-logsearch`); hygiene rules below apply on an ongoing basis.

- Pre-publish checklist (executed on release; re-verify per release):
  - [x] `git log` contains no secrets/internal info (`gitleaks detect` clean over history)
  - [x] `grep` repo for keys/tokens (`gitleaks detect .` clean)
  - [x] docs contain no internal hostnames/IPs/container names (generic examples only: `pomerium`, `example.com`, `127.0.0.1`)
  - [x] sample fixtures anonymized (synthetic `alice@example.com` / `example.com` only)
  - [x] LICENSE (MIT) present, README states local-only + docker-socket caveat
- Ongoing: CI secret scanning (`gitleaks-action@v3` step in `ci.yml` — requires the `GITLEAKS_LICENSE` repo/org secret).

## Implementation checklist
- [x] `.gitignore` includes `.env`, `*.pem`, `*.key`, `*.crt`, `credentials*`, `docker-compose.override.yml`
- [x] Add `gitleaks-action@v3` scan step to `ci.yml` (with `GITLEAKS_LICENSE` repo/org secret)
- [ ] Optional: pre-commit hook with secret scanning
- [x] Add MIT `LICENSE`
- [x] Generic naming throughout docs/code: container example = `pomerium`, hosts = `example.com`, IPs = `127.0.0.1` only
- [x] Env/flag config for container name (`POMERIUM_CONTAINER` / `--container`)
- [x] README security section: docker socket caveat + localhost-only guarantee
- [x] Bind guard: refuse non-loopback bind without explicit override flag (`--allow-remote` / `ALLOW_REMOTE`)
- [x] Line-size cap + defensive JSON parsing
- [x] `go.sum` committed
- [ ] `govulncheck ./...` run before releases
- [x] Pre-publish checklist (section 5) executed before making repo public
