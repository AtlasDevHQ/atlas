/**
 * Tests for the claim-gated metering seam (ADR-0018 / #3651).
 *
 * The claim-gate withholds Atlas-token Q&A from an UNCLAIMED (metered) trial
 * Workspace — keyed on the owner's `emailVerified` bit — without touching Gate 0
 * (solvency) or the MCP `checksBilling` setup/query tools. These tests pin the
 * block-vs-allow matrix using the injectable-deps seam (no `mock.module`), so
 * the policy is exercised in isolation from the DB and config.
 */

import { describe, it, expect } from "bun:test";
import { checkClaimGate, buildClaimUrl, ClaimRequiredError, type ClaimGateDeps } from "../claim-gate";
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
  it("BLOCKS an unclaimed (owner emailVerified=false) SaaS trial", async () => {
    const result = await checkClaimGate("org-1", deps({}));
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
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

  it("fails OPEN (allows) when the owner lookup throws — metering refinement, Gate 0 owns solvency (#3428)", async () => {
    const result = await checkClaimGate(
      "org-1",
      deps({
        getOwnerVerification: async () => {
          throw new Error("db down");
        },
      }),
    );
    expect(result.allowed).toBe(true);
  });

  it("fails OPEN (allows) when the workspace lookup throws", async () => {
    const result = await checkClaimGate(
      "org-1",
      deps({
        getWorkspace: async () => {
          throw new Error("db down");
        },
      }),
    );
    expect(result.allowed).toBe(true);
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
