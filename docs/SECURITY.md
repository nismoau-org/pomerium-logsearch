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
- **CI secrets**: GitHub Actions uses only the built-in `GITHUB_TOKEN` for GHCR. No long-lived registry passwords, no personal access tokens committed as repo secrets unless required; document rotation if added.
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
- **No auth → therefore no remote**: because the MVP has no authentication, remote exposure must never be the default. If remote access is ever needed, add auth first (reverse proxy with auth, or basic auth built in) — treat as a prerequisite, not a follow-up.
- **Docker socket is root-equivalent**: mounting `/var/run/docker.sock` grants full control of the host Docker daemon. Mitigations:
  - README must state this plainly (trusted host, local-only tool)
  - never expose the UI (or the socket) to untrusted networks
  - prefer read-only intent in code: only call `ContainerList` + `ContainerLogs`; no other Docker API usage
- **Read-only by design**: the app performs no writes to the Docker API, no file writes (in-memory buffer), no outbound network calls except localhost WebSocket/HTTP with the browser.
- **Input validation**: JSON lines parsed defensively (size cap per line, no panic on malformed input); regex search compiled with error handling (invalid pattern → 400, no server panic).
- **Dependency hygiene**: minimal dependencies; `go mod tidy` + `go.sum` committed; periodic `govulncheck ./...`; pin base images by digest where practical.

## 4) Project generality

- The project must work for **any** Pomerium Docker deployment, not one specific environment:
  - container name fully configurable (`POMERIUM_CONTAINER` env, `--container` flag; `/api/containers` list supports picking any container)
  - no hardcoded internal names in code (constants/docs use generic examples)
  - docs describe behavior generically ("any container running Pomerium")
- If a feature only makes sense for one internal setup, it does not belong in this project.

## 5) Publishing hygiene (public source safety)

- Before first push to a public repo:
  - [ ] `git log` contains no secrets/internal info (fresh repo preferred)
  - [ ] `grep` repo for keys/tokens (`gitleaks detect .` clean)
  - [ ] docs contain no internal hostnames/IPs/container names
  - [ ] sample fixtures anonymized
  - [ ] LICENSE present, README states local-only + docker-socket caveat
- Ongoing: CI secret scanning (e.g. `gitleaks` step in `ci.yml` — see checklist below).

## Implementation checklist
- [ ] `.gitignore` includes `.env`, `*.pem`, `*.key`, `*.crt`, `credentials*`, `docker-compose.override.yml`
- [ ] Add `gitleaks` (or similar) scan step to `ci.yml`
- [ ] Optional: pre-commit hook with secret scanning
- [ ] Generic naming throughout docs/code: container example = `pomerium`, hosts = `example.com`, IPs = `127.0.0.1` only
- [ ] Env/flag config for container name (`POMERIUM_CONTAINER` / `--container`)
- [ ] README security section: docker socket caveat + localhost-only guarantee
- [ ] Bind guard: refuse non-loopback bind without explicit override flag
- [ ] Line-size cap + defensive JSON parsing
- [ ] `go.sum` committed; `govulncheck ./...` run before releases
- [ ] Pre-publish checklist (section 5) executed before making repo public
