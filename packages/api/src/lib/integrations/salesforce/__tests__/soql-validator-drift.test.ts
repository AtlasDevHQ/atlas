import { describe, expect, it } from "bun:test";
// Core copy.
import * as core from "../soql-validation";
// Plugin copy — imported by relative path. The two SOQL validators are
// DELIBERATELY duplicated: core can't import the workspace plugin package
// (@useatlas/salesforce), so a "keep in sync" comment was the only guard. This
// test makes the duplication enforceable — a security fix to one that skips the
// other (the failure mode that motivated #3325) now fails CI. Both modules are
// pure and import-free, so a relative import is safe here.
import * as plugin from "../../../../../../../plugins/salesforce/src/validation";

const sig = (re: RegExp) => `/${re.source}/${re.flags}`;

describe("SOQL validator drift-check (core ↔ plugin) — #3325", () => {
  it("the forbidden-pattern lists are identical", () => {
    expect(core.SOQL_FORBIDDEN_PATTERNS.map(sig)).toEqual(
      plugin.SOQL_FORBIDDEN_PATTERNS.map(sig),
    );
  });

  it("the sensitive-error scrub patterns are identical", () => {
    expect(sig(core.SENSITIVE_PATTERNS)).toBe(sig(plugin.SENSITIVE_PATTERNS));
  });

  // A battery hitting every validation layer: empty/semicolon, each mutation
  // keyword (bare AND hidden inside a literal — the strip-bypass class), FROM
  // extraction with/without whitelist, subqueries, and LIMIT edge cases. If the
  // two implementations ever diverge on any of these, the parity asserts below
  // pinpoint it.
  const ALLOWED = new Set(["account", "contact"]);
  const EMPTY = new Set<string>();
  const battery: { soql: string; allowed: Set<string> }[] = [
    { soql: "", allowed: EMPTY },
    { soql: "   ", allowed: EMPTY },
    { soql: "SELECT Id FROM Account; DELETE", allowed: ALLOWED },
    { soql: "SELECT Id, Name FROM Account", allowed: ALLOWED },
    { soql: "SELECT Id FROM Account", allowed: EMPTY },
    { soql: "SELECT Id FROM Lead", allowed: ALLOWED },
    { soql: "DELETE FROM Account", allowed: ALLOWED },
    { soql: "INSERT INTO Account", allowed: ALLOWED },
    { soql: "UPDATE Account SET x = 1", allowed: ALLOWED },
    { soql: "UPSERT Account", allowed: ALLOWED },
    { soql: "MERGE Account a b", allowed: ALLOWED },
    { soql: "UNDELETE Account", allowed: ALLOWED },
    // Mutation keyword hidden inside a string literal — must NOT trip the guard.
    { soql: "SELECT Id FROM Account WHERE Name = 'delete this'", allowed: ALLOWED },
    { soql: "SELECT Id FROM Account WHERE Name = 'from Lead'", allowed: ALLOWED },
    { soql: "SELECT Id FROM Account WHERE Name = 'it''s a DELETE'", allowed: ALLOWED },
    { soql: "SELECT Id FROM Account WHERE Name = 'a\\' INSERT b'", allowed: ALLOWED },
    // Not starting with SELECT.
    { soql: "FROM Account SELECT Id", allowed: ALLOWED },
    // Subqueries: child-relationship in SELECT list (skipped) vs WHERE semi-join.
    {
      soql: "SELECT Id, (SELECT Id FROM Contacts) FROM Account",
      allowed: ALLOWED,
    },
    {
      soql: "SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Lead)",
      allowed: ALLOWED,
    },
    // Already-limited / limit-in-literal.
    { soql: "SELECT Id FROM Account LIMIT 10", allowed: ALLOWED },
    { soql: "SELECT Id FROM Account WHERE Name = 'no LIMIT here'", allowed: ALLOWED },
  ];

  it.each(battery)("validateSOQL parity: %o", ({ soql, allowed }) => {
    // Clone the Set per call so a (hypothetical) input mutation by one validator
    // can't leak into the other and mask drift.
    const c = core.validateSOQL(soql, new Set(allowed));
    const p = plugin.validateSOQL(soql, new Set(allowed));
    // The accept/reject decision is the security-critical output and must never
    // diverge — that's the silent-skip failure mode this guard exists for.
    expect(c.valid).toBe(p.valid);
    // Both must agree on whether a rejection carries an error. The error WORDING
    // is intentionally allowed to differ (core references "the semantic layer",
    // the plugin references "catalog.yml" — each appropriate to its surface), so
    // we assert presence, not text.
    expect(Boolean(c.error)).toBe(Boolean(p.error));
  });

  it.each(battery)("appendSOQLLimit parity: %o", ({ soql }) => {
    expect(core.appendSOQLLimit(soql, 1000)).toBe(
      plugin.appendSOQLLimit(soql, 1000),
    );
  });
});
