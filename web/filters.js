// Pure filter-predicate module. No DOM dependencies — testable with `node --test`.
//
// Entry shape: { id, ts, raw, parsed }
// parsed is a normalized object (or possibly null/undefined for malformed lines).

const REASON_FIELDS = [
  "allow-why-true",
  "allow-why-false",
  "deny-why-true",
  "deny-why-false",
];

/** Lowercase + trim; maps "warning" -> "warn". Non-string -> "". */
export function normalizeLevel(lvl) {
  if (typeof lvl !== "string") return "";
  const s = lvl.trim().toLowerCase();
  if (s === "warning") return "warn";
  return s;
}

const CRITICAL_SET = new Set(["critical", "fatal", "panic"]);

/**
 * levelMatches(entryLevel, filter):
 * - filter "all" (or empty) always passes
 * - "warn" matches warn|warning
 * - "critical" matches critical|fatal|panic
 * - otherwise exact lowercase match (after warning->warn normalization)
 */
export function levelMatches(entryLevel, filter) {
  const f = normalizeLevel(filter);
  if (!f || f === "all") return true;
  const lvl = normalizeLevel(entryLevel);
  if (f === "warn") return lvl === "warn";
  if (f === "critical") return CRITICAL_SET.has(lvl);
  return lvl === f;
}

function isTrue(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function isFalse(v) {
  return v === false || v === "false" || v === 0 || v === "0";
}

/**
 * entryDecision(parsed): 'allow' | 'deny' | ''
 * Uses parsed.decision when present, otherwise infers from allow/deny bools.
 */
export function entryDecision(parsed) {
  if (!parsed || typeof parsed !== "object") return "";
  const d = parsed.decision;
  if (typeof d === "string") {
    const s = d.trim().toLowerCase();
    if (s === "allow" || s === "allowed" || s === "allow-true") return "allow";
    if (s === "deny" || s === "denied" || s === "deny-true") return "deny";
  }
  if (isTrue(parsed.allow)) return "allow";
  if (isFalse(parsed.allow)) return "deny";
  if (isTrue(parsed.deny)) return "deny";
  if (isFalse(parsed.deny)) return "allow";
  if (isTrue(parsed.allowed)) return "allow";
  if (isFalse(parsed.allowed)) return "deny";
  // Fall back to reason-field inference (mirrors backend decision derivation):
  // a non-empty allow-why-true implies allow, deny-why-true implies deny.
  if (str(parsed["allow-why-true"]).trim() !== "") return "allow";
  if (str(parsed["deny-why-true"]).trim() !== "") return "deny";
  return "";
}

function str(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function contains(haystack, needle) {
  if (!needle) return true;
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

// ---------- IP address scope (public vs RFC1918 private) ----------
// "Public" means globally routable unicast — not merely non-RFC1918:
// loopback, link-local, multicast, CGNAT, documentation, and reserved ranges
// are excluded too. "Private" is exactly RFC1918 (10/8, 172.16/12,
// 192.168/16); other special addresses (e.g. loopback) match neither scope.

function parseIpv4Dotted(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (!parts.every((n) => n >= 0 && n <= 255)) return null;
  return parts;
}

function parseHextets(head, tailCount) {
  const dbl = head.split("::");
  if (dbl.length > 2) return null;
  const side = (s) => {
    if (s === "") return [];
    const out = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  if (dbl.length === 1) {
    const g = side(head);
    return g && g.length === 8 - tailCount ? g : null;
  }
  const left = side(dbl[0]);
  const right = side(dbl[1]);
  if (!left || !right) return null;
  if (left.length + right.length > 8 - tailCount) return null;
  const fill = 8 - tailCount - left.length - right.length;
  if (fill < 1) return null; // "::" must compress at least one group
  return [...left, ...new Array(fill).fill(0), ...right];
}

/**
 * parseIpLiteral(token) -> { family: 4|6, parts } | null.
 * Accepts a lone address with optional port (`1.2.3.4:443`), bracketed IPv6
 * with optional port (`[::1]:443`), and zone ids (`fe80::1%eth0`).
 */
export function parseIpLiteral(token) {
  if (typeof token !== "string") return null;
  let t = token.trim().replace(/^['"]+|['"]+$/g, "");
  if (!t) return null;
  const br = t.match(/^\[([^\]]+)\](?::\d{1,5})?$/);
  if (br) t = br[1];
  const pct = t.indexOf("%");
  if (pct >= 0) t = t.slice(0, pct);
  if (!t) return null;
  const v4 = t.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?$/);
  if (v4) {
    const parts = parseIpv4Dotted(v4[1]);
    return parts ? { family: 4, parts } : null;
  }
  if (!t.includes(":")) return null;
  let tail = null;
  let head = t;
  if (t.includes(".")) {
    // IPv4-embedded tail (e.g. ::ffff:192.0.2.1, 64:ff9b::192.0.2.1).
    const i = t.lastIndexOf(":");
    const v4tail = i < 0 ? null : parseIpv4Dotted(t.slice(i + 1));
    if (!v4tail) return null;
    tail = [(v4tail[0] << 8) | v4tail[1], (v4tail[2] << 8) | v4tail[3]];
    head = t.slice(0, i);
    if (head.endsWith(":") && !head.endsWith("::")) head += ":"; // keep "::" whole
    if (head === "" || head === ":") return null;
  }
  const groups = parseHextets(head, tail ? 2 : 0);
  if (!groups) return null;
  return { family: 6, parts: tail ? [...groups, ...tail] : groups };
}

function ipv4Scope(p) {
  const [a, b, c] = p;
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return "private";
  }
  if (a === 0 || a === 127) return ""; // unspecified / loopback
  if (a === 169 && b === 254) return ""; // link-local
  if (a === 100 && b >= 64 && b <= 127) return ""; // shared CGNAT space
  if (a === 192 && b === 0 && c === 0) return ""; // 192.0.0.0/24 special registry
  if (a === 192 && b === 0 && c === 2) return ""; // 192.0.2.0/24 documentation
  if (a === 198 && (b === 18 || b === 19)) return ""; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return ""; // 198.51.100.0/24 documentation
  if (a === 203 && b === 0 && c === 113) return ""; // 203.0.113.0/24 documentation
  if (a >= 224) return ""; // multicast + reserved
  return "public";
}

function ipv4FromParts(hi, lo) {
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

function ipv6Scope(p) {
  if (p.every((n) => n === 0)) return ""; // ::
  if (p[7] === 1 && p.slice(0, 7).every((n) => n === 0)) return ""; // ::1 loopback
  if ((p[0] & 0xff00) === 0xff00) return ""; // multicast
  if ((p[0] & 0xffc0) === 0xfe80) return ""; // link-local
  if ((p[0] & 0xfe00) === 0xfc00) return ""; // unique local (not RFC1918; neither scope)
  if (p[0] === 0x2001 && p[1] === 0x0db8) return ""; // documentation
  if (p[0] === 0x2001 && p[1] === 0x0000) return ""; // Teredo (obfuscated; unclassifiable)
  if (p[0] === 0 && p[1] === 0 && p[2] === 0 && p[3] === 0 && p[4] === 0 && p[5] === 0xffff) {
    return ipv4Scope(ipv4FromParts(p[6], p[7])); // IPv4-mapped
  }
  if (p[0] === 0x2002) {
    return ipv4Scope(ipv4FromParts(p[1], p[2])); // 6to4 embeds the IPv4 address
  }
  if (p[0] === 0x0064 && p[1] === 0xff9b && p[2] === 0 && p[3] === 0 && p[4] === 0) {
    if (p[5] !== 0) return ""; // 64:ff9b:1::/48 local use etc.
    return ipv4Scope(ipv4FromParts(p[6], p[7])); // NAT64 well-known prefix
  }
  return "public";
}

/**
 * ipScopeOfValue(value) -> "public" | "private" | "".
 * Uses the first parseable literal in comma/space-separated lists (e.g.
 * X-Forwarded-For chains, where the leftmost entry is the original client).
 * "" means unknown or special-but-neither (e.g. loopback): it matches no
 * active scope, so scoped-out rows are excluded rather than guessed.
 */
export function ipScopeOfValue(value) {
  const s = str(value);
  if (!s) return "";
  for (const tok of s.split(/[,;\s]+/)) {
    if (!tok) continue;
    const lit = parseIpLiteral(tok);
    if (!lit) continue;
    return lit.family === 4 ? ipv4Scope(lit.parts) : ipv6Scope(lit.parts);
  }
  return "";
}

/** ipScopeMatches(value, scope): "all"/empty always passes. */
export function ipScopeMatches(value, scope) {
  if (!scope || scope === "all") return true;
  const s = ipScopeOfValue(value);
  if (!s) return false;
  return s === scope;
}

// Filter keys with bespoke matching in matchFilters. Any OTHER key present
// on the filter object is a generic attribute query: case-insensitive
// substring match over the same-named parsed field. Custom/discovered
// columns ride this path with no per-field branches.
const KNOWN_FILTER_KEYS = new Set([
  "level", "decision", "reason", "user", "path", "code",
  "service", "reqid", "method", "host", "message", "time",
  "timeFrom", "timeTo", "ipScope", "fwdScope",
]);

/**
 * matchFilters(entry, f): AND semantics over all predicates.
 * f = { level, decision('all'|'allow'|'deny'), reason, user, path, code,
 *       service, reqid, method, host, message, time }
 * - reason: case-insensitive substring over any of the 4 reason fields
 * - user: over user + email
 * - path: over path + host + authority
 * - code: over response-code / status string (substring)
 * - service: over service/svc
 * - reqid: over request-id + check-request-id
 * - method: over method
 * - message: over message + msg
 * - time: over parsed.time + entry ts (e.g. "12:20" or "2026-10-04")
 * - ipScope: "all" | "public" | "private" over parsed.ip
 * - fwdScope: "all" | "public" | "private" over parsed["forwarded-for"]
 *   (falling back to parsed["x-forwarded-for"])
 * - any other key: case-insensitive substring over parsed[key]
 *   (generic attribute queries for custom/discovered columns)
 * Missing/empty criteria pass.
 */
export function matchFilters(entry, f = {}) {
  const parsed = (entry && entry.parsed) || {};

  const level = f.level ?? "all";
  if (!levelMatches(parsed.level, level)) return false;

  const decision = (f.decision ?? "all").toString().toLowerCase();
  if (decision && decision !== "all") {
    if (entryDecision(parsed) !== decision) return false;
  }

  if (f.reason) {
    const q = f.reason.toLowerCase();
    let hit = false;
    for (const k of REASON_FIELDS) {
      const v = str(parsed[k]);
      if (v && v.toLowerCase().includes(q)) {
        hit = true;
        break;
      }
    }
    if (!hit) return false;
  }

  if (f.user) {
    const hay = `${str(parsed.user)} ${str(parsed.email)}`;
    if (!contains(hay, f.user)) return false;
  }

  if (f.path) {
    const hay = `${str(parsed.path)} ${str(parsed.host)} ${str(parsed.authority)}`;
    if (!contains(hay, f.path)) return false;
  }

  if (f.host) {
    const hay = `${str(parsed.host)} ${str(parsed.authority)}`;
    if (!contains(hay, f.host)) return false;
  }

  if (f.code) {
    const codeVal = str(
      parsed["response-code"] ?? parsed.status ?? parsed.code ?? parsed.statusCode ?? "",
    );
    if (!contains(codeVal, String(f.code).trim())) return false;
  }

  if (f.service) {
    if (!contains(str(parsed.service ?? parsed.svc), f.service)) return false;
  }

  if (f.reqid) {
    const hay = `${str(parsed["request-id"])} ${str(parsed["check-request-id"])}`;
    if (!contains(hay, f.reqid)) return false;
  }

  if (f.method) {
    if (!contains(str(parsed.method), f.method)) return false;
  }

  if (f.message) {
    const hay = `${str(parsed.message)} ${str(parsed.msg)}`;
    if (!contains(hay, f.message)) return false;
  }

  if (f.time) {
    const hay = `${str(parsed.time)} ${str(entry && entry.ts)}`;
    if (!contains(hay, f.time)) return false;
  }

  if (f.timeFrom != null || f.timeTo != null) {
    if (!matchTimeRange(entry, f.timeFrom, f.timeTo)) return false;
  }

  if (f.ipScope && f.ipScope !== "all") {
    if (!ipScopeMatches(str(parsed.ip), f.ipScope)) return false;
  }

  if (f.fwdScope && f.fwdScope !== "all") {
    const fwdRaw = str(parsed["forwarded-for"]) || str(parsed["x-forwarded-for"]);
    if (!ipScopeMatches(fwdRaw, f.fwdScope)) return false;
  }

  for (const k of Object.keys(f)) {
    if (KNOWN_FILTER_KEYS.has(k)) continue;
    const q = f[k];
    if (q == null || q === "") continue;
    if (!contains(str(parsed[k]), String(q))) return false;
  }

  return true;
}

/**
 * matchSearch(entry, query, isRegex): boolean.
 * - empty query -> true
 * - non-regex: case-insensitive substring over raw + JSON.stringify(parsed)
 * - regex: new RegExp(query) test over the same haystack (throws on invalid regex)
 */
export function matchSearch(entry, query, isRegex) {
  if (!query) return true;
  const hay = `${str(entry && entry.raw)} ${safeStringify((entry && entry.parsed) || {})}`;
  if (!isRegex) {
    return hay.toLowerCase().includes(String(query).toLowerCase());
  }
  const re = new RegExp(query);
  return re.test(hay);
}

function safeStringify(v) {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

/**
 * matchTimeRange(entry, fromMs, toMs): absolute range over the entry
 * timestamp (parsed.time, falling back to entry ts). Null bounds are open.
 * No active range -> true. Entries without a parseable timestamp are
 * excluded while a range is active (they cannot satisfy it).
 */
export function matchTimeRange(entry, fromMs, toMs) {
  if (fromMs == null && toMs == null) return true;
  const t = entryTimeMs(entry);
  if (Number.isNaN(t)) return false;
  if (fromMs != null && t < fromMs) return false;
  if (toMs != null && t > toMs) return false;
  return true;
}

function entryTimeMs(entry) {
  const parsed = (entry && entry.parsed) || {};
  const v = parsed.time ?? (entry && entry.ts) ?? "";
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return Date.parse(String(v));
}

/**
 * tryMatchSearch: never throws. Returns { matched, error }.
 * error is a non-empty string when the regex is invalid.
 */
export function tryMatchSearch(entry, query, isRegex) {
  if (!query) return { matched: true, error: "" };
  if (!isRegex) {
    return { matched: matchSearch(entry, query, false), error: "" };
  }
  try {
    return { matched: matchSearch(entry, query, true), error: "" };
  } catch (err) {
    return { matched: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * filterEntries(entries, filters, search, isRegex) -> { visible, regexError }.
 * AND semantics: a row is visible only if it passes matchFilters AND search.
 * regexError is "" unless the regex search pattern is invalid.
 */
export function filterEntries(entries, filters = {}, search = "", isRegex = false) {
  const list = Array.isArray(entries) ? entries : [];
  let regexError = "";
  // Validate regex once up front so we report the error even on empty buffers.
  if (search && isRegex) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(search);
    } catch (err) {
      regexError = err instanceof Error ? err.message : String(err);
    }
  }
  if (regexError) {
    // Still apply field filters; search matches nothing while invalid.
    const visible = list.filter((e) => matchFilters(e, filters));
    return { visible, regexError };
  }
  const visible = [];
  for (const e of list) {
    if (!matchFilters(e, filters)) continue;
    const { matched, error } = tryMatchSearch(e, search, isRegex);
    if (error && !regexError) regexError = error;
    if (regexError) continue;
    if (matched) visible.push(e);
  }
  return { visible, regexError };
}
