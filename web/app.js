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
let expanded = new Set();
let total = 0;
let lastTs = "";
let connState = "connecting";
let ws = null;
let backoff = 1000;
let renderQueued = false;

const filters = { level: "all", decision: "all", reason: "", user: "", path: "", code: "" };
let search = "";
let isRegex = false;

const $ = (id) => document.getElementById(id);
const els = {};
for (const id of [
  "containerLabel", "followBtn", "clearBtn", "searchInput", "regexToggle",
  "levelSelect", "decAll", "decAllow", "decDeny", "reasonInput", "userInput",
  "pathInput", "codeInput", "regexError", "loglist", "logtop", "logrows",
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

const recompute = debounce(() => {
  const r = filterEntries(entries, filters, search, isRegex);
  visible = r.visible;
  regexError = r.regexError || "";
  updateRegexError();
  updateFooter();
  queueRender(true);
}, DEBOUNCE_MS);

function recomputeNow(stick = false) {
  const r = filterEntries(entries, filters, search, isRegex);
  visible = r.visible;
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

function nearBottom() {
  const el = els.loglist;
  return el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 4;
}

function render(stick = false) {
  const totalH = visible.reduce((a, e) => a + rowHeight(e), 0);
  const scrollTop = els.loglist.scrollTop;
  const viewH = els.loglist.clientHeight || 600;

  // Find start index by cumulative height.
  let acc = 0;
  let start = 0;
  for (let i = 0; i < visible.length; i++) {
    const h = rowHeight(visible[i]);
    if (acc + h < scrollTop - OVERSCAN * ROW_H) {
      acc += h;
      start = i + 1;
    } else break;
  }
  let topH = 0;
  for (let i = 0; i < start; i++) topH += rowHeight(visible[i]);

  let end = start;
  let winH = 0;
  const budget = viewH + OVERSCAN * 2 * ROW_H;
  while (end < visible.length && winH < budget) {
    winH += rowHeight(visible[end]);
    end++;
  }
  let bottomH = 0;
  for (let i = end; i < visible.length; i++) bottomH += rowHeight(visible[i]);

  els.logtop.style.height = topH + "px";
  els.logbottom.style.height = bottomH + "px";
  void totalH;

  // Rebuild window rows.
  els.logrows.textContent = "";
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) frag.appendChild(buildRow(visible[i]));
  els.logrows.appendChild(frag);

  els.emptyState.hidden = visible.length !== 0;

  if ((stick || (follow && nearBottom())) && follow) {
    els.loglist.scrollTop = els.loglist.scrollHeight;
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

function initControls() {
  els.followBtn.addEventListener("click", () => {
    follow = !follow;
    els.followBtn.textContent = follow ? "Pause" : "Follow";
    els.followBtn.setAttribute("aria-pressed", follow ? "true" : "false");
    if (follow) els.loglist.scrollTop = els.loglist.scrollHeight;
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
  els.loglist.addEventListener("scroll", () => queueRender(false), { passive: true });
  window.addEventListener("resize", () => queueRender(false));
}

async function main() {
  initControls();
  updateFooter();
  await loadBuffer();
  connectWS();
}

main();
