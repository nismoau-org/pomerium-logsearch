# UI Specification

## Header
- **Container**: fixed at startup from `POMERIUM_CONTAINER` (default `pomerium`); shown as static label in header (no dropdown; selection endpoints deferred — see API.md "Future")
- **Follow/Pause**: toggle (default Follow on). Following pins the view to the live edge (newest rows); Pause disables autoscroll. Any scroll away from the live edge — however small — auto-pauses (direction decides, not distance), so a held position is never dragged away by incoming batches; scrolling toward the edge stays live (click Follow or Jump to live to resume)
- **Sort**: toggle between oldest-first (default, newest at bottom) and newest-first (newest at top). Follow pins to the live edge in either order
- **Jump to live**: jumps to the newest rows and re-enables Follow; lit only while actually live (following at the edge), unlit whenever scrolled away/paused
- **Columns**: opens the column-visibility panel (same checkboxes as before, now in a popup)
- **Reset filters**: clears all column filters and the time range (global Search is separate)
- **Clear**: clear current view buffer (client-side only)
- **Search**: full-text input + **Regex** toggle (debounced 150-250ms). Cross-column by design — it stays in the toolbar while per-column filters move into the headers

## Column headers (click to filter)
Every column header is a button. There are no standalone filter boxes — only the cross-column Search stays in the toolbar. Filtered columns show the active value inline next to the title (`TITLE = value`, italic accent normal-case vs the muted uppercase label, ellipsis-truncated so narrow columns cost no extra width), plus an accent marker and a tooltip/aria summary of the full value.
- **Text columns** (Service, Code, User, IP, Path, Method, Host, Fwd For, Req ID, Message, plus any custom field): clicking swaps the label for an inline input in place, styled distinctly (italic, accent-colored, normal case vs the muted uppercase label). Typing applies live (debounced); Enter applies immediately, Escape/blur/outside-click commits. Works in narrow columns too (text scrolls inside the input).
- **Level**: dropdown popup, applies and dismisses on select
- **Decision**: popup with All/Allow/Deny tri-state (applies + dismisses) plus Reason-contains input (live)
- **Time**: popup with quick presets (Last 15 min / 1 hour / 24 hours / 7 days / Today) plus custom From/To calendar inputs with Apply/Clear. Applies an absolute range over entry timestamps; Start-after-end is rejected inline. Ranges are absolute once applied (not sliding) and are not persisted across reloads
- Choice controls apply-and-dismiss; text inputs apply-live. All predicates are AND-combined with each other and with Search

## Log Row (compact)
A static column header row (`Time | Level | Service | Decision | Code | User | IP | Path | Method | Host | Fwd For | User Agent | Req ID | Message`, plus any enabled custom columns) sits above the list, sharing the row grid so columns align (scrollbar gutter reserved). Rows never wrap: when the enabled columns overflow the viewport the list scrolls horizontally and the header strip follows via transform sync. It follows the same responsive rules as rows (service/user columns hide on narrow screens).
Each row displays (left-to-right): time + level (color-coded) + service + allow/deny badge + response-code + user/email + path + short message. Click row to expand full JSON view. 
- **Click-to-filter**: clicking a Req ID, IP, Host, Fwd For, or User Agent cell isolates that value (click again to clear); the column auto-enables so the filter stays visible in its header. Text selection is unaffected (selecting to copy never filters).
- **Badges**: allow/deny shown with short reason when applicable
- **Truncation**: long messages truncated in compact view; full content visible in expanded JSON

## Columns (toggleable, resizable, extensible)
The grid is the union of known normalized fields across service types (`authorize`, `envoy`, unparsed/other) — one stable layout, not per-service layouts (which would break virtualization and column alignment). Rows render blanks for keys they lack: `envoy` rows show Method/Host/Code with empty User/Decision, `authorize` rows the reverse.
- Toggleable via the Columns menu, grouped per log type (Common, Authorize, Envoy, Custom fields, Discovered in logs); defaults: Time, Level, Service, Decision, Code, User, Path, Message on; Method, Host, Req ID, IP, Fwd For off
- Any scalar log attribute can become a column: the menu lists fields discovered in the buffer (with the service types carrying them) plus an add-by-name box; custom columns filter/sort/persist like built-ins and can be removed via ✕
- Resizable via the grip on each header's right edge (revealed on hover); widths apply to header and rows together, persist, never go below the header-text width, double-click resets
- Visibility is independent of filtering (a hidden column still filters)
- Toggles + widths + custom columns + sort order persist in `localStorage` (best-effort; private mode falls back to defaults)

## Column filters
Every column is filterable via its header popup (AND semantics with everything else): Level dropdown, Allow/Deny tri-state + reason, contains inputs for Service / Code / User / IP / Path / Method / Host / Fwd For / Req ID / Message and any custom-field column, absolute time-range picker. Host/Authority is covered by both the Path filter (path+host+authority) and the dedicated Host filter (host+authority).

## Expanded View (per row)
- Pretty-printed JSON with collapsible fields (or simple scrollable block)
- Copy buttons for key fields: `request-id`, `check-request-id`, `user`, `email`, `ip`, `forwarded-for`, `path`, `host`, `authority`, `route-id`, `upstream-cluster`

## Footer
- Buffer size/count (e.g. `buffer: X / max Y`)
- Connection status: `connected`/`connecting`/`reconnecting`/`disconnected`/`error`
- Last timestamp seen (from logs or local time)
- Line count of visible/filtered set
