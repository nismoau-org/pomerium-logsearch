# API Specification

MVP scope: minimal endpoints. Filtering/search is **client-side only** (browser filters the in-memory buffer) and the container is **fixed at startup** from `POMERIUM_CONTAINER` — no container selection endpoints.

## GET /
Serves embedded web UI (static files).

## GET /api/buffer
Returns the current in-memory buffer (raw lines). The client applies all filters/search (level, allow/deny, user/email, path/host, response-code, full-text/regex) locally.

**Query params** (pagination only):
- `limit` (int, default 1000): max lines to return
- `offset` (int, default 0): offset from newest (0 = newest first)

**Response**:
```json
{
  "total": 1234,
  "container": "pomerium",
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
WebSocket endpoint for live log streaming (the single container fixed at startup via `POMERIUM_CONTAINER`).

**Messages (server -> client)**:
- `log`: `{type:"log", line:{id, ts, raw, parsed}}`
- `status`: `{type:"status", state:"connected|connecting|reconnecting|disconnected|error", message:"..."}`
- `error`: `{type:"error", message:"..."}`

Client sends no messages required (subscribe-only). Connection closes on disconnect; server may close on container errors.

## Future (post-MVP, not implemented)
- `GET /api/containers` + `WS /ws?container=<name>` — container selection (dropdown in UI)
- Server-side filter params on `/api/buffer` (if buffers outgrow browser filtering)
