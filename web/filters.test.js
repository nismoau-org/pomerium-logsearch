// Filter predicate tests (docs/TESTS.md §1, Option B).
// Run: node --test web/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLevel,
  levelMatches,
  entryDecision,
  matchFilters,
  matchTimeRange,
  filterEntries,
  parseIpLiteral,
  ipScopeOfValue,
  ipScopeMatches,
} from "./filters.js";

const entry = (parsed, raw = "{}") => ({ id: "1", ts: "", raw, parsed });

describe("normalizeLevel", () => {
  it("maps warning to warn", () => {
    assert.equal(normalizeLevel("warning"), "warn");
    assert.equal(normalizeLevel("WARNING"), "warn");
    assert.equal(normalizeLevel("info"), "info");
    assert.equal(normalizeLevel(null), "");
  });
});

describe("levelMatches", () => {
  it("all passes, warn covers warning, critical covers fatal/panic", () => {
    assert.equal(levelMatches("info", "all"), true);
    assert.equal(levelMatches("warning", "warn"), true);
    assert.equal(levelMatches("warn", "warn"), true);
    assert.equal(levelMatches("fatal", "critical"), true);
    assert.equal(levelMatches("panic", "critical"), true);
    assert.equal(levelMatches("info", "error"), false);
  });
});

describe("entryDecision", () => {
  it("uses bools then reason fields", () => {
    assert.equal(entryDecision({ allow: true }), "allow");
    assert.equal(entryDecision({ allow: false }), "deny");
    assert.equal(entryDecision({ deny: true }), "deny");
    assert.equal(entryDecision({ decision: "allow" }), "allow");
    assert.equal(entryDecision({ "allow-why-true": "policy" }), "allow");
    assert.equal(entryDecision({ "deny-why-true": "blocked" }), "deny");
    assert.equal(entryDecision({ message: "hi" }), "");
  });
});

describe("matchFilters", () => {
  it("AND semantics with authority fallback and code substring", () => {
    const e = entry({
      level: "info",
      decision: "deny",
      "deny-why-true": "policy denied",
      user: "alice@example.com",
      path: "/api",
      authority: "example.com",
      "response-code": "403",
    });
    const pass = { level: "all", decision: "deny", reason: "policy", user: "alice", path: "example", code: "403" };
    assert.equal(matchFilters(e, pass), true);
    assert.equal(matchFilters(e, { ...pass, decision: "allow" }), false);
    assert.equal(matchFilters(e, { ...pass, code: "500" }), false);
    assert.equal(matchFilters(e, { ...pass, path: "other" }), false);
  });

  it("covers every column (service, reqid, method, host, message, time)", () => {
    const e = entry(
      {
        level: "info",
        service: "envoy",
        "request-id": "abc-123",
        method: "GET",
        authority: "example.com",
        message: "http-request",
        time: "2026-10-04T12:20:40Z",
      },
      "raw",
    );
    e.ts = "2026-10-04T12:20:40Z";
    const full = { service: "env", reqid: "abc", method: "get", host: "example", message: "http", time: "12:20" };
    assert.equal(matchFilters(e, full), true);
    assert.equal(matchFilters(e, { ...full, service: "authorize" }), false);
    assert.equal(matchFilters(e, { ...full, reqid: "zzz" }), false);
    assert.equal(matchFilters(e, { ...full, method: "post" }), false);
    assert.equal(matchFilters(e, { ...full, host: "other" }), false);
    assert.equal(matchFilters(e, { ...full, message: "boom" }), false);
    assert.equal(matchFilters(e, { ...full, time: "2024" }), false);
    // missing criteria pass (backward compatible with older filter objects)
    assert.equal(matchFilters(e, {}), true);
  });
});

describe("matchFilters generic attribute queries", () => {
  it("substring-matches any non-key filter over the same-named parsed field", () => {
    const e = entry({ service: "authorize", ip: "10.0.0.8", duration: 12 });
    assert.equal(matchFilters(e, { ip: "10.0.0" }), true);
    assert.equal(matchFilters(e, { ip: "10.0.0.8" }), true);
    assert.equal(matchFilters(e, { IP: "10.0.0" }), false); // key is case-sensitive, value is not
    assert.equal(matchFilters(e, { ip: "192.168" }), false);
    assert.equal(matchFilters(e, { ip: "" }), true); // empty query passes
    assert.equal(matchFilters(e, { duration: "12" }), true); // numeric field values
    assert.equal(matchFilters(e, { duration: "13" }), false);
  });

  it("excludes rows lacking the field while a query is active", () => {
    const e = entry({ service: "envoy" });
    assert.equal(matchFilters(e, {}), true);
    assert.equal(matchFilters(e, { ip: "10." }), false);
  });

  it("AND-combines generic queries with bespoke ones", () => {
    const e = entry({ level: "info", ip: "10.0.0.8" });
    assert.equal(matchFilters(e, { level: "info", ip: "10." }), true);
    assert.equal(matchFilters(e, { level: "error", ip: "10." }), false);
    assert.equal(matchFilters(e, { level: "info", ip: "192." }), false);
  });
});

describe("ipScopeOfValue", () => {
  it("classifies public IPv4 addresses (ports stripped)", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "9.9.9.9", "8.8.8.8:443"]) {
      assert.equal(ipScopeOfValue(ip), "public", ip);
    }
  });

  it("classifies RFC1918 ranges as private", () => {
    for (const ip of ["10.0.0.8", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.1.1"]) {
      assert.equal(ipScopeOfValue(ip), "private", ip);
    }
    for (const ip of ["172.15.255.255", "172.32.0.1"]) {
      assert.equal(ipScopeOfValue(ip), "public", ip);
    }
  });

  it("excludes other special ranges from both scopes", () => {
    for (const ip of ["127.0.0.1", "169.254.10.20", "224.0.0.1", "0.0.0.0",
        "100.64.0.1", "192.0.2.1", "198.51.100.2", "203.0.113.9", "999.1.1.1", "not-an-ip", ""]) {
      assert.equal(ipScopeOfValue(ip), "", ip);
    }
  });

  it("uses the first parseable address in forwarded-for chains", () => {
    assert.equal(ipScopeOfValue("8.8.8.8, 10.0.0.1"), "public");
    assert.equal(ipScopeOfValue("10.0.0.1, 8.8.8.8"), "private");
    assert.equal(ipScopeOfValue("unknown, 8.8.8.8"), "public");
  });

  it("handles IPv6 literals", () => {
    assert.equal(ipScopeOfValue("2001:4860:4860::8888"), "public");
    assert.equal(ipScopeOfValue("::1"), "");
    assert.equal(ipScopeOfValue("fe80::1"), "");
    assert.equal(ipScopeOfValue("fc00::1"), "");
    assert.equal(ipScopeOfValue("ff02::1"), "");
    assert.equal(ipScopeOfValue("2001:db8::1"), "");
    assert.equal(ipScopeOfValue("[2001:4860:4860::8888]:443"), "public");
    assert.equal(ipScopeOfValue("::ffff:10.0.0.8"), "private");
    assert.equal(ipScopeOfValue("::ffff:8.8.8.8"), "public");
  });

  it("parseIpLiteral rejects garbage", () => {
    assert.equal(parseIpLiteral(""), null);
    assert.equal(parseIpLiteral("1.2.3"), null);
    assert.equal(parseIpLiteral("1.2.3.4.5"), null);
    assert.equal(parseIpLiteral("1::2::3"), null);
    assert.equal(parseIpLiteral(null), null);
    assert.deepEqual(parseIpLiteral("10.0.0.1"), { family: 4, parts: [10, 0, 0, 1] });
  });

  it("ipScopeMatches honors the all/empty passthrough", () => {
    assert.equal(ipScopeMatches("garbage", "all"), true);
    assert.equal(ipScopeMatches("garbage", ""), true);
    assert.equal(ipScopeMatches("8.8.8.8", "public"), true);
    assert.equal(ipScopeMatches("8.8.8.8", "private"), false);
    assert.equal(ipScopeMatches("10.1.2.3", "private"), true);
    assert.equal(ipScopeMatches("127.0.0.1", "public"), false);
    assert.equal(ipScopeMatches("127.0.0.1", "private"), false);
  });
});

describe("matchFilters ip/fwd scopes", () => {
  it("filters ip scope ANDed with the ip text query", () => {
    const pub = entry({ ip: "8.8.8.8" });
    const priv = entry({ ip: "10.0.0.8" });
    const noip = entry({ service: "envoy" });
    assert.equal(matchFilters(pub, { ipScope: "public" }), true);
    assert.equal(matchFilters(priv, { ipScope: "public" }), false);
    assert.equal(matchFilters(noip, { ipScope: "public" }), false);
    assert.equal(matchFilters(priv, { ipScope: "private" }), true);
    assert.equal(matchFilters(pub, { ipScope: "private" }), false);
    assert.equal(matchFilters(pub, { ipScope: "all" }), true);
    assert.equal(matchFilters(pub, { ip: "8.8", ipScope: "public" }), true);
    assert.equal(matchFilters(pub, { ip: "10.", ipScope: "public" }), false);
  });

  it("filters forwarded-for scope over both alias fields", () => {
    const fwd = entry({ "forwarded-for": "8.8.8.8, 10.0.0.1" });
    const xfwd = entry({ "x-forwarded-for": "192.168.0.5" });
    assert.equal(matchFilters(fwd, { fwdScope: "public" }), true);
    assert.equal(matchFilters(fwd, { fwdScope: "private" }), false);
    assert.equal(matchFilters(xfwd, { fwdScope: "private" }), true);
    assert.equal(matchFilters(xfwd, { fwdScope: "public" }), false);
    assert.equal(matchFilters(entry({}), { fwdScope: "public" }), false);
  });
});

describe("matchTimeRange", () => {
  const e = (ts) => entry({ time: ts }, "raw");
  const H = 3600000;
  const base = Date.parse("2026-10-04T12:00:00Z");
  it("passes everything with no active range", () => {
    assert.equal(matchTimeRange(e("2026-10-04T12:00:00Z"), null, null), true);
    assert.equal(matchTimeRange(e("garbage"), null, null), true);
  });
  it("enforces closed and open ranges", () => {
    assert.equal(matchTimeRange(e("2026-10-04T12:00:00Z"), base - H, base + H), true);
    assert.equal(matchTimeRange(e("2026-10-04T10:00:00Z"), base - H, base + H), false);
    assert.equal(matchTimeRange(e("2026-10-04T12:00:00Z"), base, null), true);
    assert.equal(matchTimeRange(e("2026-10-04T11:59:59Z"), base, null), false);
    assert.equal(matchTimeRange(e("2026-10-04T12:00:00Z"), null, base), true);
    assert.equal(matchTimeRange(e("2026-10-04T12:00:01Z"), null, base), false);
  });
  it("excludes unparseable timestamps only while a range is active", () => {
    assert.equal(matchTimeRange(e("not-a-time"), base - H, base + H), false);
  });
  it("flows through matchFilters as timeFrom/timeTo", () => {
    const list = [e("2026-10-04T12:00:00Z"), e("2026-10-04T10:00:00Z")];
    const r = filterEntries(list, { timeFrom: base - H, timeTo: base + H }, "", false);
    assert.equal(r.visible.length, 1);
  });
});
describe("filterEntries", () => {
  it("combines filters and search, reports invalid regex", () => {
    const list = [
      entry({ level: "info", message: "hello" }, '{"message":"hello"}'),
      entry({ level: "error", message: "boom" }, '{"message":"boom"}'),
    ];
    const r1 = filterEntries(list, { level: "error", decision: "all", reason: "", user: "", path: "", code: "" }, "", false);
    assert.equal(r1.visible.length, 1);
    const r2 = filterEntries(list, {}, "hello", false);
    assert.equal(r2.visible.length, 1);
    const r3 = filterEntries(list, {}, "([", true);
    assert.notEqual(r3.regexError, "");
  });
});
