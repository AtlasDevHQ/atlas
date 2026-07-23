/**
 * Unit tests for the per-tier Knowledge Base cap seam (#4235).
 *
 * Covers the four things the slice promises: the `min(platform, tier)`
 * composition and which side it attributes; the fail-closed / fail-open arms of
 * tier resolution; that a self-hosted (`free`) workspace is untouched; and that
 * only a TIER-bound over-limit produces the 403 upgrade envelope.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { PlanTier } from "@useatlas/types";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

let PLATFORM = { docs: 1000, docBytes: 1_000_000, bundleBytes: 25_000_000 };
void mock.module("@atlas/api/lib/knowledge/ingest-limits", () => ({
  getIngestMaxDocs: () => PLATFORM.docs,
  getIngestMaxDocBytes: () => PLATFORM.docBytes,
  getIngestMaxBundleBytes: () => PLATFORM.bundleBytes,
}));

let DEPLOY_MODE: "saas" | "self-hosted" = "self-hosted";
void mock.module("@atlas/api/lib/effect/deploy-mode", () => ({
  resolveDeployMode: () => DEPLOY_MODE,
}));

let HAS_INTERNAL_DB = true;
let WORKSPACE: { plan_tier: PlanTier } | null = { plan_tier: "starter" };
let WORKSPACE_THROWS: Error | null = null;

void mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({ internalQuery: mock(async () => []) }),
  hasInternalDB: () => HAS_INTERNAL_DB,
}));
// Mock every value export — a partial `mock.module()` breaks other importers
// of the module (CLAUDE.md "mock all exports"). Only `getCachedWorkspace` is
// exercised; the rest are inert.
void mock.module("@atlas/api/lib/billing/enforcement", () => ({
  checkChatIntegrationLimitAndInstall: () => Promise.resolve({ allowed: true, rows: [] }),
  checkChatIntegrationLimit: () => Promise.resolve({ allowed: true }),
  checkKnowledgeCollectionLimitAndInstall: () => Promise.resolve({ allowed: true, rows: [] }),
  checkKnowledgeCollectionLimit: () => Promise.resolve({ allowed: true }),
  checkKnowledgeCollectionFanOutLimit: () => Promise.resolve({ allowed: true }),
  checkResourceLimit: () => Promise.resolve({ allowed: true }),
  checkPlanLimits: () => Promise.resolve({ allowed: true }),
  invalidatePlanCache: () => {},
  buildMetricStatus: () => ({ metric: "tokens", currentUsage: 0, limit: 0, usagePercent: 0, status: "ok" }),
  severityOf: () => 0,
  resolveAbuseCeilingPercent: () => Promise.resolve(null),
  resolveSpendPolicy: () => Promise.resolve("continue"),
  resolveUsageCeiling: () => Promise.resolve({ spendPolicy: "continue", ceilingPercent: null }),
  computeOverageDollars: () => 0,
  getTrialDaysRemaining: () => Promise.resolve(null),
  CHAT_INTEGRATION_COUNT_SQL: "SELECT 1",
  KNOWLEDGE_COLLECTION_COUNT_SQL: "SELECT 1",
  KNOWLEDGE_COLLECTION_FANOUT_COUNT_SQL: "SELECT 1",
  getCachedWorkspace: async () => {
    if (WORKSPACE_THROWS) throw WORKSPACE_THROWS;
    return WORKSPACE;
  },
}));
void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

const {
  assertIngestCapsFor,
  assertNotTierBound,
  capIsOperatorTunable,
  lowestTierAdmitting,
  minKnowledgeCap,
  resolveIngestCaps,
  resolveKnowledgeTierLimits,
} = await import("@atlas/api/lib/billing/knowledge-limits");
const { FeatureEntitlementError, BillingCheckFailedError } = await import(
  "@atlas/api/lib/effect/errors"
);

const ORG = "org-1";

beforeEach(() => {
  PLATFORM = { docs: 1000, docBytes: 1_000_000, bundleBytes: 25_000_000 };
  HAS_INTERNAL_DB = true;
  DEPLOY_MODE = "self-hosted";
  WORKSPACE = { plan_tier: "starter" };
  WORKSPACE_THROWS = null;
});
afterEach(() => {
  WORKSPACE_THROWS = null;
});

describe("minKnowledgeCap", () => {
  it("takes the smaller of the two", () => {
    expect(minKnowledgeCap(25_000_000, 10_000_000)).toBe(10_000_000);
    expect(minKnowledgeCap(10_000_000, 25_000_000)).toBe(10_000_000);
  });
  it("treats an unlimited tier limit as 'the platform ceiling governs'", () => {
    expect(minKnowledgeCap(25_000_000, -1)).toBe(25_000_000);
  });
  it("treats a zero tier limit as a real cap of zero, not unlimited", () => {
    // The `locked` churn tier: nothing may be ingested at all.
    expect(minKnowledgeCap(25_000_000, 0)).toBe(0);
  });
});

describe("lowestTierAdmitting", () => {
  it("names the cheapest tier above the current one that admits the value", () => {
    expect(lowestTierAdmitting("maxKnowledgeBundleBytes", 20_000_000, "starter")).toBe("pro");
    expect(lowestTierAdmitting("maxKnowledgeBundleBytes", 60_000_000, "starter")).toBe("business");
    expect(lowestTierAdmitting("maxKnowledgeDocsPerBundle", 400, "starter")).toBe("pro");
  });
  it("never names the current tier or a lower one", () => {
    expect(lowestTierAdmitting("maxKnowledgeDocsPerBundle", 900, "pro")).toBe("business");
    expect(lowestTierAdmitting("maxKnowledgeDocsPerBundle", 100, "pro")).toBe("business");
  });
  it("returns null when no higher tier admits the value", () => {
    // Beyond even Business — "upgrade" would be a lie, so the caller falls back
    // to a plain over-limit response.
    expect(lowestTierAdmitting("maxKnowledgeBundleBytes", 500_000_000, "business")).toBeNull();
    expect(lowestTierAdmitting("maxKnowledgeBundleBytes", 1, "business")).toBeNull();
  });
  it("treats an unlimited tier limit as admitting anything", () => {
    expect(lowestTierAdmitting("maxKnowledgeCollections", 9_999, "pro")).toBe("business");
  });

  it("offers the churn tier a real recovery target", () => {
    // `locked` ranks below every paid plan (PLAN_RANK -1), so the cheapest
    // resubscribe target must be named — a null here would leave a churned
    // customer with a 403 and no way forward.
    expect(lowestTierAdmitting("maxKnowledgeCollections", 1, "locked")).toBe("starter");
    expect(lowestTierAdmitting("maxKnowledgeDocsPerBundle", 100, "locked")).toBe("starter");
  });

  it("offers a trial workspace the starter tier", () => {
    expect(lowestTierAdmitting("maxKnowledgeDocsPerBundle", 200, "trial")).toBe("starter");
  });
});

describe("resolveKnowledgeTierLimits", () => {
  it("returns null with no orgId, the self-hosted sentinel, or no internal DB", async () => {
    expect(await resolveKnowledgeTierLimits(undefined)).toBeNull();
    expect(await resolveKnowledgeTierLimits("self-hosted")).toBeNull();
    HAS_INTERNAL_DB = false;
    expect(await resolveKnowledgeTierLimits(ORG)).toBeNull();
  });

  it("returns null for a workspace with no organization row (deliberate fail-open)", async () => {
    WORKSPACE = null;
    expect(await resolveKnowledgeTierLimits(ORG)).toBeNull();
  });

  it("returns null on the free tier OFF SaaS — the platform knob is the only cap there", async () => {
    DEPLOY_MODE = "self-hosted";
    WORKSPACE = { plan_tier: "free" };
    expect(await resolveKnowledgeTierLimits(ORG)).toBeNull();
  });

  it("fails CLOSED to starter on a SaaS `free` workspace — there is no SaaS free tier", async () => {
    // `organization.plan_tier` DEFAULTS to 'free', so a `free` row on SaaS
    // means trial provisioning never landed. Treating that as "no plan to
    // enforce" would hand a provisioning failure the raised SaaS ceiling
    // (100 MB / 5,000 docs) — strictly more than any paying tier gets.
    DEPLOY_MODE = "saas";
    WORKSPACE = { plan_tier: "free" };
    const ctx = await resolveKnowledgeTierLimits(ORG);
    expect(ctx?.tier).toBe("starter");
    expect(ctx?.limits.maxKnowledgeBundleBytes).toBe(10_000_000);
  });

  it("fails CLOSED on a workspace-lookup fault", async () => {
    WORKSPACE_THROWS = new Error("db down");
    await expect(resolveKnowledgeTierLimits(ORG)).rejects.toBeInstanceOf(BillingCheckFailedError);
  });

  it("resolves the tier's limits otherwise", async () => {
    WORKSPACE = { plan_tier: "pro" };
    const ctx = await resolveKnowledgeTierLimits(ORG);
    expect(ctx?.tier).toBe("pro");
    expect(ctx?.limits.maxKnowledgeDocsPerBundle).toBe(1_000);
  });
});

describe("resolveIngestCaps", () => {
  it("hands back the platform ceilings verbatim when no tier applies (self-hosted)", async () => {
    WORKSPACE = { plan_tier: "free" };
    const caps = await resolveIngestCaps(ORG);
    expect(caps.tier).toBeNull();
    expect(caps.maxDocs).toEqual({ value: 1000, boundBy: "platform" });
    expect(caps.maxBundleBytes).toEqual({ value: 25_000_000, boundBy: "platform" });
    expect(caps.maxDocBytes).toBe(1_000_000);
  });

  it("stamps the workspace it resolved FOR, so a seam can refuse another tenant's caps", async () => {
    const caps = await resolveIngestCaps(ORG);
    expect(caps.workspaceId).toBe(ORG);
    expect(() => assertIngestCapsFor(caps, ORG)).not.toThrow();
    expect(() => assertIngestCapsFor(caps, "org-2")).toThrow(/another tenant's plan limits/);
  });

  it("carries the resolved tier so the upgrade prompt never re-looks it up", async () => {
    WORKSPACE = { plan_tier: "pro" };
    expect((await resolveIngestCaps(ORG)).tier).toBe("pro");
  });

  it("clamps to the tier when the tier is lower, and says so", async () => {
    PLATFORM = { docs: 5_000, docBytes: 1_000_000, bundleBytes: 100_000_000 }; // the SaaS ceiling
    WORKSPACE = { plan_tier: "starter" };
    const caps = await resolveIngestCaps(ORG);
    expect(caps.maxDocs).toEqual({ value: 250, boundBy: "tier" });
    expect(caps.maxBundleBytes).toEqual({ value: 10_000_000, boundBy: "tier" });
  });

  it("clamps to the platform ceiling when the operator set it below the tier", async () => {
    PLATFORM = { docs: 100, docBytes: 1_000_000, bundleBytes: 1_000_000 };
    WORKSPACE = { plan_tier: "business" };
    const caps = await resolveIngestCaps(ORG);
    expect(caps.maxDocs).toEqual({ value: 100, boundBy: "platform" });
    expect(caps.maxBundleBytes).toEqual({ value: 1_000_000, boundBy: "platform" });
  });

  it("attributes a tie to the platform — an upgrade would gain nothing", async () => {
    PLATFORM = { docs: 1_000, docBytes: 1_000_000, bundleBytes: 25_000_000 };
    WORKSPACE = { plan_tier: "pro" }; // pro is exactly 1000 / 25 MB
    const caps = await resolveIngestCaps(ORG);
    expect(caps.maxDocs.boundBy).toBe("platform");
    expect(caps.maxBundleBytes.boundBy).toBe("platform");
  });

  it("never tiers the per-document byte cap — it is a guardrail, not a lever", async () => {
    WORKSPACE = { plan_tier: "starter" };
    expect((await resolveIngestCaps(ORG)).maxDocBytes).toBe(PLATFORM.docBytes);
    WORKSPACE = { plan_tier: "business" };
    expect((await resolveIngestCaps(ORG)).maxDocBytes).toBe(PLATFORM.docBytes);
  });

  it("collapses the locked churn tier to zero", async () => {
    WORKSPACE = { plan_tier: "locked" };
    const caps = await resolveIngestCaps(ORG);
    expect(caps.maxDocs).toEqual({ value: 0, boundBy: "tier" });
    expect(caps.maxBundleBytes).toEqual({ value: 0, boundBy: "tier" });
  });
});

describe("assertNotTierBound", () => {
  const base = {
    orgId: ORG,
    field: "maxKnowledgeDocsPerBundle",
    required: 400,
    limit: 250,
    noun: "documents in one bundle",
  } as const;

  it("is a no-op when the PLATFORM ceiling bound", () => {
    // Upgrading changes nothing — the operator's guardrail refused.
    expect(() => assertNotTierBound({ ...base, tier: "starter", boundBy: "platform" })).not.toThrow();
  });

  it("throws the 403 upgrade envelope when the TIER bound", () => {
    const err = (() => {
      try {
        assertNotTierBound({ ...base, tier: "starter", boundBy: "tier" });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(FeatureEntitlementError);
    const typed = err as InstanceType<typeof FeatureEntitlementError>;
    expect(typed.currentPlan).toBe("starter");
    expect(typed.requiredPlan).toBe("pro");
    expect(typed.feature).toBe("maxKnowledgeDocsPerBundle");
    expect(typed.message).toContain("250 documents in one bundle");
  });

  it("stays silent when no higher tier admits the value", () => {
    expect(() =>
      assertNotTierBound({ ...base, tier: "business", boundBy: "tier", required: 99_999, limit: 5_000 }),
    ).not.toThrow();
  });

  it("stays silent for a LOWER-BOUND `required` — no upgrade target is provable", () => {
    // The streamed-body path aborts AT the cap, so the true size is unknown.
    // Naming the next tier up would be a guess that a 500 MB body disproves.
    expect(() =>
      assertNotTierBound({ ...base, tier: "starter", boundBy: "tier", exact: false }),
    ).not.toThrow();
  });

  it("stays silent when no tier context produced the cap", () => {
    expect(() => assertNotTierBound({ ...base, tier: null, boundBy: "tier" })).not.toThrow();
  });

  it("never reads the workspace — it cannot fault, and cannot name a stale plan", () => {
    // The tier arrives with the cap; a second lookup could 503 or name a
    // different plan than the one whose limit is being quoted.
    WORKSPACE_THROWS = new Error("db down");
    expect(() => assertNotTierBound({ ...base, tier: "starter", boundBy: "platform" })).not.toThrow();
  });
});

describe("capIsOperatorTunable", () => {
  it("is true only for a platform-bound cap OFF SaaS", () => {
    DEPLOY_MODE = "self-hosted";
    expect(capIsOperatorTunable("platform")).toBe(true);
    expect(capIsOperatorTunable("tier")).toBe(false);
  });

  it("is false on SaaS even for a platform-bound cap", () => {
    // A hosted workspace admin cannot reach the settings registry, and the
    // SaaS ceiling IS the Business tier — so naming `ATLAS_KNOWLEDGE_INGEST_*`
    // sends them after a knob they can never turn.
    DEPLOY_MODE = "saas";
    expect(capIsOperatorTunable("platform")).toBe(false);
    expect(capIsOperatorTunable("tier")).toBe(false);
  });
});
