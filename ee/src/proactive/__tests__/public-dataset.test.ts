/**
 * Pure unit tests for `isEntityAllowed` — the join-strict allowlist
 * decision behind the proactive public-dataset gate (#2297). No DB,
 * no Effect runtime: every assertion is against an in-memory
 * allowlist array.
 *
 * These tests pin the contract every listener-side caller and admin
 * preview endpoint depends on: given a workspace allowlist, decide
 * whether a question that touches `entityName` (with optional metric
 * names) is allowed under the HITL semantics from issue #2297.
 */

import { describe, expect, it } from "bun:test";
import {
  isEntityAllowed,
  type PublicDatasetEntry,
} from "../public-dataset";

function entry(
  overrides: Partial<PublicDatasetEntry> & { entityName: string },
): PublicDatasetEntry {
  return {
    entityName: overrides.entityName,
    denyMetrics: overrides.denyMetrics ?? [],
  };
}

describe("isEntityAllowed", () => {
  it("refuses when the allowlist is empty", () => {
    const decision = isEntityAllowed([], "marketing.users", []);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.kind).toBe("entity-not-in-allowlist");
    }
  });

  it("refuses when the entity is missing from a non-empty allowlist", () => {
    const allowlist = [entry({ entityName: "marketing.users" })];
    const decision = isEntityAllowed(allowlist, "finance.revenue", []);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.kind).toBe("entity-not-in-allowlist");
    }
  });

  it("allows when the entity is on the allowlist with no deny metrics", () => {
    const allowlist = [entry({ entityName: "marketing.users" })];
    const decision = isEntityAllowed(allowlist, "marketing.users", [
      "signup_date",
      "email",
    ]);
    expect(decision.allowed).toBe(true);
  });

  it("allows when the metrics list is empty regardless of denyMetrics", () => {
    const allowlist = [
      entry({ entityName: "marketing.users", denyMetrics: ["email"] }),
    ];
    // Empty metrics list — the caller didn't report any touched
    // metrics, so the deny check has nothing to fire on.
    const decision = isEntityAllowed(allowlist, "marketing.users", []);
    expect(decision.allowed).toBe(true);
  });

  it("refuses when any touched metric overlaps with denyMetrics", () => {
    const allowlist = [
      entry({ entityName: "marketing.users", denyMetrics: ["email"] }),
    ];
    const decision = isEntityAllowed(allowlist, "marketing.users", [
      "signup_date",
      "email",
    ]);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed && decision.kind === "metric-denied") {
      // Post-1.5.0 polish: tagged union exposes `metric` directly
      // (was packed into `deniedReason: "metric-denied:${metric}"`).
      expect(decision.metric).toBe("email");
    }
  });

  it("allows when touched metrics share no overlap with denyMetrics", () => {
    const allowlist = [
      entry({
        entityName: "marketing.users",
        denyMetrics: ["email", "phone_number"],
      }),
    ];
    const decision = isEntityAllowed(allowlist, "marketing.users", [
      "signup_date",
      "country",
    ]);
    expect(decision.allowed).toBe(true);
  });

  it("treats schema-qualified entity names as distinct", () => {
    const allowlist = [entry({ entityName: "marketing.users" })];
    const decision = isEntityAllowed(allowlist, "core.users", []);
    expect(decision.allowed).toBe(false);
    // Strict per HITL decision: the fully-qualified name is the key.
  });

  it("refuses the first denied metric it finds (deterministic via array order)", () => {
    const allowlist = [
      entry({
        entityName: "marketing.users",
        denyMetrics: ["email", "phone_number"],
      }),
    ];
    const decision = isEntityAllowed(allowlist, "marketing.users", [
      "phone_number",
      "email",
    ]);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed && decision.kind === "metric-denied") {
      // Caller order — first metric to overlap wins.
      expect(decision.metric).toBe("phone_number");
    }
  });
});

describe("isEntityAllowed — cross-entity join semantics (listener-level)", () => {
  // The listener walks every touched entity and calls `isEntityAllowed`
  // per entity. These tests pin the per-entity decision matrix that
  // produces the listener's join-strict refusal behaviour:
  //
  //   revenue allowlisted, customers NOT allowlisted → second call refuses.
  it("permits the allowlisted half of a join", () => {
    const allowlist = [entry({ entityName: "finance.revenue" })];
    expect(isEntityAllowed(allowlist, "finance.revenue", []).allowed).toBe(true);
  });

  it("refuses the un-allowlisted half of a join (strict default)", () => {
    const allowlist = [entry({ entityName: "finance.revenue" })];
    // Even though revenue is allowed, the second walked entity
    // (customers) refuses, which the listener uses as the "whole
    // query refuses" signal.
    expect(isEntityAllowed(allowlist, "finance.customers", []).allowed).toBe(
      false,
    );
  });
});
