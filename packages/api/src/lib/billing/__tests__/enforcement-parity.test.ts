/**
 * Unit tests for the enforcement-leg parity check (WS1/WS4 of #3984 / #3997).
 *
 * This is the third leg of the pricing-parity guard: that every gated feature
 * in the entitlement SSOT is actually consulted by a route-layer
 * `requireFeatureEntitlement` gate (or explicitly recorded as not-yet-wired in
 * ENFORCEMENT_PENDING). #3996 covered SSOT ↔ marketing-artifact; these assert
 * the SSOT ↔ enforcement leg at the module boundary.
 *
 * The acceptance criterion — "fails on an injected mismatch; passes when
 * aligned (unit test proves both)" — is met by feeding the pure
 * `checkEnforcementParity` synthetic inputs: an aligned triple returns no
 * findings; each class of drift returns the matching finding. The live wiring
 * (the source scan + the committed pending allowlist agreeing with the real
 * tree) is exercised separately by the adversarial fixture
 * `scripts/__tests__/check-enforcement-parity.test.sh`.
 */

import { describe, expect, it } from "bun:test";
import {
  FEATURE_ENTITLEMENTS,
  type GatedFeature,
} from "../feature-entitlement";
import {
  ENFORCEMENT_PENDING,
  checkEnforcementParity,
  extractEnforcedFeatures,
  type EnforcementParityFinding,
} from "../enforcement-parity";

const ALL_FEATURES = Object.keys(FEATURE_ENTITLEMENTS) as GatedFeature[];

// A small synthetic SSOT + pending pair, independent of the live maps, so the
// pure-function tests pin behavior without coupling to the current wiring
// snapshot (which shifts as WS1 gates land).
const SSOT = { sso: "business", scim: "business", masking: "business" } as const;

function kinds(findings: EnforcementParityFinding[]): string[] {
  return findings.map((f) => `${f.kind}:${f.feature}`).sort();
}

describe("checkEnforcementParity — aligned (passes)", () => {
  it("returns no findings when every SSOT feature is enforced or pending", () => {
    const findings = checkEnforcementParity(
      ["sso"], // enforced
      SSOT,
      { scim: "#x", masking: "#y" }, // pending covers the rest
    );
    expect(findings).toEqual([]);
  });

  it("returns no findings when every SSOT feature is enforced (empty pending)", () => {
    const findings = checkEnforcementParity(
      ["sso", "scim", "masking"],
      SSOT,
      {},
    );
    expect(findings).toEqual([]);
  });
});

describe("checkEnforcementParity — injected mismatch (fails)", () => {
  it("flags a SSOT feature that is neither enforced nor pending (the open ladder)", () => {
    // `masking` is sold tier-gated by the SSOT but has no gate and no pending
    // entry — the exact regression the guard exists to catch.
    const findings = checkEnforcementParity(["sso"], SSOT, { scim: "#x" });
    expect(kinds(findings)).toEqual(["ungated:masking"]);
    expect(findings[0].message).toContain("no route consults");
  });

  it("flags every ungated, unacknowledged feature", () => {
    const findings = checkEnforcementParity(["sso"], SSOT, {});
    expect(kinds(findings)).toEqual(["ungated:masking", "ungated:scim"]);
  });

  it("flags a feature that is enforced but still listed pending (stale-pending)", () => {
    // `scim` got its gate wired but the allowlist wasn't pruned — forces the
    // list to shrink as gates land.
    const findings = checkEnforcementParity(
      ["sso", "scim"],
      SSOT,
      { scim: "#x", masking: "#y" },
    );
    expect(kinds(findings)).toEqual(["stale-pending:scim"]);
  });

  it("flags a pending entry for a feature not in the SSOT (phantom-pending)", () => {
    const findings = checkEnforcementParity(
      ["sso", "scim", "masking"],
      SSOT,
      { ghost_feature: "#x" },
    );
    expect(kinds(findings)).toEqual(["phantom-pending:ghost_feature"]);
  });

  it("reports multiple distinct drifts at once", () => {
    const findings = checkEnforcementParity(
      ["sso", "scim"], // scim enforced
      SSOT,
      { scim: "#x", ghost: "#y" }, // scim stale, ghost phantom, masking ungated
    );
    expect(kinds(findings)).toEqual([
      "phantom-pending:ghost",
      "stale-pending:scim",
      "ungated:masking",
    ]);
  });
});

describe("extractEnforcedFeatures — the source scan parser", () => {
  it("extracts the feature id from a requireFeatureEntitlement call", () => {
    const src = `yield* requireFeatureEntitlement(orgId, "sso");`;
    expect([...extractEnforcedFeatures(src)]).toEqual(["sso"]);
  });

  it("dedupes repeated call sites and finds multiple features", () => {
    const src = `
      requireFeatureEntitlement(orgId, "sso");
      requireFeatureEntitlement(a, 'scim');
      requireFeatureEntitlement(orgId, "sso");
    `;
    expect([...extractEnforcedFeatures(src)].sort()).toEqual(["scim", "sso"]);
  });

  it("matches underscore feature ids (white_label, audit_retention, …)", () => {
    // The SSOT keys include snake_case ids; pin that the [a-z_]+ char class
    // actually captures them, so a future narrowing to [a-z]+ fails here
    // directly rather than only surfacing via the live-tree test below.
    const src = `requireFeatureEntitlement(orgId, "white_label");`;
    expect([...extractEnforcedFeatures(src)]).toEqual(["white_label"]);
  });

  it("ignores non-matching text", () => {
    const src = `const x = "sso"; // not a gate call`;
    expect([...extractEnforcedFeatures(src)]).toEqual([]);
  });
});

describe("ENFORCEMENT_PENDING + live SSOT — the committed allowlist is honest", () => {
  it("only lists real SSOT features (no phantom entries against the live map)", () => {
    // Independent of the source scan: every committed pending key must be a
    // real GatedFeature. (The full live-tree parity is the fixture script's
    // job; this catches a typo'd key in the allowlist on its own.)
    for (const key of Object.keys(ENFORCEMENT_PENDING)) {
      expect(ALL_FEATURES).toContain(key as GatedFeature);
    }
  });

  it("the live SSOT ∪ enforced(sso) ∪ pending leaves no ungated feature", () => {
    // Treat sso as the known-wired feature (its call sites are in admin-sso.ts)
    // and assert the committed ENFORCEMENT_PENDING covers every other SSOT
    // feature — i.e. the committed allowlist is complete *today*. This is the
    // assertion that breaks the moment someone adds a feature to the SSOT
    // without either gating it or recording it pending.
    //
    // EXTEND THIS LIST as gates land: when a feature's route gate ships (e.g.
    // scim under #3987) and is removed from ENFORCEMENT_PENDING, add its id
    // here — otherwise this test goes red (the feature reads as ungated). That
    // coupling is deliberate: the unit test tracks the real wiring snapshot,
    // and the live-tree fixture (check-enforcement-parity.test.sh) covers the
    // actual route scan.
    const enforcedToday = ["sso"];
    const findings = checkEnforcementParity(enforcedToday);
    expect(findings).toEqual([]);
  });
});
