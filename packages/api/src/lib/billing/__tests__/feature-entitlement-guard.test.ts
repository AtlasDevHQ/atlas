/**
 * Tests for the request-time feature-entitlement guard (WS1 of #3986).
 *
 * Asserts the external enforcement behavior at the guard boundary: given a
 * workspace's resolved tier, does the guard pass, deny with the upgrade error,
 * or fail closed. Mirrors the enforcement-posture cases in `enforcement.test.ts`
 * (self-hosted pass, lookup-error fail-closed, operator bypass).
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";
import type { PlanTier } from "@useatlas/types";

// --- Mocks ---

let mockHasInternalDB = true;
let mockDeployMode: "saas" | "self-hosted" = "saas";
let mockEntitlement: { planTier: PlanTier | null; isOperator: boolean } = {
  planTier: "business",
  isOperator: false,
};
let mockEntitlementShouldThrow = false;
let mockEntitlementCallCount = 0;

const actualInternal = await import("@atlas/api/lib/db/internal");
void mock.module("@atlas/api/lib/db/internal", () => ({
  ...actualInternal,
  hasInternalDB: () => mockHasInternalDB,
}));

const actualDeployMode = await import("@atlas/api/lib/effect/deploy-mode");
void mock.module("@atlas/api/lib/effect/deploy-mode", () => ({
  ...actualDeployMode,
  resolveDeployMode: () => mockDeployMode,
}));

void mock.module(
  "@atlas/api/lib/integrations/install/workspace-entitlement",
  () => ({
    getWorkspaceEntitlement: async () => {
      mockEntitlementCallCount++;
      if (mockEntitlementShouldThrow) throw new Error("internal db error");
      return mockEntitlement;
    },
  }),
);

const { requireFeatureEntitlement } = await import(
  "../feature-entitlement-guard"
);

beforeEach(() => {
  mockHasInternalDB = true;
  mockDeployMode = "saas";
  mockEntitlement = { planTier: "business", isOperator: false };
  mockEntitlementShouldThrow = false;
  mockEntitlementCallCount = 0;
});

/** Run the guard and return its Exit for inspection. */
async function runGuard(orgId: string | undefined) {
  return Effect.runPromiseExit(requireFeatureEntitlement(orgId, "sso"));
}

/** Extract the failure value from a failed Exit, or undefined. */
function failureOf(exit: Exit.Exit<void, unknown>): unknown {
  if (Exit.isFailure(exit)) {
    const opt = Cause.failureOption(exit.cause);
    return Option.isSome(opt) ? opt.value : undefined;
  }
  return undefined;
}

describe("requireFeatureEntitlement — non-SaaS deploy mode", () => {
  it("passes (no-op) on a self-hosted deploy even with a below-tier org", async () => {
    // A self-hosted enterprise build has its workspaces on `free`; the per-tier
    // ladder must not fire there or SSO would be wrongly denied. The enterprise
    // license Tag is what gates the feature in that topology.
    mockDeployMode = "self-hosted";
    mockEntitlement = { planTier: "free", isOperator: false };
    const exit = await runGuard("org_selfhosted");
    expect(Exit.isSuccess(exit)).toBe(true);
    // Must not even attempt a workspace lookup off the SaaS path.
    expect(mockEntitlementCallCount).toBe(0);
  });
});

describe("requireFeatureEntitlement — self-hosted / no billing context", () => {
  it("passes when no internal DB is configured (self-hosted)", async () => {
    mockHasInternalDB = false;
    const exit = await runGuard("org_123");
    expect(Exit.isSuccess(exit)).toBe(true);
    // Must not even attempt a workspace lookup on self-hosted.
    expect(mockEntitlementCallCount).toBe(0);
  });

  it("passes for the `self-hosted` sentinel orgId", async () => {
    const exit = await runGuard("self-hosted");
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mockEntitlementCallCount).toBe(0);
  });

  it("passes when orgId is undefined", async () => {
    const exit = await runGuard(undefined);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(mockEntitlementCallCount).toBe(0);
  });
});

describe("requireFeatureEntitlement — tier gating", () => {
  it("allows a Business workspace (SSO unlocked)", async () => {
    mockEntitlement = { planTier: "business", isOperator: false };
    const exit = await runGuard("org_biz");
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("denies a below-tier workspace with FeatureEntitlementError (403 upgrade)", async () => {
    mockEntitlement = { planTier: "pro", isOperator: false };
    const exit = await runGuard("org_pro");
    expect(Exit.isFailure(exit)).toBe(true);
    const err = failureOf(exit) as {
      _tag: string;
      requiredPlan: string;
      currentPlan: string;
      feature: string;
    };
    expect(err._tag).toBe("FeatureEntitlementError");
    expect(err.requiredPlan).toBe("business");
    expect(err.currentPlan).toBe("pro");
    expect(err.feature).toBe("sso");
  });

  it("denies a Starter workspace", async () => {
    mockEntitlement = { planTier: "starter", isOperator: false };
    const exit = await runGuard("org_starter");
    expect(Exit.isFailure(exit)).toBe(true);
    expect((failureOf(exit) as { _tag: string })._tag).toBe(
      "FeatureEntitlementError",
    );
  });

  it("collapses a null tier (row not found / legacy) to `free` in the upgrade body", async () => {
    mockEntitlement = { planTier: null, isOperator: false };
    const exit = await runGuard("org_unknown");
    const err = failureOf(exit) as { _tag: string; currentPlan: string };
    expect(err._tag).toBe("FeatureEntitlementError");
    expect(err.currentPlan).toBe("free");
  });

  it("denies the `locked` churn tier (fails closed)", async () => {
    mockEntitlement = { planTier: "locked", isOperator: false };
    const exit = await runGuard("org_locked");
    expect(Exit.isFailure(exit)).toBe(true);
    expect((failureOf(exit) as { _tag: string })._tag).toBe(
      "FeatureEntitlementError",
    );
  });
});

describe("requireFeatureEntitlement — operator bypass", () => {
  it("allows an operator workspace regardless of tier", async () => {
    mockEntitlement = { planTier: "free", isOperator: true };
    const exit = await runGuard("org_operator");
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("requireFeatureEntitlement — fail-closed on lookup error", () => {
  it("fails closed with BillingCheckFailedError (503) when the lookup throws", async () => {
    mockEntitlementShouldThrow = true;
    const exit = await runGuard("org_err");
    expect(Exit.isFailure(exit)).toBe(true);
    const err = failureOf(exit) as { _tag: string; message: string };
    expect(err._tag).toBe("BillingCheckFailedError");
    // Must NOT tell the user to upgrade — this is a transient fault, so the
    // message says "try again", not "upgrade to <tier>".
    expect(err.message.toLowerCase()).toContain("try again");
    expect(err.message.toLowerCase()).not.toContain("upgrade");
  });
});
