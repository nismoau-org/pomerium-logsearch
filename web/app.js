import { filterEntries, entryDecision, normalizeLevel } from "./filters.js";

const ROW_H = 28;
const DETAIL_H = 232;
const OVERSCAN = 10;
const CLIENT_CAP = 10000;
const DEBOUNCE_MS = 200;
const MAX_BACKOFF = 30000;

const COPY_FIELDS = [
  "request-id",
  "check-request-id",
  "user",
  "email",
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

const filters = { level: "all", decision: "all", reason: "", user: "", path: "", code: "",
  service: "", reqid: "", method: "", host: "", message: "", time: "", timeFrom: null, timeTo: null };
let search = "";
let isRegex = false;
const timeRange = { fromMs: null, toMs: null };

// Column registry: the grid is the union of known normalized fields across
// service types (authorize/envoy/other). Rows render blanks for keys they
// lack, so heterogeneous schemas share one stable layout. `on` is the
// default visibility (persisted); `kind` selects the header-popup editor:
// text (contains input), level (dropdown), decision (tri-state + reason),
// time (presets + calendar range). `key` is the filters.js field.
const COLUMNS = [
  { id: "time", label: "Time", cls: "c-time", on: true, kind: "time" },
  { id: "level", label: "Level", cls: "c-level", on: true, kind: "level" },
  { id: "service", label: "Service", cls: "c-svc", on: true, kind: "text", key: "service", hint: "Contains match over service" },
  { id: "decision", label: "Decision", cls: "c-dec", on: true, kind: "decision" },
  { id: "code", label: "Code", cls: "c-code", on: true, kind: "text", key: "code", hint: "Contains match over response code" },
  { id: "user", label: "User", cls: "c-user", on: true, kind: "text", key: "user", hint: "Contains match over user and email" },
  { id: "path", label: "Path", cls: "c-path", on: true, kind: "text", key: "path", hint: "Contains match over path, host and authority" },
  { id: "method", label: "Method", cls: "c-method", on: false, kind: "text", key: "method", hint: "Contains match over method" },
  { id: "host", label: "Host", cls: "c-host", on: false, kind: "text", key: "host", hint: "Contains match over host and authority" },
  { id: "reqid", label: "Req ID", cls: "c-reqid", on: false, kind: "text", key: "reqid", hint: "Contains match over request-id" },
  { id: "message", label: "Message", cls: "c-msg", on: true, kind: "text", key: "message", hint: "Contains match over message" },
];

function colById(id) {
  return COLUMNS.find((c) => c.id === id);
}

function loadPrefs() {
  try {
    const cols = JSON.parse(localStorage.getItem("pls-cols-v1") || "null");
    if (cols && typeof cols === "object") {
      for (const c of COLUMNS) if (typeof cols[c.id] === "boolean") c.on = cols[c.id];
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
  } catch { /* ignore */ }
}

function applyCols() {
  for (const c of COLUMNS) document.body.classList.toggle("hide-col-" + c.id, !c.on);
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

function buildColumnsEditor() {
  const wrap = document.createElement("div");
  wrap.style.display = "contents";
  wrap.appendChild(popTitle("Show columns"));
  for (const c of COLUMNS) {
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
    wrap.appendChild(lab);
  }
  return wrap;
}

function openColumnPop(col, anchor) {
  const builders = { level: buildLevelEditor, decision: buildDecisionEditor, time: () => buildTimeEditor() };
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
// commits whatever is typed. Rich editors (level/decision/time) stay popups.
function onHeadClick(col, btn) {
  if (col.kind === "text") {
    if (btn.classList.contains("editing")) commitInlineEdit(true);
    else startInlineEdit(col, btn);
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
    wrap.appendChild(b);
  }
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

function field(parsed, ...keys) {
  for (const k of keys) {
    const v = parsed[k];
    if (v !== undefined && v !== null && v !== "") return str(v);
  }
  return "";
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

function messageOf(e) {
  const p = e.parsed || {};
  return field(p, "message", "msg", "error", "err") || e.raw.slice(0, 200);
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
  return expanded.has(e.id) ? ROW_H + DETAIL_H : ROW_H;
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
// top in desc order. Follow mode pins the view there.
function nearLiveEdge() {
  const el = els.loglist;
  if (sortOrder === "desc") return el.scrollTop < ROW_H * 4;
  return el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 4;
}

function scrollToLive() {
  if (sortOrder === "desc") els.loglist.scrollTop = 0;
  else els.loglist.scrollTop = els.loglist.scrollHeight;
}

function render(stick = false) {
  const totalH = displayed.reduce((a, e) => a + rowHeight(e), 0);
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
  void totalH;

  // Rebuild window rows.
  els.logrows.textContent = "";
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) frag.appendChild(buildRow(displayed[i]));
  els.logrows.appendChild(frag);

  els.emptyState.hidden = displayed.length !== 0;

  if ((stick || (follow && nearLiveEdge())) && follow) {
    scrollToLive();
  }

  // The header sits outside the scroll container (so virtualization math is
  // untouched); shift its inner strip to follow horizontal scrolling.
  els.colheaderIn.style.transform = `translateX(${-els.loglist.scrollLeft}px)`;
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

  line.appendChild(cell(fmtTime(e), "c-time"));
  const lvl = str(p.level || "");
  const lb = badge(lvl ? normalizeLevel(lvl) || lvl : "?", levelClass(lvl));
  lb.classList.add("c-level");
  line.appendChild(lb);
  line.appendChild(cell(field(p, "service", "svc"), "c-svc"));

  const dec = entryDecision(p);
  if (dec === "allow") {
    const b = badge(shortReason(p) ? "allow · " + shortReason(p) : "allow", "allow");
    b.classList.add("c-dec");
    line.appendChild(b);
  } else if (dec === "deny") {
    const b = badge(shortReason(p) ? "deny · " + shortReason(p) : "deny", "deny");
    b.classList.add("c-dec");
    line.appendChild(b);
  } else {
    line.appendChild(cell("", "c-dec"));
  }

  line.appendChild(cell(field(p, "response-code", "status", "code", "statusCode"), "c-code"));
  line.appendChild(cell(field(p, "user", "email"), "c-user"));
  line.appendChild(cell(field(p, "path", "host", "authority"), "c-path"));
  line.appendChild(cell(field(p, "method"), "c-method"));
  line.appendChild(cell(field(p, "host", "authority"), "c-host"));
  line.appendChild(cell(field(p, "request-id", "check-request-id"), "c-reqid"));
  line.appendChild(cell(messageOf(e), "c-msg"));

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
  queueRender(false);
}

// ---------- data intake ----------

function addEntry(line) {
  if (!line || line.id === undefined) return;
  if (idSet.has(line.id)) return;
  idSet.add(line.id);
  entries.push({ id: line.id, ts: line.ts || "", raw: str(line.raw), parsed: line.parsed || {} });
  if (entries.length > CLIENT_CAP) {
    const drop = entries.length - CLIENT_CAP;
    for (let i = 0; i < drop; i++) idSet.delete(entries[i].id);
    entries.splice(0, drop);
    for (const id of [...expanded]) if (!idSet.has(id)) expanded.delete(id);
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
  filters.user = "";
  filters.path = "";
  filters.code = "";
  filters.service = "";
  filters.reqid = "";
  filters.method = "";
  filters.host = "";
  filters.message = "";
  filters.time = "";
  filters.timeFrom = null;
  filters.timeTo = null;
  timeRange.fromMs = null;
  timeRange.toMs = null;
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
}

function setFollow(v) {
  follow = v;
  els.followBtn.textContent = follow ? "Pause" : "Follow";
  els.followBtn.setAttribute("aria-pressed", follow ? "true" : "false");
  if (follow) scrollToLive();
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
  els.loglist.addEventListener("scroll", () => queueRender(false), { passive: true });
  window.addEventListener("resize", () => queueRender(false));
}

async function main() {
  loadPrefs();
  applyCols();
  initHeaders();
  initControls();
  setSort(sortOrder); // sync sort button label + aria with loaded pref
  updateHeaderStates();
  updateFooter();
  await loadBuffer();
  connectWS();
}

main();
