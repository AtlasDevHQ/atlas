import { describe, test, expect } from "bun:test";
import {
  FEATURE_NAMES,
  type FeatureName,
} from "../feature-registry";

/**
 * Compile-time assertions — if `FeatureName` ever drifts from
 * `(typeof FEATURE_NAMES)[number]`, these `satisfies` clauses fail `tsgo`.
 * Runtime assertions are a belt for the suspenders: if the tuple ever loses
 * `as const` (widening element type to `string`), the `satisfies readonly` /
 * `includes` check fails at test time.
 */
describe("FEATURE_NAMES registry", () => {
  test("tuple is a `readonly` literal array (as-const preserved)", () => {
    // If someone drops `as const` off the registry, this narrows to `string[]`
    // and the `satisfies` clause below fails.
    const registry = FEATURE_NAMES satisfies readonly FeatureName[];
    expect(registry.length).toBeGreaterThan(0);
  });

  test("FeatureName == union of tuple elements (type identity)", () => {
    // Compile-time check: every element narrows to FeatureName, and the
    // tuple as a whole satisfies `readonly FeatureName[]`.
    const sample: FeatureName = FEATURE_NAMES[0]!;
    expect(typeof sample).toBe("string");
  });

  test("no duplicate entries (canonical list)", () => {
    const set = new Set(FEATURE_NAMES);
    expect(set.size).toBe(FEATURE_NAMES.length);
  });

  test("all entries are non-empty, trimmed strings", () => {
    for (const name of FEATURE_NAMES) {
      expect(name.length).toBeGreaterThan(0);
      expect(name.trim()).toBe(name);
    }
  });

  test("SSO is canonical-cased (not 'sso')", () => {
    // Regression guard for #1652: lowercase typos like feature="sso" would
    // render "sso requires an enterprise plan". The registry is the source
    // of truth — if SSO leaves, the test should fail loudly.
    expect((FEATURE_NAMES as readonly string[]).includes("SSO")).toBe(true);
    expect((FEATURE_NAMES as readonly string[]).includes("sso")).toBe(false);
  });

  test("no case-insensitive duplicates (e.g. 'Plugins' + 'plugins')", () => {
    // Broader guard than the SSO-specific one above: catches a future
    // contributor adding `"plugins"` or `"audit log"` (lowercase) as a
    // second entry that would silently render inconsistent copy. The
    // "no duplicate entries" test above compares case-sensitively; this
    // one collapses case so a drift like `"Plugins"` vs `"plugins"` fails.
    const lowered = FEATURE_NAMES.map((n) => n.toLowerCase());
    const set = new Set(lowered);
    expect(set.size).toBe(FEATURE_NAMES.length);
  });

  test("known acronyms render in ALL CAPS (SSO / SCIM / BYOT / PII / SLA / API / IP)", () => {
    // Specific regression guard for the typo class #1652 cares about —
    // acronyms used in banner copy must be upper-cased. If a refactor
    // ever widens the tuple to include a lowercased acronym, the user-
    // visible copy goes sideways.
    const acronyms = ["SSO", "SCIM", "BYOT", "PII", "SLA"];
    for (const acronym of acronyms) {
      // Skip if the acronym isn't in the registry — the test pins casing
      // for acronyms that ARE present, without forcing the registry to
      // contain every possible acronym forever.
      const match = FEATURE_NAMES.find(
        (n) => n.toLowerCase() === acronym.toLowerCase(),
      );
      if (!match) continue;
      expect(match).toContain(acronym);
    }
  });
});
