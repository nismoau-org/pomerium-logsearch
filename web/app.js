import { filterEntries, entryDecision, normalizeLevel } from "./filters.js";

const ROW_H = 28;
const DETAIL_H = 232;
const DETAIL_EXTRA = 9; // .detail vertical margins (2+6) + .row border-bottom (1); keep in sync with styles.css
const OVERSCAN = 10;
const CLIENT_CAP = 10000;
const DEBOUNCE_MS = 200;
const MAX_BACKOFF = 30000;

const COPY_FIELDS = [
  "request-id",
  "check-request-id",
  "user",
  "email",
  "ip",
  "forwarded-for",
  "path",
  "host",
  "authority",
  "route-id",
  "upstream-cluster",
];

// State: entries stored oldest -> newest for display.
let entries = [];
let idSet = new Set();
let visible = [];
let regexError = "";
let follow = true;
let sortOrder = "asc"; // 'asc' = oldest at top, newest at bottom; 'desc' = newest at top
let displayed = []; // visible rows in display order (visible, possibly reversed)
let expanded = new Set();
let total = 0;
let lastTs = "";
let connState = "connecting";
let ws = null;
let backoff = 1000;
let renderQueued = false;
let expandedVersion = 0; // bumped whenever `expanded` changes; part of the render cache key
let lastScrollTop = 0; // baseline for detecting a manual scroll away from the live edge
let lastStart = -1; // render cache: window + content signature of the last DOM build
let lastEnd = -1;
let lastSig = "";

const filters = { level: "all", decision: "all", reason: "", user: "", path: "", code: "",
  service: "", reqid: "", method: "", host: "", message: "", time: "", timeFrom: null, timeTo: null,
  ipScope: "all", fwdScope: "all" };
let search = "";
let isRegex = false;
const timeRange = { fromMs: null, toMs: null };

// Column registry: the grid is the union of known normalized fields across
// service types (authorize/envoy/other). Rows render blanks for keys they
// lack, so heterogeneous schemas share one stable layout. `on` is the
// default visibility (persisted); `kind` selects the header-popup editor:
// text (contains input), level (dropdown), decision (tri-state + reason),
// time (presets + calendar range), ip (contains input + public/private scope).
// `key` is the filters.js field;
// `fields` is the ordered parsed-key list a text column displays (first hit
// wins) — the filter itself matches `key` exactly via the generic
// matchFilters path. `group` buckets columns in the Columns dialog per log
// type: common | authorize | envoy | custom. Custom/discovered columns are
// appended at runtime with group "custom" (see addCustomColumn).
const COLUMNS = [
  { id: "time", label: "Time", cls: "c-time", on: true, kind: "time", group: "common" },
  { id: "level", label: "Level", cls: "c-level", on: true, kind: "level", group: "common" },
  { id: "service", label: "Service", cls: "c-svc", on: true, kind: "text", key: "service", fields: ["service", "svc"], group: "common", hint: "Contains match over service" },
  { id: "decision", label: "Decision", cls: "c-dec", on: true, kind: "decision", group: "common" },
  { id: "code", label: "Code", cls: "c-code", on: true, kind: "text", key: "code", fields: ["response-code", "status", "code", "statusCode"], group: "common", hint: "Contains match over response code" },
  { id: "user", label: "User", cls: "c-user", on: true, kind: "text", key: "user", fields: ["user", "email"], group: "authorize", hint: "Contains match over user and email" },
  { id: "ip", label: "IP", cls: "c-ip", on: false, kind: "ip", key: "ip", fields: ["ip"], scopeKey: "ipScope", group: "authorize", hint: "Contains match over client ip", clickFilter: true },
  { id: "path", label: "Path", cls: "c-path", on: true, kind: "text", key: "path", fields: ["path", "host", "authority"], group: "envoy", hint: "Contains match over path, host and authority" },
  { id: "method", label: "Method", cls: "c-method", on: false, kind: "text", key: "method", fields: ["method"], group: "envoy", hint: "Contains match over method" },
  { id: "host", label: "Host", cls: "c-host", on: false, kind: "text", key: "host", fields: ["host", "authority"], group: "envoy", hint: "Contains match over host and authority", clickFilter: true },
  { id: "fwdf", label: "Fwd For", cls: "c-fwd", on: false, kind: "ip", key: "forwarded-for", fields: ["forwarded-for", "x-forwarded-for"], scopeKey: "fwdScope", group: "envoy", hint: "Contains match over forwarded-for", clickFilter: true },
  { id: "ua", label: "User Agent", cls: "c-ua", on: false, kind: "text", key: "user-agent", fields: ["user-agent", "user_agent"], group: "envoy", hint: "Contains match over user-agent", clickFilter: true },
  { id: "reqid", label: "Req ID", cls: "c-reqid", on: false, kind: "text", key: "reqid", fields: ["request-id", "check-request-id"], group: "envoy", hint: "Contains match over request-id", clickFilter: true },
  { id: "message", label: "Message", cls: "c-msg", on: true, kind: "text", key: "message", fields: ["message", "msg", "error", "err"], group: "common", hint: "Contains match over message", rawFallback: true },
];

function colById(id) {
  return COLUMNS.find((c) => c.id === id);
}

function loadPrefs() {
  try {
    const customs = JSON.parse(localStorage.getItem("pls-custom-cols-v1") || "null");
    if (Array.isArray(customs)) {
      for (const d of customs) {
        if (d && typeof d.key === "string") addCustomColumn(d.key, d.on !== false, true);
      }
    }
    const cols = JSON.parse(localStorage.getItem("pls-cols-v1") || "null");
    if (cols && typeof cols === "object") {
      for (const c of COLUMNS) if (typeof cols[c.id] === "boolean") c.on = cols[c.id];
    }
    const widths = JSON.parse(localStorage.getItem("pls-colwidths-v1") || "null");
    if (widths && typeof widths === "object") {
      for (const [id, w] of Object.entries(widths)) {
        if (Number.isFinite(w) && w >= 40 && w <= 2000) colWidths[id] = Math.round(w);
      }
    }
    const s = localStorage.getItem("pls-sort-v1");
    if (s === "asc" || s === "desc") sortOrder = s;
  } catch { /* private mode etc: defaults stand */ }
}

function savePrefs() {
  try {
    const cols = {};
    for (const c of COLUMNS) cols[c.id] = c.on;
    localStorage.setItem("pls-cols-v1", JSON.stringify(cols));
    localStorage.setItem("pls-sort-v1", sortOrder);
    localStorage.setItem("pls-custom-cols-v1", JSON.stringify(
      COLUMNS.filter((c) => c.dynamic).map((c) => ({ key: c.key, on: c.on }))));
    localStorage.setItem("pls-colwidths-v1", JSON.stringify(colWidths));
  } catch { /* ignore */ }
}

function applyCols() {
  for (const c of COLUMNS) document.body.classList.toggle("hide-col-" + c.id, !c.on);
}

// Per-column widths (px), persisted. Applied as --cw-<id> custom properties
// consumed by the .c-* flex-basis rules, so headers and rows resize together
// with no re-render.
const colWidths = {};

function widthVar(id) {
  return `--cw-${id}`;
}

function applyWidths() {
  const root = document.documentElement.style;
  for (const c of COLUMNS) {
    if (colWidths[c.id]) root.setProperty(widthVar(c.id), colWidths[c.id] + "px");
    else root.removeProperty(widthVar(c.id));
  }
}

function resetColWidth(col) {
  delete colWidths[col.id];
  document.documentElement.style.removeProperty(widthVar(col.id));
  savePrefs();
}

// Visibility CSS is generated from the registry (single source): built-in
// columns keep their static rules in styles.css, dynamic ones get rules here.
// Dynamic columns also get their default flex-basis here.
let colStyleEl = null;
function ensureColStyle() {
  if (!colStyleEl) {
    colStyleEl = document.createElement("style");
    colStyleEl.id = "coldyn";
    document.head.appendChild(colStyleEl);
  }
  let css = "";
  for (const c of COLUMNS) {
    if (!c.dynamic) continue;
    css += `.hide-col-${c.id} .${c.cls}{display:none;}\n`;
    css += `.${c.cls}{flex:0 0 var(${widthVar(c.id)},140px);color:var(--muted);}\n`;
  }
  colStyleEl.textContent = css;
}

// ---------- custom / discovered columns ----------
// Any scalar parsed attribute can become a column. Discovery runs over buffered
// lines (full scan on load, incremental per line after) and feeds the Columns
// dialog; keys already covered by the registry (or internal/non-scalar) are
// skipped. colsVersion enters the render signature so grid changes rebuild.
let colsVersion = 0;
let indexedKeys = new Set();
const fieldSeen = new Map(); // key -> { count, services: Set }
const EXCLUDED_KEYS = new Set(["container", "time", "level", "decision"]);
// Keys with dedicated filter semantics (bespoke matchFilters branches):
// they already have columns/UI, so they can't become custom columns.
const RESERVED_FILTER_KEYS = new Set([
  "level", "decision", "reason", "time", "timeFrom", "timeTo",
]);

function reindexRegistry() {
  indexedKeys = new Set(EXCLUDED_KEYS);
  for (const c of COLUMNS) for (const k of c.fields || []) {
    indexedKeys.add(k);
    if (fieldSeen.has(k)) fieldSeen.delete(k);
  }
}

function serviceOf(parsed) {
  return str(parsed.service || parsed.svc || "other");
}

function isScalarCell(v) {
  return v == null || ["string", "number", "boolean"].includes(typeof v);
}

function noteField(k, v, svc) {
  if (typeof k !== "string" || k === "" || k[0] === "_" || indexedKeys.has(k)) return;
  let rec = fieldSeen.get(k);
  if (!rec) {
    if (!isScalarCell(v)) {
      indexedKeys.add(k); // remember the verdict: never column material
      return;
    }
    rec = { count: 0, services: new Set() };
    fieldSeen.set(k, rec);
  }
  rec.count++;
  if (svc) rec.services.add(svc);
}

// Feed one entry's parsed keys into field discovery (cheap: one Set lookup
// per key once indexed).
function noteEntryFields(e) {
  const p = (e && e.parsed) || {};
  const svc = serviceOf(p);
  for (const k of Object.keys(p)) noteField(k, p[k], svc);
}

// Discovered fields not yet columns, most frequent first (cap keeps the
// dialog neat on wild schemas).
function discoveredList(limit = 30) {
  return [...fieldSeen.entries()]
    .map(([key, rec]) => ({ key, count: rec.count, services: [...rec.services].sort() }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function slugOf(key) {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "field";
}

function addCustomColumn(rawKey, on = true, quiet = false) {
  const key = String(rawKey || "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) return null;
  // Keys with dedicated filter semantics already have their own columns/UI.
  if (RESERVED_FILTER_KEYS.has(key)) return null;
  const dup = COLUMNS.find((c) => c.kind === "text" && c.key === key);
  if (dup) {
    if (!quiet && dup.on !== !!on) {
      dup.on = !!on;
      afterColumnsChanged();
    }
    return dup;
  }
  const id = "f-" + slugOf(key);
  if (COLUMNS.some((c) => c.id === id)) return null;
  const col = {
    id, label: key, cls: "c-" + id, on: !!on, kind: "text",
    key, fields: [key], group: "custom", hint: `Contains match over ${key}`,
    dynamic: true,
  };
  COLUMNS.push(col);
  if (!quiet) afterColumnsChanged();
  return col;
}

function removeCustomColumn(id) {
  const i = COLUMNS.findIndex((c) => c.id === id && c.dynamic);
  if (i < 0) return;
  const [col] = COLUMNS.splice(i, 1);
  delete filters[col.key];
  delete colWidths[col.id];
  document.documentElement.style.removeProperty(widthVar(col.id));
  afterColumnsChanged();
  recomputeNow(false);
}

function afterColumnsChanged() {
  colsVersion++;
  reindexRegistry();
  ensureColStyle();
  applyCols();
  savePrefs();
  rebuildHeaders();
  queueRender(false);
  refreshColumnsDialog();
}

function rebuildHeaders() {
  commitInlineEdit();
  initHeaders();
  applyCols();
  updateHeaderStates();
}

function refreshColumnsDialog() {
  if (popId === "columns" && !els.colPop.hidden) {
    els.colPop.textContent = "";
    els.colPop.appendChild(buildColumnsEditor());
  }
}

// ---------- shared column popover ----------
 // One popover, content rebuilt per column (or the Columns panel). Choice
// controls (selects, tri-state, presets, Apply) apply AND close; text inputs
// apply live (debounced) and close on Enter/Escape/outside-click. Filtered
// columns carry .col-filtered + a tooltip summary (see updateHeaderStates).
let popId = null; // open column id, or "columns"

function headBtn(id) {
  return els.colheader.querySelector(`[data-col="${id}"]`);
}

function columnActive(col) {
  switch (col.kind) {
    case "text": return !!filters[col.key];
    case "ip": return !!filters[col.key] || (filters[col.scopeKey] || "all") !== "all";
    case "level": return filters.level !== "all";
    case "decision": return filters.decision !== "all" || !!filters.reason;
    case "time": return timeRange.fromMs != null || timeRange.toMs != null;
    default: return false;
  }
}

function columnSummary(col) {
  switch (col.kind) {
    case "text": {
      const v = String(filters[col.key] || "");
      return v.length > 40 ? v.slice(0, 39) + "…" : v;
    }
    case "ip": {
      const parts = [];
      const scope = filters[col.scopeKey] || "all";
      if (scope === "public") parts.push("public");
      else if (scope === "private") parts.push("private");
      const v = String(filters[col.key] || "");
      if (v) parts.push(v.length > 40 ? v.slice(0, 39) + "…" : v);
      return parts.join(", ");
    }
    case "level": return filters.level === "all" ? "" : filters.level;
    case "decision": {
      const parts = [];
      if (filters.decision !== "all") parts.push(filters.decision);
      if (filters.reason) parts.push(`reason: ${filters.reason}`);
      return parts.join(", ");
    }
    case "time": {
      const { fromMs, toMs } = timeRange;
      if (fromMs == null && toMs == null) return "";
      if (fromMs != null && toMs != null) return `${fmtRangeShort(fromMs)} → ${fmtRangeShort(toMs)}`;
      if (fromMs != null) return `≥ ${fmtRangeShort(fromMs)}`;
      return `≤ ${fmtRangeShort(toMs)}`;
    }
    default: return "";
  }
}

function updateHeaderStates() {
  for (const col of COLUMNS) {
    const btn = headBtn(col.id);
    if (!btn) continue;
    const active = columnActive(col);
    btn.classList.toggle("col-filtered", active);
    const summary = columnSummary(col);
    const base = `${col.label} — click to filter`;
    btn.title = active ? `${col.label} — filter: ${summary} (click to edit)` : base;
    btn.setAttribute("aria-label", active ? `${col.label}, filter active: ${summary}` : base);
    // Inline filter readout: sleek text alongside the title (hidden when
    // inactive or while inline-editing). Truncated via CSS ellipsis so narrow
    // columns cost no extra screen real estate.
    const fEl = btn.querySelector(".colhead-filter");
    if (fEl) {
      const editing = btn.classList.contains("editing");
      fEl.hidden = !active || editing;
      fEl.textContent = !active || editing ? "" : summary;
    }
    // Keep the inline input in sync when it isn't being typed in (e.g. after
    // Reset filters clears the state while the input still holds stale text).
    const inp = btn.querySelector(".colhead-input");
    const focused = typeof document !== "undefined" ? document.activeElement : null;
    if (inp && focused !== inp) {
      const cur = col.kind === "text" ? String(filters[col.key] || "") : "";
      if (inp.value !== cur) inp.value = cur;
    }
  }
}

function closePop() {
  els.colPop.hidden = true;
  popId = null;
  els.colsBtn.setAttribute("aria-expanded", "false");
  for (const col of COLUMNS) {
    const btn = headBtn(col.id);
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
}

function placePop(anchor) {
  const r = anchor.getBoundingClientRect();
  const pop = els.colPop;
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 280)) + "px";
  pop.style.top = Math.min(r.bottom + 6, window.innerHeight - 120) + "px";
}

function openPop(id, anchor, build) {
  const pop = els.colPop;
  pop.textContent = "";
  pop.appendChild(build());
  pop.hidden = false;
  popId = id;
  placePop(anchor);
  els.colsBtn.setAttribute("aria-expanded", id === "columns" ? "true" : "false");
  for (const col of COLUMNS) {
    const btn = headBtn(col.id);
    if (btn) btn.setAttribute("aria-expanded", col.id === id ? "true" : "false");
  }
  const first = pop.querySelector("input, select, button");
  if (first) first.focus();
}

function popTitle(text) {
  const h = document.createElement("div");
  h.className = "pop-title";
  h.textContent = text;
  return h;
}

function popError() {
  const d = document.createElement("div");
  d.className = "regex-error";
  d.setAttribute("role", "alert");
  d.hidden = true;
  return d;
}

function setPopError(box, msg) {
  if (msg) {
    box.hidden = false;
    box.textContent = msg;
  } else {
    box.hidden = true;
    box.textContent = "";
  }
}

function popActions(clearFn) {
  const bar = document.createElement("div");
  bar.className = "pop-actions";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn";
  clear.textContent = "Clear";
  clear.addEventListener("click", () => {
    clearFn();
    refreshAndClose(false);
  });
  bar.appendChild(clear);
  return bar;
}

// Recompute + refresh header markers; text inputs call this live (debounced
// recompute), choice controls call refreshAndClose (apply + dismiss).
function refreshAndClose(close) {
  updateHeaderStates();
  updateFooter();
  if (close) closePop();
  recompute();
}

function buildLevelEditor(col) {
  const wrap = document.createElement("div");
  wrap.style.display = "contents";
  wrap.appendChild(popTitle("Filter Level"));
  const lab = document.createElement("label");
  lab.className = "pop-field";
  lab.appendChild(document.createTextNode("Level"));
  const sel = document.createElement("select");
  for (const [v, t] of [["all", "all levels"], ["trace", "trace"], ["debug", "debug"],
      ["info", "info"], ["warn", "warn"], ["error", "error"], ["critical", "critical"]]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    if (filters.level === v) o.selected = true;
    sel.appendChild(o);
  }
  sel.setAttribute("aria-label", "Level filter");
  sel.addEventListener("change", () => {
    filters.level = sel.value;
    refreshAndClose(true);
  });
  lab.appendChild(sel);
  wrap.appendChild(lab);
  return wrap;
}

function buildDecisionEditor(col) {
  const wrap = document.createElement("div");
  wrap.style.display = "contents";
  wrap.appendChild(popTitle("Filter Decision"));
  const seg = document.createElement("div");
  seg.className = "seg";
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Allow or deny");
  for (const [v, t] of [["all", "All"], ["allow", "Allow"], ["deny", "Deny"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "seg-btn" + (filters.decision === v ? " active" : "");
    b.textContent = t;
    b.setAttribute("aria-pressed", filters.decision === v ? "true" : "false");
    b.addEventListener("click", () => {
      filters.decision = v;
      refreshAndClose(true);
    });
    seg.appendChild(b);
  }
  wrap.appendChild(seg);
  const lab = document.createElement("label");
  lab.className = "pop-field";
  lab.appendChild(document.createTextNode("Reason contains (any of the 4 reason fields)"));
  const input = document.createElement("input");
  input.type = "text";
  input.value = filters.reason || "";
  input.placeholder = "Reason contains…";
  input.setAttribute("aria-label", "Reason filter");
  input.addEventListener("input", () => {
    filters.reason = input.value;
    refreshAndClose(false);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") refreshAndClose(true);
  });
  lab.appendChild(input);
  wrap.appendChild(lab);
  wrap.appendChild(popActions(() => { filters.decision = "all"; filters.reason = ""; }));
  return wrap;
}

function buildIpEditor(col) {
  const wrap = document.createElement("div");
  wrap.style.display = "contents";
  wrap.appendChild(popTitle(`Filter ${col.label}`));
  const scopeKey = col.scopeKey;
  const cur = filters[scopeKey] || "all";
  const seg = document.createElement("div");
  seg.className = "seg";
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", `${col.label} address scope`);
  for (const [v, t, hint] of [["all", "All", "All addresses"],
      ["public", "Public", "Globally routable addresses only"],
      ["private", "Private", "Private (RFC1918) addresses only"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "seg-btn" + (cur === v ? " active" : "");
    b.textContent = t;
    b.title = hint;
    b.setAttribute("aria-pressed", cur === v ? "true" : "false");
    b.addEventListener("click", () => {
      filters[scopeKey] = v;
      refreshAndClose(true);
    });
    seg.appendChild(b);
  }
  wrap.appendChild(seg);
  const lab = document.createElement("label");
  lab.className = "pop-field";
  lab.appendChild(document.createTextNode(`${col.label} contains`));
  const input = document.createElement("input");
  input.type = "text";
  input.value = filters[col.key] || "";
  input.placeholder = `${col.label} contains…`;
  input.setAttribute("aria-label", `${col.label} filter`);
  input.addEventListener("input", () => {
    filters[col.key] = input.value;
    refreshAndClose(false);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") refreshAndClose(true);
  });
  lab.appendChild(input);
  wrap.appendChild(lab);
  const hint = document.createElement("div");
  hint.className = "col-hint";
  hint.textContent = "Public excludes private, loopback, link-local, multicast and reserved ranges.";
  wrap.appendChild(hint);
  wrap.appendChild(popActions(() => { filters[scopeKey] = "all"; filters[col.key] = ""; }));
  return wrap;
}

function buildTimeEditor() {
  const wrap = document.createElement("div");
  wrap.style.display = "contents";
  wrap.appendChild(popTitle("Filter Time (absolute range)"));
  const presets = document.createElement("div");
  presets.className = "time-presets";
  presets.setAttribute("role", "group");
  presets.setAttribute("aria-label", "Quick ranges");
  for (const [v, t] of [["15m", "Last 15 min"], ["1h", "Last 1 hour"], ["24h", "Last 24 hours"],
      ["7d", "Last 7 days"], ["today", "Today"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.range = v;
    b.textContent = t;
    b.addEventListener("click", () => applyPreset(v));
    presets.appendChild(b);
  }
  wrap.appendChild(presets);
  const custom = document.createElement("div");
  custom.className = "time-custom";
  const fromLab = document.createElement("label");
  fromLab.appendChild(document.createTextNode("From "));
  const from = document.createElement("input");
  from.type = "datetime-local";
  from.className = "time-from";
  from.setAttribute("aria-label", "Range start");
  from.value = timeRange.fromMs == null ? "" : toLocalInputValue(timeRange.fromMs);
  fromLab.appendChild(from);
  const toLab = document.createElement("label");
  toLab.appendChild(document.createTextNode("To "));
  const to = document.createElement("input");
  to.type = "datetime-local";
  to.className = "time-to";
  to.setAttribute("aria-label", "Range end");
  to.value = timeRange.toMs == null ? "" : toLocalInputValue(timeRange.toMs);
  toLab.appendChild(to);
  custom.appendChild(fromLab);
  custom.appendChild(toLab);
  wrap.appendChild(custom);
  const err = popError();
  wrap.appendChild(err);
  const bar = document.createElement("div");
  bar.className = "time-actions";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "btn primary";
  apply.textContent = "Apply";
  apply.addEventListener("click", () => {
    const f = from.value ? new Date(from.value).getTime() : null;
    const t = to.value ? new Date(to.value).getTime() : null;
    const fromMs = f != null && !Number.isNaN(f) ? f : null;
    const toMs = t != null && !Number.isNaN(t) ? t : null;
    if (fromMs != null && toMs != null && fromMs > toMs) {
      setPopError(err, "Start must be before end.");
      return;
    }
    applyTimeRange(fromMs, toMs);
  });
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn";
  clear.textContent = "Clear";
  clear.addEventListener("click", () => applyTimeRange(null, null));
  bar.appendChild(apply);
  bar.appendChild(clear);
  wrap.appendChild(bar);
  return wrap;
}

function colGroupTitle(text) {
  const h = document.createElement("div");
  h.className = "colgroup";
  h.textContent = text;
  return h;
}

function colToggleRow(c) {
  const row = document.createElement("div");
  row.className = "col-row";
  const lab = document.createElement("label");
  lab.className = "col-toggle";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = c.on;
  cb.setAttribute("aria-label", "Show " + c.label + " column");
  cb.addEventListener("change", () => {
    c.on = cb.checked;
    applyCols();
    savePrefs();
    queueRender(false);
  });
  lab.appendChild(cb);
  lab.appendChild(document.createTextNode(" " + c.label));
  row.appendChild(lab);
  if (c.dynamic) {
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "col-remove";
    rm.textContent = "✕";
    rm.title = `Remove ${c.key} column`;
    rm.setAttribute("aria-label", `Remove ${c.key} column`);
    rm.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeCustomColumn(c.id);
    });
    row.appendChild(rm);
  }
  return row;
}

function buildColumnsEditor() {
  const wrap = document.createElement("div");
  wrap.style.display = "contents";
  wrap.appendChild(popTitle("Show columns"));
  for (const [group, title] of [["common", "Common"], ["authorize", "Authorize"],
      ["envoy", "Envoy"], ["custom", "Custom fields"]]) {
    const cols = COLUMNS.filter((c) => (c.group || "common") === group);
    if (group !== "custom" && cols.length === 0) continue;
    wrap.appendChild(colGroupTitle(title));
    for (const c of cols) wrap.appendChild(colToggleRow(c));
    if (group === "custom") {
      if (cols.length === 0) {
        const hint = document.createElement("div");
        hint.className = "col-hint";
        hint.textContent = "No custom fields yet — enable a discovered field below or add one by name.";
        wrap.appendChild(hint);
      }
      const add = document.createElement("div");
      add.className = "col-add";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "col-add-input";
      input.placeholder = "Add field, e.g. trace-id…";
      input.setAttribute("aria-label", "Add a custom column by field name");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      btn.textContent = "Add";
      const submit = () => {
        const col = addCustomColumn(input.value, true);
        if (col) input.value = "";
        else {
          input.classList.add("invalid");
          setTimeout(() => input.classList.remove("invalid"), 1200);
        }
      };
      btn.addEventListener("click", submit);
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") submit();
      });
      input.addEventListener("click", (ev) => ev.stopPropagation());
      add.appendChild(input);
      add.appendChild(btn);
      wrap.appendChild(add);
    }
  }
  const disc = discoveredList();
  if (disc.length > 0) {
    wrap.appendChild(colGroupTitle("Discovered in logs"));
    for (const d of disc) {
      const row = document.createElement("div");
      row.className = "col-row";
      const lab = document.createElement("label");
      lab.className = "col-toggle";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = false;
      cb.setAttribute("aria-label", "Add " + d.key + " column");
      cb.addEventListener("change", () => {
        if (cb.checked) addCustomColumn(d.key, true);
      });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(" " + d.key));
      const svc = document.createElement("span");
      svc.className = "muted";
      svc.textContent = " · " + d.services.slice(0, 2).join(", ") +
        (d.services.length > 2 ? ` +${d.services.length - 2}` : "");
      lab.appendChild(svc);
      row.appendChild(lab);
      wrap.appendChild(row);
    }
  }
  return wrap;
}

function openColumnPop(col, anchor) {
  const builders = { level: buildLevelEditor, decision: buildDecisionEditor, time: () => buildTimeEditor(), ip: buildIpEditor };
  const build = builders[col.kind];
  if (!build) return;
  if (popId === col.id && !els.colPop.hidden) {
    closePop();
    return;
  }
  openPop(col.id, anchor, () => build(col));
}

// Inline header editing for text columns: clicking the header swaps the
// label for an input in place (distinctly styled — see .colhead-input).
// Typing applies live; Enter applies immediately, Escape/blur/outside-click
// commits whatever is typed. Rich editors (level/decision/time/ip) stay popups.
function onHeadClick(col, btn) {
  if (col.kind === "text") {
    if (btn.classList.contains("editing")) commitInlineEdit(true);
    else startInlineEdit(col, btn);
    return;
  }
  if (col.kind === "ip") {
    openColumnPop(col, btn);
    return;
  }
  openColumnPop(col, btn);
}

function startInlineEdit(col, btn) {
  commitInlineEdit();
  closePop();
  btn.classList.add("editing");
  const input = btn.querySelector(".colhead-input");
  if (!input) return;
  input.hidden = false;
  input.focus();
  input.select();
  updateHeaderStates();
}

function commitInlineEdit(applyNow = false) {
  const btn = els.colheader.querySelector(".colhead.editing");
  if (!btn) return;
  const input = btn.querySelector(".colhead-input");
  if (input) input.hidden = true;
  btn.classList.remove("editing");
  updateHeaderStates();
  if (applyNow) recomputeNow(false);
}

function initHeaders() {
  const wrap = els.colheaderIn;
  wrap.textContent = "";
  for (const col of COLUMNS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `colhead ${col.cls}`;
    b.dataset.col = col.id;
    b.setAttribute("aria-haspopup", "dialog");
    const lab = document.createElement("span");
    lab.className = "colhead-label";
    lab.textContent = col.label;
    b.appendChild(lab);
    // Filter readout shown alongside the title when this column is filtered
    // (populated in updateHeaderStates; hidden otherwise). aria-hidden since
    // the button's aria-label already announces the active filter.
    const filt = document.createElement("span");
    filt.className = "colhead-filter";
    filt.hidden = true;
    filt.setAttribute("aria-hidden", "true");
    b.appendChild(filt);
    if (col.kind === "text") {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "colhead-input";
      inp.hidden = true;
      inp.setAttribute("aria-label", `${col.label} filter`);
      inp.placeholder = "filter…";
      if (col.hint) inp.title = col.hint;
      inp.addEventListener("input", () => {
        filters[col.key] = inp.value;
        refreshAndClose(false);
      });
      inp.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === "Escape") {
          ev.stopPropagation();
          commitInlineEdit(ev.key === "Enter");
        }
      });
      inp.addEventListener("blur", () => commitInlineEdit());
      inp.addEventListener("click", (ev) => ev.stopPropagation());
      b.appendChild(inp);
    }
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onHeadClick(col, b);
    });
    // Resize grip: drag the right edge to set this column's width (shared by
    // the header and every row via a --cw-<id> custom property, persisted).
    // Plain clicks on the grip do nothing (they must not open the filter).
    const grip = document.createElement("span");
    grip.className = "col-resize";
    grip.title = "Drag to resize (double-click to reset)";
    grip.setAttribute("aria-hidden", "true");
    grip.addEventListener("pointerdown", (ev) => startResize(ev, col, b));
    grip.addEventListener("click", (ev) => ev.stopPropagation());
    grip.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      resetColWidth(col);
    });
    b.appendChild(grip);
    wrap.appendChild(b);
  }
}

// Drag-to-resize: live-update --cw-<id> from pointer dx, clamped to the
// header-text width at the bottom (per request: never narrower than the
// label) and 1200px at the top. Saved on release.
let resizing = null;
function startResize(ev, col, btn) {
  ev.stopPropagation();
  ev.preventDefault();
  const lab = btn.querySelector(".colhead-label");
  const minW = Math.ceil(lab ? lab.scrollWidth : 40) + 12;
  const startX = ev.clientX;
  const startW = btn.getBoundingClientRect().width || minW;
  resizing = { col, minW, startX, startW, w: null };
  document.body.classList.add("resizing");
  const move = (e) => {
    if (!resizing) return;
    const w = Math.min(1200, Math.max(resizing.minW, resizing.startW + (e.clientX - resizing.startX)));
    document.documentElement.style.setProperty(widthVar(resizing.col.id), Math.round(w) + "px");
    resizing.w = Math.round(w);
  };
  const done = () => {
    document.body.classList.remove("resizing");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", done);
    window.removeEventListener("pointercancel", done);
    if (resizing && resizing.w != null && Math.abs(resizing.w - resizing.startW) > 2) {
      colWidths[resizing.col.id] = resizing.w;
      savePrefs();
    }
    resizing = null;
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", done);
  window.addEventListener("pointercancel", done);
  try {
    if (ev.target && ev.target.setPointerCapture && ev.pointerId !== undefined) {
      ev.target.setPointerCapture(ev.pointerId);
    }
  } catch { /* mouse/older browsers: window listeners still track */ }
}

const $ = (id) => document.getElementById(id);
const els = {};
for (const id of [
  "containerLabel", "followBtn", "clearBtn", "sortBtn", "liveBtn", "colsBtn",
  "resetFiltersBtn", "searchInput", "regexToggle",
  "regexError", "colheader", "colheaderIn", "colPop", "loglist", "logtop", "logrows",
  "logbottom", "emptyState", "bufferCount", "connPill", "lastTs", "visibleCount",
]) {
  els[id] = $(id);
}

function str(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

// fieldText renders the first non-empty parsed key: object-safe, so
// non-scalar values (possible in dynamic columns) render as compact JSON
// instead of "[object Object]".
function fieldText(parsed, keys) {
  for (const k of keys || []) {
    const v = parsed[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "object") return compactJson(v);
    return str(v);
  }
  return "";
}

function compactJson(v) {
  try {
    const s = JSON.stringify(v) ?? "";
    return s.length > 200 ? s.slice(0, 199) + "…" : s;
  } catch {
    return str(v);
  }
}

function levelClass(level) {
  const n = normalizeLevel(level);
  if (n === "warn") return "lvl-warn";
  if (n === "error") return "lvl-error";
  if (n === "debug") return "lvl-debug";
  if (n === "trace") return "lvl-trace";
  if (n === "info") return "lvl-info";
  if (["critical", "fatal", "panic"].includes(n)) return "lvl-critical";
  return "lvl-other";
}

function fmtTime(e) {
  const p = e.parsed || {};
  const t = str(p.time || e.ts || "");
  if (!t) return "";
  // Compact: HH:MM:SS(.mmm) from ISO, fallback to raw tail.
  const m = t.match(/T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  if (m) return m[1].slice(0, 12);
  return t.slice(-12);
}

function shortReason(parsed) {
  for (const k of ["allow-why-true", "allow-why-false", "deny-why-true", "deny-why-false"]) {
    const v = str(parsed[k]);
    if (v) return v.length > 48 ? v.slice(0, 47) + "…" : v;
  }
  return "";
}

// ---------- filter + render pipeline ----------

function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function applySort() {
  displayed = sortOrder === "asc" ? visible : [...visible].reverse();
}

const recompute = debounce(() => {
  const r = filterEntries(entries, filters, search, isRegex);
  visible = r.visible;
  applySort();
  regexError = r.regexError || "";
  updateRegexError();
  updateHeaderStates();
  updateFooter();
  queueRender(true);
}, DEBOUNCE_MS);

function recomputeNow(stick = false) {
  const r = filterEntries(entries, filters, search, isRegex);
  visible = r.visible;
  applySort();
  regexError = r.regexError || "";
  updateRegexError();
  updateHeaderStates();
  updateFooter();
  queueRender(stick);
}

function updateRegexError() {
  if (regexError) {
    els.regexError.hidden = false;
    els.regexError.textContent = "Invalid regex: " + regexError;
    els.searchInput.classList.add("invalid");
  } else {
    els.regexError.hidden = true;
    els.regexError.textContent = "";
    els.searchInput.classList.remove("invalid");
  }
}

function rowHeight(e) {
  return expanded.has(e.id) ? ROW_H + DETAIL_H + DETAIL_EXTRA : ROW_H;
}

function queueRender(stick = false) {
  if (renderQueued) {
    if (stick) renderQueued = "stick";
    return;
  }
  renderQueued = stick ? "stick" : true;
  requestAnimationFrame(() => {
    const s = renderQueued;
    renderQueued = false;
    render(s === "stick");
  });
}

// The "live edge" is where the newest rows sit: bottom in asc order,
// top in desc order. Follow mode pins the view there. nearLiveEdge's 4-row
// zone keeps tailing stable across render timing; atLiveEdge's 2px epsilon
// is the pause decision (see the scroll handler): anything beyond it is an
// intentional move that must hold its position.
const EDGE_EPS = 2;
function nearLiveEdge() {
  const el = els.loglist;
  if (sortOrder === "desc") return el.scrollTop < ROW_H * 4;
  return el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 4;
}

function atLiveEdge() {
  const el = els.loglist;
  if (sortOrder === "desc") return el.scrollTop <= EDGE_EPS;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= EDGE_EPS;
}

function scrollToLive() {
  if (sortOrder === "desc") els.loglist.scrollTop = 0;
  else els.loglist.scrollTop = els.loglist.scrollHeight;
}

function render(stick = false) {
  const scrollTop = els.loglist.scrollTop;
  const viewH = els.loglist.clientHeight || 600;

  // Find start index by cumulative height.
  let acc = 0;
  let start = 0;
  for (let i = 0; i < displayed.length; i++) {
    const h = rowHeight(displayed[i]);
    if (acc + h < scrollTop - OVERSCAN * ROW_H) {
      acc += h;
      start = i + 1;
    } else break;
  }
  let topH = 0;
  for (let i = 0; i < start; i++) topH += rowHeight(displayed[i]);

  let end = start;
  let winH = 0;
  const budget = viewH + OVERSCAN * 2 * ROW_H;
  while (end < displayed.length && winH < budget) {
    winH += rowHeight(displayed[end]);
    end++;
  }
  let bottomH = 0;
  for (let i = end; i < displayed.length; i++) bottomH += rowHeight(displayed[i]);

  els.logtop.style.height = topH + "px";
  els.logbottom.style.height = bottomH + "px";
  els.emptyState.hidden = displayed.length !== 0;

  // The header sits outside the scroll container (so virtualization math is
  // untouched); shift its inner strip to follow horizontal scrolling.
  els.colheaderIn.style.transform = `translateX(${-els.loglist.scrollLeft}px)`;

  // Skip the DOM rebuild when neither the window nor the content changed
  // (e.g. slow scrolling inside the current overscan window): tearing down
  // and rebuilding ~40 rows per scroll frame is what made precise scrolling
  // feel sticky. Spacers/empty-state/transform above are already in place.
  const sig = displayed.length + "|" +
    (displayed.length ? displayed[0].id + "|" + displayed[displayed.length - 1].id : "") +
    "|" + sortOrder + "|exp" + expandedVersion + "|cols" + colsVersion;
  const pin = (stick || (follow && nearLiveEdge())) && follow;
  if (start === lastStart && end === lastEnd && sig === lastSig) {
    if (pin) scrollToLive();
    return;
  }
  lastStart = start;
  lastEnd = end;
  lastSig = sig;

  // Rebuild window rows.
  els.logrows.textContent = "";
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) frag.appendChild(buildRow(displayed[i]));
  els.logrows.appendChild(frag);

  if (pin) {
    scrollToLive();
  }
}

function badge(text, cls) {
  const s = document.createElement("span");
  s.className = "badge " + cls;
  s.textContent = text;
  return s;
}

function cell(text, cls) {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  s.title = text;
  return s;
}

function buildRow(e) {
  const p = e.parsed || {};
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.id = e.id;
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.setAttribute("aria-expanded", expanded.has(e.id) ? "true" : "false");

  // Cells live in an inner no-wrap line so overflowing grids scroll
  // horizontally instead of wrapping (wrap + fixed row height clipped cells).
  const line = document.createElement("div");
  line.className = "rowline";
  row.appendChild(line);

  // Cells follow the column registry in order (visibility is CSS-driven, so
  // every cell always renders and toggling never needs a rebuild).
  for (const col of COLUMNS) {
    if (col.kind === "time") {
      line.appendChild(cell(fmtTime(e), col.cls));
    } else if (col.kind === "level") {
      const lvl = str(p.level || "");
      const lb = badge(lvl ? normalizeLevel(lvl) || lvl : "?", levelClass(lvl));
      lb.classList.add(col.cls);
      line.appendChild(lb);
    } else if (col.kind === "decision") {
      const dec = entryDecision(p);
      if (dec === "allow") {
        const b = badge(shortReason(p) ? "allow · " + shortReason(p) : "allow", "allow");
        b.classList.add(col.cls);
        line.appendChild(b);
      } else if (dec === "deny") {
        const b = badge(shortReason(p) ? "deny · " + shortReason(p) : "deny", "deny");
        b.classList.add(col.cls);
        line.appendChild(b);
      } else {
        line.appendChild(cell("", col.cls));
      }
    } else {
      // Generic field column (curated text columns and dynamic ones alike):
      // first non-empty parsed key wins; message falls back to the raw line.
      let v = fieldText(p, col.fields || []);
      if (!v && col.rawFallback) v = e.raw.slice(0, 200);
      const cellEl = cell(v, col.cls);
      if (col.clickFilter && v) {
        // Click-to-filter: clicking the cell filters the view to its value
        // (click again to clear) instead of expanding the row.
        cellEl.classList.add("cell-filterable");
        cellEl.title = `Filter ${col.label} by this value (click again to clear)`;
        cellEl.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const sel = typeof window.getSelection === "function"
            ? window.getSelection().toString()
            : "";
          if (sel) return; // selecting text to copy must not filter
          filterByColumn(col, v);
        });
      }
      line.appendChild(cellEl);
    }
  }

  row.addEventListener("click", (ev) => {
    if (ev.target.closest("button")) return;
    toggleExpand(e.id);
  });
  row.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      toggleExpand(e.id);
    }
  });

  if (expanded.has(e.id)) row.appendChild(buildDetail(e));
  return row;
}

function prettyRaw(e) {
  try {
    return JSON.stringify(JSON.parse(e.raw), null, 2);
  } catch {
    return e.raw;
  }
}

function buildDetail(e) {
  const p = e.parsed || {};
  const d = document.createElement("div");
  d.className = "detail";
  d.addEventListener("click", (ev) => ev.stopPropagation());

  const bar = document.createElement("div");
  bar.className = "copybar";
  for (const k of COPY_FIELDS) {
    const v = str(p[k]);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "copy-btn";
    b.textContent = "⧉ " + k;
    b.title = v ? v : k + " (absent)";
    b.disabled = !v;
    if (v) {
      b.addEventListener("click", () => copyText(v, b));
    }
    bar.appendChild(b);
  }
  d.appendChild(bar);

  const pre = document.createElement("pre");
  pre.textContent = prettyRaw(e);
  d.appendChild(pre);
  return d;
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    window.prompt("Copy value:", text);
    return;
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = "✓ copied";
    setTimeout(() => { btn.textContent = old; }, 1200);
  }
}

function toggleExpand(id) {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  expandedVersion++;
  queueRender(false);
}

// ---------- data intake ----------

function addEntry(line) {
  if (!line || line.id === undefined) return;
  if (idSet.has(line.id)) return;
  idSet.add(line.id);
  entries.push({ id: line.id, ts: line.ts || "", raw: str(line.raw), parsed: line.parsed || {} });
  noteEntryFields(entries[entries.length - 1]);
  if (entries.length > CLIENT_CAP) {
    const drop = entries.length - CLIENT_CAP;
    for (let i = 0; i < drop; i++) idSet.delete(entries[i].id);
    entries.splice(0, drop);
    const before = expanded.size;
    for (const id of [...expanded]) if (!idSet.has(id)) expanded.delete(id);
    if (expanded.size !== before) expandedVersion++;
  }
  const t = str(line.ts || "");
  if (t && (!lastTs || t > lastTs)) lastTs = t;
}

function onNewLines() {
  // Live tail can burst (1000+ lines/s); use the debounced recompute path so
  // each WS message doesn't trigger a full synchronous refilter + render.
  // Debounced recompute still sticks (auto-scrolls) when following.
  recompute();
}

// ---------- footer / status ----------

const CONN_STATES = new Set(["connected", "connecting", "reconnecting", "disconnected", "error"]);

function setConn(state, message) {
  const safe = CONN_STATES.has(state) ? state : "error";
  connState = safe;
  els.connPill.textContent = message || safe;
  els.connPill.className = "pill " + safe;
}

function updateFooter() {
  els.bufferCount.textContent = "buffer: " + entries.length + " / " + Math.max(total, entries.length);
  els.visibleCount.textContent = "showing " + visible.length + " / " + entries.length;
  els.lastTs.textContent = "last: " + (lastTs || "—");
}

// ---------- init: buffer fetch + websocket ----------

async function loadBuffer() {
  try {
    const res = await fetch("/api/buffer?limit=1000");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    total = Number(data.total) || 0;
    if (data.container) els.containerLabel.textContent = str(data.container);
    const lines = Array.isArray(data.lines) ? data.lines : [];
    // API returns newest-first; reverse to oldest->newest for display.
    lines.reverse();
    for (const l of lines) addEntry(l);
  } catch (err) {
    setConn("error", "buffer load failed");
  }
  recomputeNow(true);
}

function wsURL() {
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  return proto + location.host + "/ws";
}

function connectWS() {
  setConn("connecting", "connecting");
  let s;
  try {
    s = new WebSocket(wsURL());
  } catch {
    scheduleReconnect();
    return;
  }
  ws = s;
  s.onopen = () => {
    backoff = 1000;
    if (connState !== "connected") setConn("connected", "connected");
  };
  s.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "log" && msg.line) {
      addEntry(msg.line);
      total = Math.max(total, entries.length);
      onNewLines();
    } else if (msg.type === "status") {
      setConn(msg.state || "connected", msg.state || "connected");
    } else if (msg.type === "error") {
      setConn("error", "error");
    }
  };
  s.onclose = () => scheduleReconnect();
  s.onerror = () => {
    try { s.close(); } catch { /* ignore */ }
  };
}

function scheduleReconnect() {
  setConn("reconnecting", "reconnecting");
  setTimeout(connectWS, backoff);
  backoff = Math.min(backoff * 2, MAX_BACKOFF);
}

// ---------- wire up controls ----------

function resetColumnFilters() {
  filters.level = "all";
  filters.decision = "all";
  filters.reason = "";
  for (const c of COLUMNS) if (c.key) filters[c.key] = "";
  filters.ipScope = "all";
  filters.fwdScope = "all";
  filters.time = "";
  filters.timeFrom = null;
  filters.timeTo = null;
  timeRange.fromMs = null;
  timeRange.toMs = null;
  updateHeaderStates();
  updateFooter();
  recomputeNow(false);
}

// Click-to-filter from a flagged cell (Req ID, IP, Host, Fwd For, User
// Agent): isolate that value (click again to clear). Auto-enables the column
// so the active filter stays visible in its header readout.
function filterByColumn(col, value) {
  if (!col || !col.key) return;
  if (!col.on) {
    col.on = true;
    applyCols();
    savePrefs();
  }
  filters[col.key] = filters[col.key] === value ? "" : value;
  updateHeaderStates();
  updateFooter();
  recomputeNow(false);
}

function setSort(v) {
  sortOrder = v;
  els.sortBtn.textContent = sortOrder === "asc" ? "Sort: oldest first" : "Sort: newest first";
  els.sortBtn.setAttribute("aria-pressed", sortOrder === "desc" ? "true" : "false");
  els.loglist.setAttribute("aria-label",
    sortOrder === "asc" ? "Log lines, newest at bottom" : "Log lines, newest at top");
  applySort();
  updateFooter();
  queueRender(false);
  updateLiveBtn();
}

function setFollow(v) {
  follow = v;
  els.followBtn.textContent = follow ? "Pause" : "Follow";
  els.followBtn.setAttribute("aria-pressed", follow ? "true" : "false");
  if (follow) scrollToLive();
  updateLiveBtn();
}

// Jump to live is lit only while actually live (following AND at the edge);
// scrolled-away/paused states leave it unlit as the visual cue.
function updateLiveBtn() {
  const live = follow && atLiveEdge();
  els.liveBtn.classList.toggle("live", live);
  els.liveBtn.setAttribute("aria-pressed", live ? "true" : "false");
}

// ---------- time-range popup (absolute range, Elasticsearch-style) ----------

function fmtRangeShort(ms) {
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function toLocalInputValue(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function applyTimeRange(fromMs, toMs) {
  timeRange.fromMs = fromMs;
  timeRange.toMs = toMs;
  filters.timeFrom = fromMs;
  filters.timeTo = toMs;
  refreshAndClose(true);
}

function applyPreset(range) {
  const now = Date.now();
  const MIN = 60000;
  switch (range) {
    case "15m": return applyTimeRange(now - 15 * MIN, now);
    case "1h": return applyTimeRange(now - 60 * MIN, now);
    case "24h": return applyTimeRange(now - 24 * 60 * MIN, now);
    case "7d": return applyTimeRange(now - 7 * 24 * 60 * MIN, now);
    case "today": {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return applyTimeRange(d.getTime(), now);
    }
    default: return;
  }
}

function initControls() {
  els.followBtn.addEventListener("click", () => setFollow(!follow));
  els.sortBtn.addEventListener("click", () => {
    setSort(sortOrder === "asc" ? "desc" : "asc");
    savePrefs();
  });
  els.liveBtn.addEventListener("click", () => {
    setFollow(true); // setFollow scrolls to the live edge when enabling
    scrollToLive();
  });
  els.clearBtn.addEventListener("click", () => {
    entries = [];
    idSet = new Set();
    expanded = new Set();
    recomputeNow(false);
  });
  els.colsBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (popId === "columns" && !els.colPop.hidden) {
      closePop();
      return;
    }
    openPop("columns", els.colsBtn, buildColumnsEditor);
  });
  els.resetFiltersBtn.addEventListener("click", () => {
    closePop();
    resetColumnFilters();
  });
  els.searchInput.addEventListener("input", () => {
    search = els.searchInput.value;
    recompute();
  });
  els.regexToggle.addEventListener("change", () => {
    isRegex = els.regexToggle.checked;
    recompute();
  });
  // Header buttons are wired at creation time in initHeaders() (single source;
  // a second querySelectorAll pass here would double-fire every click:
  // open-then-instant-toggle makes clicks look dead with zero errors).
  els.colPop.addEventListener("click", (ev) => ev.stopPropagation());
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".colheader-wrap") && ev.target !== els.colsBtn
        && !ev.target.closest("#colsBtn")) closePop();
    if (!ev.target.closest(".colhead.editing")) commitInlineEdit();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      closePop();
      commitInlineEdit();
    }
  });
  // Any manual scroll away from the live edge pauses follow, however small:
  // the movement's direction (not its distance) decides, so a 1px nudge
  // holds instead of being re-pinned. Programmatic pins always move toward
  // the edge so they never qualify; overshoot in either direction is
  // rubber-band bounce, not intent (wasOOB covers the settle-back event).
  // Click Follow / Jump to live to resume.
  els.loglist.addEventListener("scroll", () => {
    const el = els.loglist;
    const st = el.scrollTop;
    const delta = st - lastScrollTop;
    const max = el.scrollHeight - el.clientHeight;
    const wasOOB = lastScrollTop < 0 || lastScrollTop > max;
    lastScrollTop = st;
    if (delta === 0 || displayed.length === 0) {
      queueRender(false);
      updateLiveBtn();
      return;
    }
    if (st < 0 || st > max) {
      queueRender(false); // overscroll bounce, not a scroll position
      updateLiveBtn();
      return;
    }
    // Away from the live edge: up in asc (oldest-first), down in desc.
    // wasOOB exempts the settle-back event after rubber-band overshoot.
    if (follow && !wasOOB && (sortOrder === "asc" ? delta < 0 : delta > 0)) setFollow(false);
    queueRender(false);
    updateLiveBtn();
  }, { passive: true });
  window.addEventListener("resize", () => queueRender(false));
}

async function main() {
  loadPrefs(); // restores custom columns too (quietly, before first render)
  reindexRegistry();
  ensureColStyle();
  applyCols();
  applyWidths();
  initHeaders();
  initControls();
  setSort(sortOrder); // sync sort button label + aria with loaded pref
  updateHeaderStates();
  updateFooter();
  updateLiveBtn();
  await loadBuffer();
  connectWS();
}

main();
