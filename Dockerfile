# pomerium-logsearch — multi-stage build (single static Go binary on distroless)
#
# Build:   docker build -t pomerium-logsearch .
# Compose: POMERIUM_CONTAINER=<name> docker compose up -d            # pulls :edge
#          TAG=x docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
#
# The app listens on BIND_ADDR inside the container (compose sets
# BIND_ADDR=0.0.0.0:8081; exposure is controlled by the host loopback
# port mapping in docker-compose.yml). Read-only filesystem compatible:
# the binary performs no disk writes (/tmp is a tmpfs in compose).

# ---- Stage 1: builder ----
FROM golang:1.26-alpine AS builder

WORKDIR /src

# Cache module downloads separately from source changes.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Static binary: no cgo, trimmed paths, stripped symbols.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/pomerium-logsearch .

# ---- Stage 2: runtime (minimal, no shell) ----
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /out/pomerium-logsearch /pomerium-logsearch

EXPOSE 8081

USER nonroot

ENTRYPOINT ["/pomerium-logsearch"]
