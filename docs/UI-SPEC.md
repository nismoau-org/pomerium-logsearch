# UI Specification

## Header
- **Container**: fixed at startup from `POMERIUM_CONTAINER` (default `pomerium`); shown as static label in header (no dropdown; selection endpoints deferred — see API.md "Future")
- **Follow/Pause**: toggle (default Follow on). Following pins the view to the live edge (newest rows); Pause disables autoscroll
- **Sort**: toggle between oldest-first (default, newest at bottom) and newest-first (newest at top). Follow pins to the live edge in either order
- **Jump to live**: jumps to the newest rows and re-enables Follow
- **Columns**: opens the column-visibility panel (same checkboxes as before, now in a popup)
- **Reset filters**: clears all column filters and the time range (global Search is separate)
- **Clear**: clear current view buffer (client-side only)
- **Search**: full-text input + **Regex** toggle (debounced 150-250ms). Cross-column by design — it stays in the toolbar while per-column filters move into the headers

## Column headers (click to filter)
Every column header is a button. Clicking one opens a popover anchored under it with that column's editor; there are no standalone filter boxes. Filtered columns show an accent marker plus a tooltip/aria summary of the active value.
- **Text columns** (Service, Code, User, Path, Method, Host, Req ID, Message): contains-input, applies live (debounced), Enter/Escape/outside-click dismisses, per-column Clear button
- **Level**: dropdown, applies and dismisses on select
- **Decision**: All/Allow/Deny tri-state (applies + dismisses) plus Reason-contains input (live)
- **Time**: quick presets (Last 15 min / 1 hour / 24 hours / 7 days / Today) plus custom From/To calendar inputs with Apply/Clear. Applies an absolute range over entry timestamps; Start-after-end is rejected inline. Ranges are absolute once applied (not sliding) and are not persisted across reloads
- Choice controls apply-and-dismiss; text inputs apply-live. All predicates are AND-combined with each other and with Search

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
Every column is filterable via its header popup (AND semantics with everything else): Level dropdown, Allow/Deny tri-state + reason, contains inputs for Service / Code / User / Path / Method / Host / Req ID / Message, absolute time-range picker. Host/Authority is covered by both the Path filter (path+host+authority) and the dedicated Host filter (host+authority).

## Expanded View (per row)
- Pretty-printed JSON with collapsible fields (or simple scrollable block)
- Copy buttons for key fields: `request-id`, `check-request-id`, `user`, `email`, `path`, `host`, `authority`, `route-id`, `upstream-cluster`

## Footer
- Buffer size/count (e.g. `buffer: X / max Y`)
- Connection status: `connected`/`connecting`/`reconnecting`/`disconnected`/`error`
- Last timestamp seen (from logs or local time)
- Line count of visible/filtered set
