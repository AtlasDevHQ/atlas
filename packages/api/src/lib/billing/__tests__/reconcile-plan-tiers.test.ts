/**
 * Unit tests for the plan-tier reconciliation sweep (#3423).
 *
 * Pins the two deliberate asymmetries (heal toward the subscription
 * table; flag-don't-heal paid orgs without a subscription — see #3427)
 * and the normal-state exclusions (trial/free/locked with no sub).
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import { buildInternalDbMockDefaults } from "@atlas/api/testing/api-test-mocks";

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> =
  mock(() => Promise.resolve([]));
const mockUpdateWorkspacePlanTier: Mock<(orgId: string, tier: string) => Promise<boolean>> =
  mock(() => Promise.resolve(true));
let hasDb = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  ...buildInternalDbMockDefaults({
    internalQuery: mockInternalQuery,
    hasInternalDB: () => hasDb,
  }),
  updateWorkspacePlanTier: mockUpdateWorkspacePlanTier,
}));

const { reconcilePlanTiers } = await import("../reconcile-plan-tiers");

interface OrgRow {
  org_id: string;
  plan_tier: string | null;
  subscription_plan: string | null;
  /** Newest applied tier from the webhook ledger (defaulted to null). */
  ledger_tier?: string | null;
}

/** Route the org scan and the ledger prune through one mock. */
function installQueryFixture(orgs: OrgRow[], pruned: { event_id: string }[] = []) {
  mockInternalQuery.mockImplementation((sql: string) => {
    if (sql.includes("FROM organization o"))
      return Promise.resolve(orgs.map((o) => ({ ledger_tier: null, ...o })));
    if (sql.includes("DELETE FROM stripe_webhook_events")) return Promise.resolve(pruned);
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  hasDb = true;
  mockInternalQuery.mockReset();
  mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  mockUpdateWorkspacePlanTier.mockReset();
  mockUpdateWorkspacePlanTier.mockImplementation(() => Promise.resolve(true));
});

describe("reconcilePlanTiers", () => {
  it("returns zeros without touching the DB when there is no internal DB", async () => {
    hasDb = false;
    await expect(reconcilePlanTiers()).resolves.toEqual({
      healed: 0,
      flagged: 0,
      prunedLedger: 0,
    });
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("heals an org whose tier disagrees with its live subscription (incl. un-locking a resubscribe)", async () => {
    installQueryFixture([
      // Lost resubscribe webhook: locked org with an active starter sub.
      { org_id: "org-locked", plan_tier: "locked", subscription_plan: "starter" },
      // Lost upgrade webhook: starter org paying for pro.
      { org_id: "org-upgrade", plan_tier: "starter", subscription_plan: "pro" },
      // In sync — no write.
      { org_id: "org-ok", plan_tier: "pro", subscription_plan: "pro" },
    ]);

    const result = await reconcilePlanTiers();

    expect(result.healed).toBe(2);
    expect(result.flagged).toBe(0);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledTimes(2);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledWith("org-locked", "starter");
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledWith("org-upgrade", "pro");
  });

  it("flags but never rewrites a paid-tier org with no live subscription (#3427 pending)", async () => {
    installQueryFixture([
      { org_id: "org-paid-nosub", plan_tier: "business", subscription_plan: null },
    ]);

    const result = await reconcilePlanTiers();

    expect(result.flagged).toBe(1);
    expect(result.healed).toBe(0);
    expect(mockUpdateWorkspacePlanTier).not.toHaveBeenCalled();
  });

  it("leaves trial, free, locked, and null-tier orgs without a subscription alone", async () => {
    installQueryFixture([
      { org_id: "org-trial", plan_tier: "trial", subscription_plan: null },
      { org_id: "org-free", plan_tier: "free", subscription_plan: null },
      { org_id: "org-churned", plan_tier: "locked", subscription_plan: null },
      { org_id: "org-legacy", plan_tier: null, subscription_plan: null },
    ]);

    await expect(reconcilePlanTiers()).resolves.toEqual({
      healed: 0,
      flagged: 0,
      prunedLedger: 0,
    });
    expect(mockUpdateWorkspacePlanTier).not.toHaveBeenCalled();
  });

  it("skips (does not write) a subscription whose plan name is outside the tier vocabulary", async () => {
    installQueryFixture([
      { org_id: "org-weird", plan_tier: "starter", subscription_plan: "enterprise" },
    ]);

    const result = await reconcilePlanTiers();

    expect(result.healed).toBe(0);
    expect(mockUpdateWorkspacePlanTier).not.toHaveBeenCalled();
  });

  it("does not count a heal when the org row vanished under the write", async () => {
    mockUpdateWorkspacePlanTier.mockImplementation(() => Promise.resolve(false));
    installQueryFixture([
      { org_id: "org-gone", plan_tier: "locked", subscription_plan: "starter" },
    ]);

    const result = await reconcilePlanTiers();
    expect(result.healed).toBe(0);
  });

  it("prefers the ledger's newest APPLIED tier over the plugin's last-delivered row plan", async () => {
    // Stale older `updated` (plan=starter) delivered after a newer one
    // (plan=pro): the ledger skipped the Atlas sync, but the plugin's
    // row regressed to starter. Healing from the row would write
    // pro→starter — exactly the regression the ledger rejected. The
    // sweep must trust applied_plan_tier when present.
    installQueryFixture([
      { org_id: "org-1", plan_tier: "pro", subscription_plan: "starter", ledger_tier: "pro" },
    ]);

    const result = await reconcilePlanTiers();

    expect(result.healed).toBe(0);
    expect(mockUpdateWorkspacePlanTier).not.toHaveBeenCalled();

    // And when the org ACTUALLY drifted from the ledger-applied tier
    // (lost webhook), the heal targets the ledger tier, not the row.
    installQueryFixture([
      { org_id: "org-2", plan_tier: "starter", subscription_plan: "starter", ledger_tier: "pro" },
    ]);
    const second = await reconcilePlanTiers();
    expect(second.healed).toBe(1);
    expect(mockUpdateWorkspacePlanTier).toHaveBeenCalledWith("org-2", "pro");
  });

  it("ignores subscription rows whose stripe sub has a recorded deletion event (stale last-delivered rows)", async () => {
    // The plugin writes its subscription table last-DELIVERED-wins, so a
    // stale older `updated` after a processed `deleted` can leave the row
    // "active". The scan must not treat such rows as live — otherwise the
    // sweep would heal a locked org back to paid. Semantics live in SQL
    // (NOT EXISTS against the ledger), so pin the query shape here; the
    // behavior itself is covered by the ledger tie-break tests.
    installQueryFixture([]);
    await reconcilePlanTiers();
    const [scanSql] = mockInternalQuery.mock.calls[0] as [string];
    expect(scanSql).toContain("NOT EXISTS");
    expect(scanSql).toContain("'customer.subscription.deleted'");
    expect(scanSql).toContain("stripe_webhook_events");
    // The ledger-applied-tier lateral must survive too — dropping it
    // silently reverts the sweep to last-delivered-wins healing.
    expect(scanSql).toContain("applied_plan_tier");
  });

  it("prunes the webhook event ledger and reports the count", async () => {
    installQueryFixture([], [{ event_id: "evt_old_1" }, { event_id: "evt_old_2" }]);

    const result = await reconcilePlanTiers();
    expect(result.prunedLedger).toBe(2);
  });

  it("propagates internal-DB failures so the scheduler tick logs and retries", async () => {
    mockInternalQuery.mockImplementation(() => Promise.reject(new Error("pg down")));
    await expect(reconcilePlanTiers()).rejects.toThrow("pg down");
  });
});
