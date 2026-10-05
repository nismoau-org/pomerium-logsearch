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
  service: "", reqid: "", method: "", message: "", time: "", timeFrom: null, timeTo: null };
let search = "";
let isRegex = false;
const timeRange = { fromMs: null, toMs: null };

// Column registry: the grid is the union of known normalized fields across
// service types (authorize/envoy/other). Rows render blanks for keys they
// lack, so heterogeneous schemas share one stable layout. `on` is the
// default visibility; user toggles persist to localStorage.
const COLUMNS = [
  { id: "time", label: "Time", cls: "c-time", on: true },
  { id: "level", label: "Level", cls: "c-level", on: true },
  { id: "service", label: "Service", cls: "c-svc", on: true },
  { id: "decision", label: "Decision", cls: "c-dec", on: true },
  { id: "code", label: "Code", cls: "c-code", on: true },
  { id: "user", label: "User", cls: "c-user", on: true },
  { id: "path", label: "Path", cls: "c-path", on: true },
  { id: "method", label: "Method", cls: "c-method", on: false },
  { id: "host", label: "Host", cls: "c-host", on: false },
  { id: "reqid", label: "Req ID", cls: "c-reqid", on: false },
  { id: "message", label: "Message", cls: "c-msg", on: true },
];

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

function initColMenu() {
  const box = els.colMenu;
  box.textContent = "";
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
    box.appendChild(lab);
  }
}

const $ = (id) => document.getElementById(id);
const els = {};
for (const id of [
  "containerLabel", "followBtn", "clearBtn", "sortBtn", "liveBtn", "searchInput", "regexToggle",
  "levelSelect", "decAll", "decAllow", "decDeny", "reasonInput", "userInput",
  "pathInput", "codeInput", "regexError", "loglist", "logtop", "logrows",
  "logbottom", "emptyState", "bufferCount", "connPill", "lastTs", "visibleCount",
  "colMenu", "serviceInput", "reqidInput", "methodInput", "messageInput", "timeInput",
  "timeBtn", "timePop", "timeFromInput", "timeToInput", "timeApply", "timeClear", "timeError",
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
  updateFooter();
  queueRender(true);
}, DEBOUNCE_MS);

function recomputeNow(stick = false) {
  const r = filterEntries(entries, filters, search, isRegex);
  visible = r.visible;
  applySort();
  regexError = r.regexError || "";
  updateRegexError();
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

  row.appendChild(cell(fmtTime(e), "c-time"));
  const lvl = str(p.level || "");
  const lb = badge(lvl ? normalizeLevel(lvl) || lvl : "?", levelClass(lvl));
  lb.classList.add("c-level");
  row.appendChild(lb);
  row.appendChild(cell(field(p, "service", "svc"), "c-svc"));

  const dec = entryDecision(p);
  if (dec === "allow") {
    const b = badge(shortReason(p) ? "allow · " + shortReason(p) : "allow", "allow");
    b.classList.add("c-dec");
    row.appendChild(b);
  } else if (dec === "deny") {
    const b = badge(shortReason(p) ? "deny · " + shortReason(p) : "deny", "deny");
    b.classList.add("c-dec");
    row.appendChild(b);
  } else {
    row.appendChild(cell("", "c-dec"));
  }

  row.appendChild(cell(field(p, "response-code", "status", "code", "statusCode"), "c-code"));
  row.appendChild(cell(field(p, "user", "email"), "c-user"));
  row.appendChild(cell(field(p, "path", "host", "authority"), "c-path"));
  row.appendChild(cell(field(p, "method"), "c-method"));
  row.appendChild(cell(field(p, "host", "authority"), "c-host"));
  row.appendChild(cell(field(p, "request-id", "check-request-id"), "c-reqid"));
  row.appendChild(cell(messageOf(e), "c-msg"));

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

function setDecision(v) {
  filters.decision = v;
  for (const [id, val] of [["decAll", "all"], ["decAllow", "allow"], ["decDeny", "deny"]]) {
    const active = v === val;
    els[id].classList.toggle("active", active);
    els[id].setAttribute("aria-pressed", active ? "true" : "false");
  }
  recompute();
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

function rangeLabel() {
  const { fromMs, toMs } = timeRange;
  if (fromMs == null && toMs == null) return "Time: All time";
  if (fromMs != null && toMs != null) return `Time: ${fmtRangeShort(fromMs)} → ${fmtRangeShort(toMs)}`;
  if (fromMs != null) return `Time: ≥ ${fmtRangeShort(fromMs)}`;
  return `Time: ≤ ${fmtRangeShort(toMs)}`;
}

function toLocalInputValue(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function setTimeError(msg) {
  if (msg) {
    els.timeError.hidden = false;
    els.timeError.textContent = msg;
  } else {
    els.timeError.hidden = true;
    els.timeError.textContent = "";
  }
}

function hideTimePop() {
  els.timePop.hidden = true;
  els.timeBtn.setAttribute("aria-expanded", "false");
}

function applyTimeRange(fromMs, toMs) {
  timeRange.fromMs = fromMs;
  timeRange.toMs = toMs;
  filters.timeFrom = fromMs;
  filters.timeTo = toMs;
  els.timeFromInput.value = fromMs == null ? "" : toLocalInputValue(fromMs);
  els.timeToInput.value = toMs == null ? "" : toLocalInputValue(toMs);
  els.timeBtn.textContent = rangeLabel();
  setTimeError("");
  hideTimePop();
  recompute();
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

function applyCustomRange() {
  const f = els.timeFromInput.value ? new Date(els.timeFromInput.value).getTime() : null;
  const t = els.timeToInput.value ? new Date(els.timeToInput.value).getTime() : null;
  const fromMs = f != null && !Number.isNaN(f) ? f : null;
  const toMs = t != null && !Number.isNaN(t) ? t : null;
  if (fromMs != null && toMs != null && fromMs > toMs) {
    setTimeError("Start must be before end.");
    return;
  }
  applyTimeRange(fromMs, toMs);
}

function initTimePop() {
  els.timeBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const open = els.timePop.hidden;
    els.timePop.hidden = !open;
    els.timeBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) setTimeError("");
  });
  els.timePop.addEventListener("click", (ev) => ev.stopPropagation());
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".timerange-wrap")) hideTimePop();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") hideTimePop();
  });
  els.timePop.querySelectorAll("[data-range]").forEach((b) => {
    b.addEventListener("click", () => applyPreset(b.dataset.range));
  });
  els.timeApply.addEventListener("click", applyCustomRange);
  els.timeClear.addEventListener("click", () => applyTimeRange(null, null));
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
  els.searchInput.addEventListener("input", () => {
    search = els.searchInput.value;
    recompute();
  });
  els.regexToggle.addEventListener("change", () => {
    isRegex = els.regexToggle.checked;
    recompute();
  });
  els.levelSelect.addEventListener("change", () => {
    filters.level = els.levelSelect.value;
    recompute();
  });
  els.decAll.addEventListener("click", () => setDecision("all"));
  els.decAllow.addEventListener("click", () => setDecision("allow"));
  els.decDeny.addEventListener("click", () => setDecision("deny"));
  els.reasonInput.addEventListener("input", () => {
    filters.reason = els.reasonInput.value;
    recompute();
  });
  els.userInput.addEventListener("input", () => {
    filters.user = els.userInput.value;
    recompute();
  });
  els.pathInput.addEventListener("input", () => {
    filters.path = els.pathInput.value;
    recompute();
  });
  els.codeInput.addEventListener("input", () => {
    filters.code = els.codeInput.value;
    recompute();
  });
  for (const [el, key] of [["serviceInput", "service"], ["reqidInput", "reqid"],
      ["methodInput", "method"], ["messageInput", "message"], ["timeInput", "time"]]) {
    els[el].addEventListener("input", () => {
      filters[key] = els[el].value;
      recompute();
    });
  }
  els.loglist.addEventListener("scroll", () => queueRender(false), { passive: true });
  window.addEventListener("resize", () => queueRender(false));
}

async function main() {
  loadPrefs();
  applyCols();
  initControls();
  initColMenu();
  initTimePop();
  setSort(sortOrder); // sync sort button label + aria with loaded pref
  updateFooter();
  await loadBuffer();
  connectWS();
}

main();
