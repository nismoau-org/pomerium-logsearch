// Filter predicate tests (docs/TESTS.md §1, Option B).
// Run: node --test web/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLevel,
  levelMatches,
  entryDecision,
  matchFilters,
  filterEntries,
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
