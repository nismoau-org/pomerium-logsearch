# UI Specification

## Header
- **Container**: fixed to `pomerium` (no interleaving needed; dropdown reserved for future)
- **Follow/Pause**: toggle (default Follow on). Following auto-scrolls to newest; Pause disables autoscroll
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
Each row displays (left-to-right): time + level (color-coded) + service + allow/deny badge + response-code + user/email + path + short message. Click row to expand full JSON view. 
- **Badges**: allow/deny shown with short reason when applicable
- **Truncation**: long messages truncated in compact view; full content visible in expanded JSON

## Expanded View (per row)
- Pretty-printed JSON with collapsible fields (or simple scrollable block)
- Copy buttons for key fields: `request-id`, `check-request-id`, `user`, `email`, `path`, `host`, `authority`, `route-id`, `upstream-cluster`

## Footer
- Buffer size/count (e.g. `buffer: X / max Y`)
- Connection status: `connected`/`connecting`/`reconnecting`/`disconnected`/`error`
- Last timestamp seen (from logs or local time)
- Line count of visible/filtered set
