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

// Filter keys with bespoke matching in matchFilters. Any OTHER key present
// on the filter object is a generic attribute query: case-insensitive
// substring match over the same-named parsed field. Custom/discovered
// columns ride this path with no per-field branches.
const KNOWN_FILTER_KEYS = new Set([
  "level", "decision", "reason", "user", "path", "code",
  "service", "reqid", "method", "host", "message", "time",
  "timeFrom", "timeTo",
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
