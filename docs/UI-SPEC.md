# UI Specification

## Header
- **Container**: fixed at startup from `POMERIUM_CONTAINER` (default `pomerium`); shown as static label in header (no dropdown; selection endpoints deferred — see API.md "Future")
- **Follow/Pause**: toggle (default Follow on). Following pins the view to the live edge (newest rows); Pause disables autoscroll
- **Sort**: toggle between oldest-first (default, newest at bottom) and newest-first (newest at top). Follow pins to the live edge in either order
- **Jump to live**: jumps to the newest rows and re-enables Follow
- **Time range**: popup calendar picker (Kibana-style) with quick presets (Last 15 min / 1 hour / 24 hours / 7 days / Today) plus custom From/To calendar inputs. Applies an absolute range over entry timestamps (AND-combined with all other filters); button shows the active range or "All time". Start-after-end is rejected with an inline error. Ranges are absolute once applied (not sliding) and are not persisted across reloads
- **Clear**: clear current view buffer (client-side only)
- **Search**: full-text input + **Regex** toggle (debounced 150-250ms)
- **Level**: dropdown with `all`, `trace`, `debug`, `info`, `warn`/`warning`, `error`, `critical`/`fatal`/`panic`

## Quick Filters (prominent, priority)
- **Allow/Deny**: tri-state selector (`all`/`allow`/`deny`)
- **Allow/deny reason contains**: text/regex filter over `allow-why-true`, `allow-why-false`, `deny-why-true`, `deny-why-false`
- **User/Email**: contains filter over `user` and `email`
- **Path/Host**: contains filter over `path` and `host` (also matches `authority` as fallback)
- **Response-code**: exact match (e.g. `200`, `401`, `403`, `500`) or partial match

## Log Row (compact)
A static column header row (`Time | Level | Service | Decision | Code | User | Path | Method | Host | Req ID | Message`) sits above the list, sharing the row grid so columns align (scrollbar gutter reserved). It follows the same responsive rules as rows (service/user columns hide on narrow screens).
Each row displays (left-to-right): time + level (color-coded) + service + allow/deny badge + response-code + user/email + path + short message. Click row to expand full JSON view. 
- **Badges**: allow/deny shown with short reason when applicable
- **Truncation**: long messages truncated in compact view; full content visible in expanded JSON

## Columns (toggleable)
The grid is the union of known normalized fields across service types (`authorize`, `envoy`, unparsed/other) — one stable layout, not per-service layouts (which would break virtualization and column alignment). Rows render blanks for keys they lack: `envoy` rows show Method/Host/Code with empty User/Decision, `authorize` rows the reverse.
- Toggleable via the Columns menu; defaults: Time, Level, Service, Decision, Code, User, Path, Message on; Method, Host, Req ID off
- Visibility is independent of filtering (a hidden column still filters)
- Toggles + sort order persist in `localStorage` (best-effort; private mode falls back to defaults)

## Column filters
Every column is filterable (AND semantics with everything else): Level dropdown, Allow/Deny tri-state, Reason/User-Path-Host/Code quick filters, plus the "more filters" row — Service, Request ID (`request-id` + `check-request-id`), Method, Message, Time (substring over the timestamp, e.g. `12:20` or `2026-10-04`). Host/Authority is covered by the Path/Host filter.

## Expanded View (per row)- Pretty-printed JSON with collapsible fields (or simple scrollable block)
- Copy buttons for key fields: `request-id`, `check-request-id`, `user`, `email`, `path`, `host`, `authority`, `route-id`, `upstream-cluster`

## Footer
- Buffer size/count (e.g. `buffer: X / max Y`)
- Connection status: `connected`/`connecting`/`reconnecting`/`disconnected`/`error`
- Last timestamp seen (from logs or local time)
- Line count of visible/filtered set
