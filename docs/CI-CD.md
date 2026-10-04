# CI/CD Plan (GitHub Actions)

## Overview
Build, test, and publish the `pomerium-logsearch` Docker image using GitHub Actions. Images are published to GitHub Container Registry (GHCR) with tags derived from git refs. The README quickstart pulls the published image instead of building locally.

## Workflows

### 1) `.github/workflows/ci.yml` — CI (on push/PR)
Runs on `push` to `main` and `pull_request` to `main`.

| Job | Steps |
| --- | --- |
| `test` | Checkout, setup Go, `go vet ./...`, `gofmt -l .` (fail on diff), `go test -race ./...` (unit + HTTP/WS tests), build binary (`go build ./...`) |
| `integration` | Checkout, setup Go, `go test -race -tags integration ./...` (Docker-based streaming/reconnect tests; GitHub runners include a Docker daemon) — separate job so failures are isolated |
| `docker` | Checkout, `docker build` (verifies Dockerfile builds; no push), `docker compose config` (validates `docker-compose.yml` syntax/interpolation) |

- Concurrency: cancel in-progress runs for the same ref (`group: ci-${{ github.ref }}`).
- No secrets needed for CI.
- Test strategy details: see [TESTS.md](TESTS.md).

### 2. `.github/workflows/release.yml` — Build & Push image (on tag / main)

Runs on:
- `push` to `main` (publishes `edge` + `sha-<shortsha>` tags)
- `push` tags matching `v*` (publishes `latest`, `<version>`, `<major>.<minor>` tags)

| Job | Steps |
| --- | --- |
| `image` | Checkout, setup QEMU, setup Buildx, `docker/metadata-action` for tags/labels, login to GHCR (`docker/login-action`) using `GITHUB_TOKEN`, `docker/build-push-action` with `push: true`, `cache-from/to: type=gha` |

**Tag strategy (`docker/metadata-action`)**:

| Ref | Tags |
| --- | --- |
| tag `v1.2.3` | `latest`, `1.2.3`, `1.2` |
| branch `main` | `edge`, `sha-abc1234` |

**Image name**: `ghcr.io/<owner>/pomerium-logsearch`

- **Permissions**: `contents: read`, `packages: write`.
- **No manual secrets**: GHCR login uses the built-in `GITHUB_TOKEN`.
- **Provenance/SBOM (optional later)**: `build-push-action` supports `provenance: true` / `sbom: true`; can enable in a follow-up.

### 3) `.github/workflows/nightly.yml` — optional nightly rebuild (later)
Rebuild `edge` image weekly to pick up base-image security updates (Go/alpine/distroless). Reuses the same build-push job as release with `edge` tag only.

## Security notes
- PRs from forks never push images (release workflow only triggers on `push` to `main`/tags).
- Pin major action versions (`actions/checkout@v4`, `docker/setup-buildx-action@v3`, `docker/build-push-action@v6`, etc.); optionally pin full SHAs later for supply-chain hardening.
- Image runs read-only purpose but mounts the host Docker socket; document this in README (local-only, trusted hosts only).

## Release flow
1. Developer tags release: `git tag v0.1.0 && git push origin v0.1.0`
2. `release.yml` builds and pushes `ghcr.io/<owner>/pomerium-logsearch:v0.1.0` (+ `latest`, `0.1`)
3. README quickstart (docker compose, primary path):
   ```sh
   # pull published image instead of building
   POMERIUM_CONTAINER=<name> docker compose up -d
   ```
   or plain `docker run`: `docker run -p 127.0.0.1:8081:8081 -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/<owner>/pomerium-logsearch:latest`

## Implementation checklist
- [ ] Add `.github/workflows/ci.yml` (vet/fmt/test + integration job + docker build + `docker compose config` validation)
- [ ] Add `.github/workflows/release.yml` (GHCR push with metadata tags)
- [ ] Set repo package visibility (GHCR default: private → set public if desired)
- [ ] Update README quickstart to reference published image via docker compose (fallback: local `--build`)
- [ ] (Optional) Add `.github/workflows/nightly.yml`
