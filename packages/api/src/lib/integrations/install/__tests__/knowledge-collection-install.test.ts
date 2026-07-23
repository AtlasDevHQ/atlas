/**
 * Unit tests for the three knowledge-collection install gates (#4235): the
 * pre-write {@link assertCollectionInstallable}, its fan-out sibling
 * {@link assertCollectionBatchInstallable}, and the atomic
 * {@link upsertKnowledgeCollectionRow}.
 *
 * The point of all three is the DISPOSITION: a genuine cap hit must surface the
 * standard 403 `plan_upgrade_required` envelope naming a real upgrade target
 * and the tier that actually set the cap, while an inability to DETERMINE the
 * count must fail closed as a transient 503 — never a misleading "upgrade your
 * plan".
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { PlanTier, WorkspaceId } from "@useatlas/types";
import { buildInternalDbMockDefaults } from "@atlas/api/__mocks__/api-test-mocks";

type LimitResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: "cap_reached";
      errorMessage: string;
      limit: number;
      tier: PlanTier;
    }
  | { allowed: false; reason: "check_failed"; errorMessage: string };

let PRECHECK: LimitResult = { allowed: true };
let FANOUT: LimitResult = { allowed: true };
/** How many times the BATCH cap check ran — pins "once per install, not per slug". */
let fanoutCalls = 0;
let INSTALL: LimitResult | { allowed: true; rows: Array<{ id: string }> } = {
  allowed: true,
  rows: [{ id: "row-1" }],
};

/** Rows the cross-catalog slug guard sees; empty = slug is free. */
let CROSS_CATALOG_ROWS: Array<{ catalog_id: string }> = [];
const internalQuery = mock(async () => CROSS_CATALOG_ROWS);

void mock.module("@atlas/api/lib/db/internal", () =>
  buildInternalDbMockDefaults({ internalQuery }),
);

// Mock every value export — a partial `mock.module()` breaks other importers of
// the module (CLAUDE.md "mock all exports"). The three knowledge entries are
// what this suite drives; the rest are inert.
void mock.module("@atlas/api/lib/billing/enforcement", () => ({
  checkKnowledgeCollectionLimit: async () => PRECHECK,
  checkKnowledgeCollectionFanOutLimit: async () => {
    fanoutCalls++;
    return FANOUT;
  },
  checkKnowledgeCollectionLimitAndInstall: async () => INSTALL,
  checkChatIntegrationLimitAndInstall: () => Promise.resolve({ allowed: true, rows: [] }),
  checkChatIntegrationLimit: () => Promise.resolve({ allowed: true }),
  checkResourceLimit: () => Promise.resolve({ allowed: true }),
  checkPlanLimits: () => Promise.resolve({ allowed: true }),
  getCachedWorkspace: () => Promise.resolve(null),
  invalidatePlanCache: () => {},
  buildMetricStatus: () => ({
    metric: "tokens",
    currentUsage: 0,
    limit: 0,
    usagePercent: 0,
    status: "ok",
  }),
  severityOf: () => 0,
  resolveAbuseCeilingPercent: () => Promise.resolve(null),
  resolveSpendPolicy: () => Promise.resolve("continue"),
  resolveUsageCeiling: () => Promise.resolve({ spendPolicy: "continue", ceilingPercent: null }),
  computeOverageDollars: () => 0,
  getTrialDaysRemaining: () => Promise.resolve(null),
  CHAT_INTEGRATION_COUNT_SQL: "SELECT 1",
  KNOWLEDGE_COLLECTION_COUNT_SQL: "SELECT 1",
  KNOWLEDGE_COLLECTION_FANOUT_COUNT_SQL: "SELECT 1",
}));

// The gates take the tier off the DENIAL rather than re-resolving it, so only
// the upgrade-target lookup matters here. Every value export is listed
// (mock-all-exports); the rest are inert.
void mock.module("@atlas/api/lib/billing/knowledge-limits", () => ({
  lowestTierAdmitting: (_field: string, _required: number, current: PlanTier) =>
    current === "starter" ? "pro" : null,
  resolveKnowledgeTierLimits: async () => null,
  resolveIngestCaps: async () => ({
    workspaceId: "org-1",
    tier: null,
    maxDocs: { value: 1000, boundBy: "platform" },
    maxBundleBytes: { value: 25_000_000, boundBy: "platform" },
    maxDocBytes: 1_000_000,
  }),
  assertIngestCapsFor: () => {},
  assertNotTierBound: () => {},
  minKnowledgeCap: (a: number, b: number) => (b === -1 ? a : Math.min(a, b)),
  capIsOperatorTunable: () => false,
}));

void mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

const {
  assertCollectionBatchInstallable,
  assertCollectionInstallable,
  upsertKnowledgeCollectionRow,
} = await import("@atlas/api/lib/integrations/install/knowledge-collection-install");
const { FormInstallValidationError } = await import(
  "@atlas/api/lib/integrations/install/email-form-handler"
);
const { BillingCheckFailedError, FeatureEntitlementError } = await import(
  "@atlas/api/lib/effect/errors"
);

const WORKSPACE = "org-1" as WorkspaceId;
const CATALOG = "catalog:okf-upload";
const noopLog = { error: () => {}, info: () => {} };

const capReached = (limit: number, tier: PlanTier): LimitResult => ({
  allowed: false,
  reason: "cap_reached",
  errorMessage: "nope",
  limit,
  tier,
});

beforeEach(() => {
  PRECHECK = { allowed: true };
  FANOUT = { allowed: true };
  fanoutCalls = 0;
  INSTALL = { allowed: true, rows: [{ id: "row-1" }] };
  CROSS_CATALOG_ROWS = [];
  internalQuery.mockClear();
});

describe("assertCollectionInstallable", () => {
  it("passes when the slug is free and the tier has room", async () => {
    await expect(
      assertCollectionInstallable(WORKSPACE, "docs", CATALOG, noopLog),
    ).resolves.toBeUndefined();
  });

  it("rejects a slug owned by another knowledge catalog with a field-level 400", async () => {
    CROSS_CATALOG_ROWS = [{ catalog_id: "catalog:bundle-sync" }];
    const err = await assertCollectionInstallable(WORKSPACE, "docs", CATALOG, noopLog).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FormInstallValidationError);
  });

  it("checks the slug BEFORE the cap — a taken slug is a 400, not an upgrade prompt", async () => {
    CROSS_CATALOG_ROWS = [{ catalog_id: "catalog:bundle-sync" }];
    PRECHECK = capReached(1, "starter");
    const err = await assertCollectionInstallable(WORKSPACE, "docs", CATALOG, noopLog).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FormInstallValidationError);
  });

  it("turns a cap hit into the 403 upgrade envelope naming a real target", async () => {
    PRECHECK = capReached(1, "starter");
    const err = await assertCollectionInstallable(WORKSPACE, "docs", CATALOG, noopLog).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FeatureEntitlementError);
    const typed = err as InstanceType<typeof FeatureEntitlementError>;
    expect(typed.currentPlan).toBe("starter");
    expect(typed.requiredPlan).toBe("pro");
    expect(typed.message).toContain("1 knowledge collection");
  });

  it("names the tier carried on the DENIAL, never a re-resolved one", async () => {
    // The whole point of `ResourceLimitResult.tier`: the plan quoted in the
    // message is provably the plan whose cap was enforced. A second lookup
    // could return a different tier (60s per-replica cache) and tell a Pro
    // customer they are on `free`.
    PRECHECK = capReached(3, "pro");
    const err = await assertCollectionInstallable(WORKSPACE, "docs", CATALOG, noopLog).catch(
      (e: unknown) => e,
    );
    const typed = err as InstanceType<typeof FeatureEntitlementError>;
    expect(typed.currentPlan).toBe("pro");
    expect(typed.message).toContain('Your "pro" plan');
    expect(typed.message).toContain("3 knowledge collections");
    // No plan admits more in this stub, so the top plan is the honest answer.
    expect(typed.requiredPlan).toBe("business");
  });

  it("never leaks the internal workspace id into the customer-facing message", async () => {
    // Correlation is `requestId`'s job; the id is on the structured log line.
    PRECHECK = capReached(1, "starter");
    const err = await assertCollectionInstallable(WORKSPACE, "docs", CATALOG, noopLog).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).not.toContain(WORKSPACE);
  });

  it("fails CLOSED as a 503 when the count could not be determined", async () => {
    // NOT a 403 "upgrade": we don't know the count, so telling the customer to
    // buy a bigger plan would be a guess.
    PRECHECK = { allowed: false, reason: "check_failed", errorMessage: "try again" };
    const err = await assertCollectionInstallable(WORKSPACE, "docs", CATALOG, noopLog).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BillingCheckFailedError);
  });
});

describe("assertCollectionBatchInstallable", () => {
  it("checks every slug for a cross-catalog collision", async () => {
    CROSS_CATALOG_ROWS = [{ catalog_id: "catalog:bundle-sync" }];
    const err = await assertCollectionBatchInstallable(
      WORKSPACE,
      ["a", "b", "c"],
      CATALOG,
      noopLog,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FormInstallValidationError);
  });

  it("runs ONE cap check for the whole batch, not one per slug", async () => {
    // A per-slug loop would see the same pre-write count N times and pass,
    // stranding a partial install when the atomic gate refused the (cap+1)-th.
    await assertCollectionBatchInstallable(WORKSPACE, ["a", "b", "c"], CATALOG, noopLog);
    expect(fanoutCalls).toBe(1);
  });

  it("refuses the whole batch with the 403 envelope before anything is written", async () => {
    FANOUT = capReached(1, "starter");
    const err = await assertCollectionBatchInstallable(
      WORKSPACE,
      ["a", "b"],
      CATALOG,
      noopLog,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeatureEntitlementError);
    expect((err as InstanceType<typeof FeatureEntitlementError>).requiredPlan).toBe("pro");
  });

  it("fails CLOSED as a 503 when the batch count could not be determined", async () => {
    FANOUT = { allowed: false, reason: "check_failed", errorMessage: "try again" };
    const err = await assertCollectionBatchInstallable(
      WORKSPACE,
      ["a", "b"],
      CATALOG,
      noopLog,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingCheckFailedError);
  });
});

describe("upsertKnowledgeCollectionRow", () => {
  const input = {
    workspaceId: WORKSPACE,
    collectionSlug: "docs",
    sql: "INSERT ... RETURNING id",
    params: ["cand-1"],
    candidateId: "cand-1",
    log: noopLog,
  };

  it("returns the persisted row id from RETURNING", async () => {
    // Deliberately NOT candidateId — on the ON-CONFLICT path the row keeps its
    // existing id, so echoing the candidate would be wrong.
    INSTALL = { allowed: true, rows: [{ id: "existing-row" }] };
    expect(await upsertKnowledgeCollectionRow(input)).toBe("existing-row");
  });

  it("rejects SQL without RETURNING id BEFORE taking the lock", async () => {
    // Otherwise the omission is only detectable after the write has already run
    // inside the transaction.
    await expect(
      upsertKnowledgeCollectionRow({ ...input, sql: "INSERT INTO workspace_plugins ..." }),
    ).rejects.toThrow(/requires SQL ending in "RETURNING id"/);
  });

  it("fails loud when RETURNING yields no row", async () => {
    INSTALL = { allowed: true, rows: [] };
    await expect(upsertKnowledgeCollectionRow(input)).rejects.toThrow(/returned no id/);
  });

  it("turns an under-lock cap hit into the 403 upgrade envelope", async () => {
    INSTALL = capReached(1, "starter");
    const err = await upsertKnowledgeCollectionRow(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeatureEntitlementError);
    expect((err as InstanceType<typeof FeatureEntitlementError>).requiredPlan).toBe("pro");
  });

  it("fails CLOSED as a 503 when the under-lock count check failed", async () => {
    INSTALL = { allowed: false, reason: "check_failed", errorMessage: "try again" };
    await expect(upsertKnowledgeCollectionRow(input)).rejects.toBeInstanceOf(
      BillingCheckFailedError,
    );
  });
});
