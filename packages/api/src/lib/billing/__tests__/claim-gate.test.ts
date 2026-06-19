/**
 * Tests for the claim-gated metering seam (ADR-0018 / #3651).
 *
 * The claim-gate withholds Atlas-token Q&A from an UNCLAIMED (metered) trial
 * Workspace — keyed on the owner's `emailVerified` bit — without touching Gate 0
 * (solvency) or the MCP `checksBilling` setup/query tools. These tests pin the
 * block-vs-allow matrix using the injectable-deps seam (no `mock.module`), so
 * the policy is exercised in isolation from the DB and config.
 */

import { describe, it, expect, spyOn } from "bun:test";
import { checkClaimGate, buildClaimUrl, ClaimRequiredError, ClaimCheckFailedError, type ClaimGateDeps } from "../claim-gate";
import { claimGateDecisions } from "@atlas/api/lib/metrics";
import type { PlanTier, WorkspaceRow } from "@atlas/api/lib/db/internal";

function workspace(tier: PlanTier): WorkspaceRow {
  return {
    id: "org-1",
    name: "Acme",
    slug: "acme",
    workspace_status: "active",
    plan_tier: tier,
    byot: false,
    stripe_customer_id: null,
    trial_ends_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    suspended_at: null,
    suspension_source: null,
    plan_override_until: null,
    deleted_at: null,
    region: null,
    region_assigned_at: null,
    createdAt: new Date().toISOString(),
  };
}

/** SaaS + internal-DB defaults with a configurable workspace/owner. */
function deps(overrides: Partial<ClaimGateDeps>): Partial<ClaimGateDeps> {
  return {
    getDeployMode: () => "saas",
    hasInternalDB: () => true,
    getWorkspace: async () => workspace("trial"),
    getOwnerVerification: async () => ({ emailVerified: false, email: "owner@acme.com" }),
    buildClaimUrl: (email) => `https://app.useatlas.dev/signup${email ? `?email=${email}` : ""}`,
    ...overrides,
  };
}

describe("checkClaimGate — block-vs-allow matrix", () => {
  it("BLOCKS an unclaimed (owner emailVerified=false) SaaS trial with claim_required", async () => {
    const result = await checkClaimGate("org-1", deps({}));
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toBe("claim_required");
    if (result.reason !== "claim_required") throw new Error("unreachable");
    expect(result.claimUrl).toContain("/signup");
    expect(result.claimUrl).toContain("owner@acme.com");
  });

  it("ALLOWS once the owner's email is verified (claimed)", async () => {
    const result = await checkClaimGate(
      "org-1",
      deps({ getOwnerVerification: async () => ({ emailVerified: true, email: "owner@acme.com" }) }),
    );
    expect(result.allowed).toBe(true);
  });

  it("ALLOWS a paid tier even with an unverified owner (never metered)", async () => {
    for (const tier of ["starter", "pro", "business", "locked", "free"] as const) {
      const result = await checkClaimGate("org-1", deps({ getWorkspace: async () => workspace(tier) }));
      expect(result.allowed).toBe(true);
    }
  });

  it("ALLOWS off-SaaS (self-hosted) regardless of verification", async () => {
    const result = await checkClaimGate("org-1", deps({ getDeployMode: () => "self-hosted" }));
    expect(result.allowed).toBe(true);
  });

  it("ALLOWS when there is no internal DB", async () => {
    const result = await checkClaimGate("org-1", deps({ hasInternalDB: () => false }));
    expect(result.allowed).toBe(true);
  });

  it("ALLOWS when no org is bound (self-hosted / CLI)", async () => {
    const result = await checkClaimGate(undefined, deps({}));
    expect(result.allowed).toBe(true);
  });

  it("ALLOWS when the workspace row is absent (pre-migration)", async () => {
    const result = await checkClaimGate("org-1", deps({ getWorkspace: async () => null }));
    expect(result.allowed).toBe(true);
  });

  it("ALLOWS when no owner membership row exists (defensive)", async () => {
    const result = await checkClaimGate("org-1", deps({ getOwnerVerification: async () => null }));
    expect(result.allowed).toBe(true);
  });

  it("fails CLOSED (check_failed) when the owner lookup throws — no token spend on an unverifiable workspace", async () => {
    const result = await checkClaimGate(
      "org-1",
      deps({
        getOwnerVerification: async () => {
          throw new Error("db down");
        },
      }),
    );
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toBe("check_failed");
  });

  it("fails CLOSED (check_failed) when the workspace lookup throws", async () => {
    const result = await checkClaimGate(
      "org-1",
      deps({
        getWorkspace: async () => {
          throw new Error("db down");
        },
      }),
    );
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reason).toBe("check_failed");
  });
});

describe("ClaimRequiredError", () => {
  it("carries the claim URL and a 403 / claim_required code", () => {
    const err = new ClaimRequiredError("https://app.useatlas.dev/signup");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ClaimRequiredError");
    expect(err.errorCode).toBe("claim_required");
    expect(err.httpStatus).toBe(403);
    expect(err.claimUrl).toBe("https://app.useatlas.dev/signup");
    expect(err.message).toContain("https://app.useatlas.dev/signup");
  });
});

// #3796 — every real SaaS claim decision increments a counter so the
// withheld-vs-served ratio is graphable. Spy on the singleton counter's `.add`
// (works under the no-op meter, which exposes no value).
describe("decision metric (#3796)", () => {
  it("counts a withheld trial as outcome=claim_required", async () => {
    const add = spyOn(claimGateDecisions, "add");
    try {
      await checkClaimGate("org-1", deps({}));
      expect(add).toHaveBeenCalledWith(1, { outcome: "claim_required" });
    } finally {
      add.mockRestore();
    }
  });

  it("counts a claimed trial as outcome=allowed", async () => {
    const add = spyOn(claimGateDecisions, "add");
    try {
      await checkClaimGate(
        "org-1",
        deps({ getOwnerVerification: async () => ({ emailVerified: true, email: "o@acme.com" }) }),
      );
      expect(add).toHaveBeenCalledWith(1, { outcome: "allowed" });
    } finally {
      add.mockRestore();
    }
  });

  it("counts a lookup failure as outcome=check_failed", async () => {
    const add = spyOn(claimGateDecisions, "add");
    try {
      await checkClaimGate(
        "org-1",
        deps({ getOwnerVerification: async () => { throw new Error("db blip"); } }),
      );
      expect(add).toHaveBeenCalledWith(1, { outcome: "check_failed" });
    } finally {
      add.mockRestore();
    }
  });

  it("does NOT count the non-SaaS short-circuit (not a metering decision)", async () => {
    const add = spyOn(claimGateDecisions, "add");
    try {
      await checkClaimGate("org-1", deps({ getDeployMode: () => "self-hosted" }));
      await checkClaimGate(undefined, deps({}));
      await checkClaimGate("org-1", deps({ hasInternalDB: () => false }));
      expect(add).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
    }
  });
});

describe("ClaimCheckFailedError", () => {
  it("is a retryable 503 / claim_check_failed with no claim URL", () => {
    const err = new ClaimCheckFailedError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ClaimCheckFailedError");
    expect(err.errorCode).toBe("claim_check_failed");
    expect(err.httpStatus).toBe(503);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("try again");
  });
});

describe("buildClaimUrl", () => {
  it("returns a relative /signup path when no web origin is configured", () => {
    // No ATLAS_CORS_ORIGIN / BETTER_AUTH_TRUSTED_ORIGINS in the test env.
    const url = buildClaimUrl();
    expect(url.endsWith("/signup")).toBe(true);
  });

  it("encodes the email into the path when no origin is configured", () => {
    const url = buildClaimUrl("a+b@acme.com");
    expect(url).toContain("/signup?email=");
    expect(url).toContain(encodeURIComponent("a+b@acme.com"));
  });
});
