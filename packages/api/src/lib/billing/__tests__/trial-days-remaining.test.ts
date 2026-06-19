/**
 * Tests for `getTrialDaysRemaining` (ADR-0018 / #3651) — the days-remaining
 * value surfaced in MCP tool responses post-claim. Uses the injected mock pool
 * so the workspace read is deterministic.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { invalidatePlanCache, getTrialDaysRemaining } from "../enforcement";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;

function poolFor(workspaceRow: Record<string, unknown> | null): InternalPool {
  return {
    query: async () => ({
      rows: workspaceRow ? [workspaceRow] : [],
      rowCount: workspaceRow ? 1 : 0,
    }),
  } as unknown as InternalPool;
}

function trialWorkspace(trialEndsAt: string | null): Record<string, unknown> {
  return {
    id: "org-1",
    name: "Acme",
    slug: "acme",
    workspace_status: "active",
    plan_tier: "trial",
    byot: false,
    stripe_customer_id: null,
    trial_ends_at: trialEndsAt,
    suspended_at: null,
    suspension_source: null,
    plan_override_until: null,
    deleted_at: null,
    region: null,
    region_assigned_at: null,
    createdAt: new Date().toISOString(),
  };
}

describe("getTrialDaysRemaining", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://test/test";
    invalidatePlanCache(); // drop any cached workspace from a prior test
  });

  afterEach(() => {
    invalidatePlanCache();
  });

  afterAll(() => {
    _resetPool(null);
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

  it("returns whole days until trial_ends_at for a trial workspace", async () => {
    _resetPool(poolFor(trialWorkspace(new Date(Date.now() + 5 * DAY_MS - 1000).toISOString())));
    const days = await getTrialDaysRemaining("org-1");
    expect(days).toBe(5);
  });

  it("floors a lapsed trial at 0 (never negative)", async () => {
    _resetPool(poolFor(trialWorkspace(new Date(Date.now() - 2 * DAY_MS).toISOString())));
    const days = await getTrialDaysRemaining("org-lapsed");
    expect(days).toBe(0);
  });

  it("returns null for a non-trial workspace", async () => {
    _resetPool(poolFor({ ...trialWorkspace(null), plan_tier: "pro" }));
    const days = await getTrialDaysRemaining("org-pro");
    expect(days).toBeNull();
  });

  it("returns null with no org", async () => {
    expect(await getTrialDaysRemaining(undefined)).toBeNull();
  });
});
