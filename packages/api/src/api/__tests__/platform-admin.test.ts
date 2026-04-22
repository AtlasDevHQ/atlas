/**
 * Tests for GET /api/v1/platform/stats — MRR calculation correctness.
 *
 * Regression test for #1680: migrations 0020 + 0027 renamed plan tiers from
 * `team` / `enterprise` to `starter` / `pro` / `business`, but `PLAN_MRR` in
 * `platform-admin.ts` was never updated. `GET /stats.mrr` silently returned
 * `$0` for every real workspace.
 *
 * Pricing lives in `packages/api/src/lib/billing/plans.ts`
 * (`getPlanDefinition(tier).pricePerSeat`). These tests assert that every
 * `PlanTier` yields the same MRR the billing layer would charge, and that
 * adding a new tier without a price fails this suite (because each tier is
 * checked individually, the failure names the offending tier).
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
import { createHash } from "node:crypto";

// --- Mock setup ---

const mocks = createApiTestMocks();

// Top-level ADMIN_ACTIONS import in platform-admin.ts requires a module
// mock before the app is imported below.
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

// Spy the logger so the forward-compat unknown-tier test can assert the
// `log.warn` breadcrumb actually fires — silent $0 drift is the exact
// failure mode that hid #1680. Must mock every named export of
// `@atlas/api/lib/logger` so partial-mock shape mismatch doesn't break
// unrelated tests that import this module transitively.
const mockLogWarn = mock((..._args: unknown[]) => {});
const stubLogger = {
  info: () => {},
  warn: mockLogWarn,
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
};
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => stubLogger,
  getLogger: () => stubLogger,
  setLogLevel: () => false,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => undefined,
  redactPaths: [] as string[],
  hashShareToken: (token: string) =>
    createHash("sha256").update(token).digest("hex").slice(0, 16),
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
 * `mrrRows` shape. `mrrHit` is returned so each test can assert the mrr
 * branch was actually exercised — otherwise a production query rewording
 * would silently bypass the mock and the test would pass against $0.
 */
function mockStatsWithMrrRows(rows: Array<{ plan_tier: string; cnt: number }>): { mrrHit: () => boolean } {
  let hit = false;
  mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
    if (sql.includes(SQL_MRR_GROUP)) {
      hit = true;
      return rows;
    }
    if (sql.includes(SQL_WS_COUNTS)) return [{ total: rows.reduce((s, r) => s + r.cnt, 0), active: rows.reduce((s, r) => s + r.cnt, 0), suspended: 0 }];
    if (sql.includes(SQL_USER_COUNT)) return [{ count: 0 }];
    if (sql.includes(SQL_QUERY_COUNT)) return [{ count: 0 }];
    return [];
  });
  return { mrrHit: () => hit };
}

describe("GET /api/v1/platform/stats — MRR calculation", () => {
  beforeEach(() => {
    mocks.setPlatformAdmin();
    mocks.hasInternalDB = true;
    mockLogWarn.mockClear();
  });

  it("covers every PlanTier — PLAN_MRR must have no stale/missing keys", async () => {
    // One active workspace per tier.
    const rows = PLAN_TIERS.map((tier) => ({ plan_tier: tier, cnt: 1 }));
    const { mrrHit } = mockStatsWithMrrRows(rows);

    const expected = PLAN_TIERS.reduce(
      (sum, tier) => sum + getPlanDefinition(tier).pricePerSeat,
      0,
    );

    const res = await app.request(platformRequest("GET", "/api/v1/platform/stats"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mrr: number };
    expect(body.mrr).toBe(expected);
    expect(mrrHit()).toBe(true);
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

  it("sums mixed tiers with per-tier multipliers", async () => {
    // Aggregating more than one tier-with-count row catches a regression
    // where the reducer stops at the first match or loses the `cnt` factor.
    mockStatsWithMrrRows([
      { plan_tier: "starter", cnt: 2 },
      { plan_tier: "pro", cnt: 5 },
      { plan_tier: "business", cnt: 1 },
    ]);
    const res = await app.request(platformRequest("GET", "/api/v1/platform/stats"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mrr: number };
    const expected =
      getPlanDefinition("starter").pricePerSeat * 2 +
      getPlanDefinition("pro").pricePerSeat * 5 +
      getPlanDefinition("business").pricePerSeat * 1;
    expect(body.mrr).toBe(expected);
  });

  it("excludes suspended workspaces via the active-status SQL filter", async () => {
    // The MRR query filters on `workspace_status = 'active'`. Verify the
    // emitted SQL carries that predicate — a future refactor that drops
    // the filter would silently inflate MRR with suspended/deleted rows.
    let capturedMrrSql = "";
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes(SQL_MRR_GROUP)) {
        capturedMrrSql = sql;
        return [{ plan_tier: "pro", cnt: 1 }];
      }
      if (sql.includes(SQL_WS_COUNTS)) return [{ total: 1, active: 1, suspended: 0 }];
      if (sql.includes(SQL_USER_COUNT)) return [{ count: 0 }];
      if (sql.includes(SQL_QUERY_COUNT)) return [{ count: 0 }];
      return [];
    });

    const res = await app.request(platformRequest("GET", "/api/v1/platform/stats"));
    expect(res.status).toBe(200);
    expect(capturedMrrSql).toMatch(/workspace_status\s*=\s*'active'/);
  });

  it("logs and skips unknown plan tiers (forward-compat during staged renames)", async () => {
    // An unknown tier contributes 0 so the known-tier slice still reports
    // correctly during a staged rename, but the endpoint emits a log.warn
    // breadcrumb so the silent $0 trap that hid #1680 leaves a trace.
    mockStatsWithMrrRows([
      { plan_tier: "starter", cnt: 1 },
      { plan_tier: "mystery_new_tier", cnt: 99 },
    ]);
    const res = await app.request(platformRequest("GET", "/api/v1/platform/stats"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mrr: number };
    expect(body.mrr).toBe(getPlanDefinition("starter").pricePerSeat);

    // Exactly one warn for the one unknown tier encountered.
    expect(mockLogWarn.mock.calls.length).toBe(1);
    const [ctx, message] = mockLogWarn.mock.calls[0];
    expect(ctx).toMatchObject({ planTier: "mystery_new_tier", cnt: 99 });
    expect(message).toMatch(/Unknown plan_tier/i);
  });

  it("dedupes the unknown-tier warn — one log per distinct tier per request", async () => {
    // If the same unknown tier appears twice in the query result, emit
    // the warn once per request (bounded log volume during a rename).
    mockStatsWithMrrRows([
      { plan_tier: "mystery_new_tier", cnt: 2 },
      { plan_tier: "mystery_new_tier", cnt: 3 },
      { plan_tier: "another_new_tier", cnt: 7 },
    ]);
    const res = await app.request(platformRequest("GET", "/api/v1/platform/stats"));
    expect(res.status).toBe(200);
    // One warn per distinct unknown tier = 2.
    expect(mockLogWarn.mock.calls.length).toBe(2);
  });
});
