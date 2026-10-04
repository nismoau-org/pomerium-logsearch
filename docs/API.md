# API Specification

## GET /
Serves embedded web UI (static files).

## GET /api/containers
Returns list of Docker containers. Filters to include Pomerium-related containers; defaults to include `pomerium`.

**Response**:
```json
{
  "containers": [
    {"id": "abc123", "name": "pomerium", "image": "...", "state": "running"}
  ],
  "default": "pomerium"
}
```

## GET /api/buffer
Query buffered logs with optional filters. Returns JSON payload.

**Query params**:
- `limit` (int, default 1000): max lines to return
- `offset` (int, default 0): offset in filtered buffer (for pagination if needed)
- `q` (string): full-text search term
- `regex` (bool, default false): treat `q` as regex
- `level` (string): filter by level (trace/debug/info/warn/error/...)
- `service` (string): filter by service field
- `user` (string): contains filter on user/email
- `email` (string): contains filter on email (or combined with user)
- `path` (string): contains filter on path
- `host` (string): contains filter on host/authority
- `allow` (bool|null): filter by allow true/false (omit for all)
- `deny` (bool|null): filter by deny true/false
- `resp` (string): response code filter (exact/partial)

**Response**:
```json
{
  "total": 1234,
  "filtered": 42,
  "lines": [
    {
      "id": "uuid-or-ts-n",
      "ts": "2026-10-04T12:20:40Z",
      "raw": "{\"level\":\"info\",...}",
      "parsed": {...normalized fields...}
    }
  ]
}
```

## WS /ws
WebSocket endpoint for live log streaming.

**Query params**:
- `container` (string, default `pomerium`): container name to stream

**Messages (server -> client)**:
- `log`: `{type:"log", line:{id, ts, raw, parsed}}`
- `status`: `{type:"status", state:"connected|connecting|reconnecting|disconnected|error", message:"..."}`
- `error`: `{type:"error", message:"..."}`

Client sends no messages required (subscribe-only). Connection closes on disconnect; server may close on container errors.
