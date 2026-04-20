/**
 * Tests for GET /api/v1/platform/stats — MRR calculation correctness.
 *
 * Regression test for #1680: migrations 0020 + 0027 renamed plan tiers from
 * `team` / `enterprise` to `starter` / `pro` / `business`, but `PLAN_MRR` in
 * `platform-admin.ts` was never updated. `GET /stats.mrr` silently returned
 * `$0` for every real workspace.
 *
 * The MRR pricing numbers live in `packages/api/src/lib/billing/plans.ts`
 * (`getPlanDefinition(tier).pricePerSeat`). These tests assert that:
 *  - every `PlanTier` yields the same MRR the billing layer would charge
 *  - adding a new tier cannot silently drop to `$0` — each tier must be
 *    represented in `PLAN_MRR` (the satisfies check + this test both fail).
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
import { PLAN_TIERS, type PlanTier } from "@useatlas/types";
import { getPlanDefinition } from "@atlas/api/lib/billing/plans";

// --- Mock setup ---

const mocks = createApiTestMocks();

// Mock audit — platform-admin.ts imports ADMIN_ACTIONS at top level.
import { mock } from "bun:test";
mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mock(() => {}),
  ADMIN_ACTIONS: {
    workspace: {
      suspend: "workspace.suspend",
      unsuspend: "workspace.unsuspend",
      delete: "workspace.delete",
      purge: "workspace.purge",
      changePlan: "workspace.change_plan",
    },
  },
}));

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

function platformRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
  });
}

// SQL fragments used to route the mock `internalQuery` call sites.
const SQL_WS_COUNTS = "FROM organization";
const SQL_USER_COUNT = `FROM "user"`;
const SQL_QUERY_COUNT = "FROM audit_log";
const SQL_MRR_GROUP = "GROUP BY plan_tier";

/**
 * Mock the 4 SQL calls inside `platformStatsRoute` and return a predictable
 * `mrrRows` shape so each test can assert the MRR sum without re-mocking
 * the first 3 queries.
 */
function mockStatsWithMrrRows(rows: Array<{ plan_tier: string; cnt: number }>): void {
  mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
    if (sql.includes(SQL_MRR_GROUP)) return rows;
    if (sql.includes(SQL_WS_COUNTS)) return [{ total: rows.reduce((s, r) => s + r.cnt, 0), active: rows.reduce((s, r) => s + r.cnt, 0), suspended: 0 }];
    if (sql.includes(SQL_USER_COUNT)) return [{ count: 0 }];
    if (sql.includes(SQL_QUERY_COUNT)) return [{ count: 0 }];
    return [];
  });
}

describe("GET /api/v1/platform/stats — MRR calculation", () => {
  beforeEach(() => {
    mocks.setPlatformAdmin();
    mocks.hasInternalDB = true;
  });

  it("covers every PlanTier — PLAN_MRR must have no stale/missing keys", async () => {
    // One active workspace per tier. If `PLAN_MRR` is missing a key, that
    // tier contributes $0 to the sum and this test fails against the
    // canonical `getPlanDefinition().pricePerSeat`.
    const rows = PLAN_TIERS.map((tier) => ({ plan_tier: tier, cnt: 1 }));
    mockStatsWithMrrRows(rows);

    const expected = PLAN_TIERS.reduce(
      (sum, tier) => sum + getPlanDefinition(tier).pricePerSeat,
      0,
    );

    const res = await app.request(platformRequest("GET", "/api/v1/platform/stats"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mrr: number };
    expect(body.mrr).toBe(expected);
  });

  // Per-tier parametrised test — each failure points at exactly which tier
  // dropped off `PLAN_MRR`. Multiplier of 3 exercises the cnt multiplication.
  for (const tier of PLAN_TIERS) {
    it(`computes MRR for "${tier}" from plans.ts pricePerSeat`, async () => {
      const cnt = 3;
      mockStatsWithMrrRows([{ plan_tier: tier, cnt }]);

      const pricePerSeat = getPlanDefinition(tier as PlanTier).pricePerSeat;
      const res = await app.request(
        platformRequest("GET", "/api/v1/platform/stats"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { mrr: number };
      expect(body.mrr).toBe(pricePerSeat * cnt);
    });
  }

  it("returns 0 when there are no active workspaces", async () => {
    mockStatsWithMrrRows([]);
    const res = await app.request(platformRequest("GET", "/api/v1/platform/stats"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mrr: number };
    expect(body.mrr).toBe(0);
  });

  it("ignores unknown plan tiers without throwing (forward-compat)", async () => {
    // A workspace whose plan_tier isn't in PLAN_MRR must not crash the
    // endpoint; it should contribute 0 and be silently skipped. This
    // protects the endpoint during a staged tier rename.
    mockStatsWithMrrRows([
      { plan_tier: "starter", cnt: 1 },
      { plan_tier: "mystery_new_tier", cnt: 99 },
    ]);
    const res = await app.request(platformRequest("GET", "/api/v1/platform/stats"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mrr: number };
    expect(body.mrr).toBe(getPlanDefinition("starter").pricePerSeat);
  });
});
