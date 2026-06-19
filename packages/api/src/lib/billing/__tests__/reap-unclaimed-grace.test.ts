/**
 * Tests for the unclaimed-grace reaper (`reapUnclaimedGraceWorkspaces`, #3652).
 *
 * The reaper demotes UNCLAIMED past-grace trial Workspaces (owner
 * `emailVerified = false`, `trial_ends_at` lapsed) to the `'locked'` churn tier
 * so Gate 0 then blocks them on every surface incl. MCP. It must NEVER touch a
 * claimed trial or a within-grace Workspace.
 *
 * The selection happens entirely in the guarded `UPDATE ... RETURNING`, so this
 * suite uses the same mock-pool pattern as the sibling `backfillSaasTrial` test:
 * a simulator interprets the reaper's predicates over an in-memory org fixture
 * and returns the ids Postgres would, giving genuine behavioral coverage of the
 * three-case matrix (reaped / claimed-left-alone / within-grace-left-alone)
 * plus assertions that the SQL carries the guards that encode them.
 *
 * Mocks `InternalPool` via `_resetPool` and `getConfig()` via
 * `_setConfigForTest` — no top-level singleton mutation; both reset per test.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { _setConfigForTest, type ResolvedConfig } from "@atlas/api/lib/config";
import { reapUnclaimedGraceWorkspaces } from "../reap-unclaimed-grace";

const HOUR_MS = 60 * 60 * 1000;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

/** A trial Workspace fixture the simulator filters with the reaper's rules. */
interface OrgFixture {
  id: string;
  plan_tier: string;
  /** ms-from-now; negative = past-grace, positive = within-grace. */
  trialEndsInMs: number | null;
  /** ms-from-now for an operator override window; null = none. */
  overrideUntilMs?: number | null;
  /** The org owner's `emailVerified` bit — false = unclaimed. */
  ownerEmailVerified: boolean;
}

interface MockPool {
  pool: InternalPool;
  queries: Array<{ sql: string; params?: unknown[] }>;
}

/**
 * Build a pool that evaluates the reaper's guarded UPDATE against `orgs`,
 * returning the ids that satisfy every WHERE clause — i.e. exactly what
 * Postgres would RETURNING for this fixture.
 */
function makeMockPool(orgs: OrgFixture[], opts: { throws?: boolean } = {}): MockPool {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const now = Date.now();
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (opts.throws) throw new Error("UPDATE failed");
      const matched = orgs
        .filter((o) => o.plan_tier === "trial")
        .filter((o) => o.trialEndsInMs !== null && now + o.trialEndsInMs < now) // trial_ends_at < NOW()
        .filter((o) => {
          const ov = o.overrideUntilMs ?? null; // override inactive or absent
          return ov === null || now + ov <= now;
        })
        .filter((o) => o.ownerEmailVerified === false) // EXISTS unverified owner
        .map((o) => ({ id: o.id }));
      return { rows: matched, rowCount: matched.length };
    },
  } as unknown as InternalPool;
  return { pool, queries };
}

function configWithDeployMode(deployMode: "saas" | "self-hosted"): ResolvedConfig {
  return {
    datasources: {},
    tools: ["explore", "executeSQL"],
    auth: "managed",
    semanticLayer: "./semantic",
    maxTotalConnections: 100,
    source: "file",
    deployMode,
  };
}

describe("reapUnclaimedGraceWorkspaces", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://test/test";
    _setConfigForTest(configWithDeployMode("saas"));
  });

  afterAll(() => {
    _resetPool(null);
    _setConfigForTest(null);
    if (ORIGINAL_DATABASE_URL === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    }
  });

  // ── The three-case acceptance matrix ──────────────────────────────────

  it("reaps an unclaimed past-grace Workspace — demotes it to 'locked'", async () => {
    const { pool, queries } = makeMockPool([
      { id: "org_abandoned", plan_tier: "trial", trialEndsInMs: -1 * HOUR_MS, ownerEmailVerified: false },
    ]);
    _resetPool(pool);

    const result = await reapUnclaimedGraceWorkspaces();

    expect(result.reapedCount).toBe(1);
    expect(result.orgIds).toEqual(["org_abandoned"]);

    // The reap is the 'locked' demotion — the tier Gate 0 blocks on every
    // surface incl. MCP (`subscription_required`, zero entitlements).
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/SET plan_tier = 'locked'/);
    expect(queries[0].sql).toMatch(/plan_tier = 'trial'/);
  });

  it("leaves a claimed trial alone — owner emailVerified = true is never matched", async () => {
    const { pool, queries } = makeMockPool([
      // Claimed: even past `trial_ends_at`, a verified owner is invisible to
      // the reaper — normal trial-expiry owns the full 14-day clock.
      { id: "org_claimed", plan_tier: "trial", trialEndsInMs: -10 * HOUR_MS, ownerEmailVerified: true },
    ]);
    _resetPool(pool);

    const result = await reapUnclaimedGraceWorkspaces();

    expect(result.reapedCount).toBe(0);
    expect(result.orgIds).toEqual([]);
    // The guard that protects a claimed trial: only an UNVERIFIED owner matches.
    expect(queries[0].sql).toMatch(/"emailVerified" = false/);
    expect(queries[0].sql).toMatch(/role = 'owner'/);
  });

  it("leaves a within-grace unclaimed Workspace alone — grace not yet lapsed", async () => {
    const { pool, queries } = makeMockPool([
      { id: "org_in_grace", plan_tier: "trial", trialEndsInMs: 12 * HOUR_MS, ownerEmailVerified: false },
    ]);
    _resetPool(pool);

    const result = await reapUnclaimedGraceWorkspaces();

    expect(result.reapedCount).toBe(0);
    expect(result.orgIds).toEqual([]);
    // The guard that protects a within-grace Workspace.
    expect(queries[0].sql).toMatch(/trial_ends_at < NOW\(\)/);
  });

  // ── Mixed fixture + defensive guards ─────────────────────────────────

  it("evicts each reaped org from the plan cache so the lock takes effect before TTL", async () => {
    // The DB demotion alone isn't enough: a request hitting THIS replica would
    // keep serving the cached 'trial' tier until the ≤60s TTL. Assert the reaper
    // invalidates the cache for exactly the reaped ids (and nothing else).
    const { pool } = makeMockPool([
      { id: "org_reap_a", plan_tier: "trial", trialEndsInMs: -2 * HOUR_MS, ownerEmailVerified: false },
      { id: "org_reap_b", plan_tier: "trial", trialEndsInMs: -3 * HOUR_MS, ownerEmailVerified: false },
      { id: "org_claimed", plan_tier: "trial", trialEndsInMs: -2 * HOUR_MS, ownerEmailVerified: true },
    ]);
    _resetPool(pool);

    const invalidated: string[] = [];
    const result = await reapUnclaimedGraceWorkspaces({
      invalidatePlanCache: (id) => invalidated.push(id),
    });

    expect(result.orgIds).toEqual(["org_reap_a", "org_reap_b"]);
    // One eviction per reaped org — the claimed (un-reaped) org is never touched.
    expect(invalidated).toEqual(["org_reap_a", "org_reap_b"]);
  });

  it("does not invalidate any cache entry when nothing is reaped", async () => {
    const { pool } = makeMockPool([
      { id: "org_in_grace", plan_tier: "trial", trialEndsInMs: 5 * HOUR_MS, ownerEmailVerified: false },
    ]);
    _resetPool(pool);

    const invalidated: string[] = [];
    const result = await reapUnclaimedGraceWorkspaces({
      invalidatePlanCache: (id) => invalidated.push(id),
    });

    expect(result.reapedCount).toBe(0);
    expect(invalidated).toEqual([]);
  });

  it("reaps only the unclaimed past-grace rows from a mixed fixture", async () => {
    const { pool } = makeMockPool([
      { id: "org_reap_me", plan_tier: "trial", trialEndsInMs: -2 * HOUR_MS, ownerEmailVerified: false },
      { id: "org_claimed", plan_tier: "trial", trialEndsInMs: -2 * HOUR_MS, ownerEmailVerified: true },
      { id: "org_in_grace", plan_tier: "trial", trialEndsInMs: 5 * HOUR_MS, ownerEmailVerified: false },
      { id: "org_paid", plan_tier: "pro", trialEndsInMs: -2 * HOUR_MS, ownerEmailVerified: false },
    ]);
    _resetPool(pool);

    const result = await reapUnclaimedGraceWorkspaces();

    expect(result.orgIds).toEqual(["org_reap_me"]);
    expect(result.reapedCount).toBe(1);
  });

  it("does not clobber a Workspace under an active operator plan-override (#3427)", async () => {
    const { pool, queries } = makeMockPool([
      {
        id: "org_op_grant",
        plan_tier: "trial",
        trialEndsInMs: -3 * HOUR_MS,
        overrideUntilMs: 24 * HOUR_MS, // active override window
        ownerEmailVerified: false,
      },
    ]);
    _resetPool(pool);

    const result = await reapUnclaimedGraceWorkspaces();

    expect(result.reapedCount).toBe(0);
    expect(queries[0].sql).toMatch(/plan_override_until IS NULL OR o\.plan_override_until <= NOW\(\)/);
  });

  // ── SaaS-only / DB gates ─────────────────────────────────────────────

  it("is a no-op on self-hosted — never issues an UPDATE", async () => {
    _setConfigForTest(configWithDeployMode("self-hosted"));
    const { pool, queries } = makeMockPool([
      { id: "org_x", plan_tier: "trial", trialEndsInMs: -1 * HOUR_MS, ownerEmailVerified: false },
    ]);
    _resetPool(pool);

    const result = await reapUnclaimedGraceWorkspaces();

    expect(result.reapedCount).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it("is a no-op when deployMode is missing (auto-resolves to self-hosted)", async () => {
    _setConfigForTest(null);
    const { pool, queries } = makeMockPool([
      { id: "org_x", plan_tier: "trial", trialEndsInMs: -1 * HOUR_MS, ownerEmailVerified: false },
    ]);
    _resetPool(pool);

    const result = await reapUnclaimedGraceWorkspaces();

    expect(result.reapedCount).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it("is a no-op when the internal DB is unavailable", async () => {
    delete process.env.DATABASE_URL;
    const { pool, queries } = makeMockPool([
      { id: "org_x", plan_tier: "trial", trialEndsInMs: -1 * HOUR_MS, ownerEmailVerified: false },
    ]);
    _resetPool(pool);

    const result = await reapUnclaimedGraceWorkspaces();

    expect(result.reapedCount).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it("swallows UPDATE errors — a failed sweep must not crash the fiber", async () => {
    const { pool } = makeMockPool(
      [{ id: "org_x", plan_tier: "trial", trialEndsInMs: -1 * HOUR_MS, ownerEmailVerified: false }],
      { throws: true },
    );
    _resetPool(pool);

    const result = await reapUnclaimedGraceWorkspaces();

    expect(result.reapedCount).toBe(0);
    expect(result.orgIds).toEqual([]);
  });
});
