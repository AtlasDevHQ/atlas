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
  afterEach,
  afterAll,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
import { PLAN_TIERS, asRatio, type PlanTier, type AbuseLevel } from "@useatlas/types";
import { getPlanDefinition } from "@atlas/api/lib/billing/plans";
import { createHash } from "node:crypto";

// --- Mock setup ---

const mocks = createApiTestMocks();

// Top-level ADMIN_ACTIONS import in platform-admin.ts requires a module
// mock before the app is imported below.
import { mock } from "bun:test";
// Programmable abuse status — re-register the abuse module mock so the
// `abuseLevel` surfacing tests below can dictate per-workspace levels
// without driving the real escalation ladder. `createApiTestMocks` pins
// `checkAbuseStatus` to a constant `{ level: "none" }`; that fixture is
// fine for the existing suites but blocks the regression test for the
// "platform-admin says active while chat is suspended" bug.
const abuseStatusByWorkspace = new Map<string, AbuseLevel>();
mock.module("@atlas/api/lib/security/abuse", () => ({
  listFlaggedWorkspaces: mock(() => []),
  reinstateWorkspace: mock(() => "warning" as const),
  getAbuseEvents: mock(async () => ({ events: [], status: "ok" })),
  // `asRatio` brands the threshold to match the real `getAbuseConfig`
  // boundary — keeps this fixture in lockstep with the api-test-mocks
  // shape so a future caller can swap between the two without a cast.
  getAbuseConfig: mock(() => ({
    queryRateLimit: 200,
    queryRateWindowSeconds: 300,
    errorRateThreshold: asRatio(0.5),
    uniqueTablesLimit: 50,
    throttleDelayMs: 2000,
  })),
  getAbuseDetail: mock(async () => null),
  checkAbuseStatus: mock((workspaceId: string) => ({
    level: abuseStatusByWorkspace.get(workspaceId) ?? "none",
  })),
  recordQueryEvent: mock(() => {}),
  restoreAbuseState: mock(async () => {}),
  getAbuseRestoreStatus: mock(() => "ok" as const),
  ABUSE_RESTORE_STATUSES: ["pending", "ok", "db_unavailable", "load_failed"] as const,
  _resetAbuseState: mock(() => abuseStatusByWorkspace.clear()),
  abuseCleanupTick: mock(() => {}),
  ABUSE_CLEANUP_INTERVAL_MS: 300_000,
}));
mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: mock(() => {}),
  logAdminActionAwait: mock(async () => {}),
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

// #2249 — `neverSuspend` flag reflects ATLAS_LOADTEST_ALLOWED_ORGS
// membership on every list-route row. The flag is what the platform-
// admin orgs page reads to render the "Load-test" badge — drift here
// silently un-badges allowlisted workspaces.
describe("GET /api/v1/platform/workspaces — neverSuspend flag (#2249)", () => {
  beforeEach(() => {
    mocks.setPlatformAdmin();
    mocks.hasInternalDB = true;
    mockLogWarn.mockClear();
  });

  function mockListWorkspaces(rows: Array<{ id: string; slug: string }>): void {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM organization o")) {
        return rows.map((r) => ({
          id: r.id,
          name: r.id,
          slug: r.slug,
          workspace_status: "active",
          plan_tier: "starter",
          byot: false,
          stripe_customer_id: null,
          trial_ends_at: null,
          suspended_at: null,
          deleted_at: null,
          region: "us",
          region_assigned_at: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          members: 1,
          conversations: 0,
          queries_last_24h: 0,
          connections: 0,
          scheduled_tasks: 0,
        }));
      }
      return [];
    });
  }

  it("flips neverSuspend=true for workspaces in ATLAS_LOADTEST_ALLOWED_ORGS", async () => {
    mockListWorkspaces([{ id: "ws-loadtest", slug: "loadtest" }, { id: "ws-normal", slug: "normal" }]);
    const original = process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
    process.env.ATLAS_LOADTEST_ALLOWED_ORGS = "ws-loadtest";
    try {
      const res = await app.fetch(platformRequest("GET", "/api/v1/platform/workspaces"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { workspaces: Array<{ id: string; neverSuspend: boolean }> };
      const lookup = Object.fromEntries(body.workspaces.map((w) => [w.id, w.neverSuspend]));
      expect(lookup["ws-loadtest"]).toBe(true);
      expect(lookup["ws-normal"]).toBe(false);
    } finally {
      if (original === undefined) delete process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
      else process.env.ATLAS_LOADTEST_ALLOWED_ORGS = original;
    }
  });

  it("returns neverSuspend=false for every workspace when env var is unset", async () => {
    mockListWorkspaces([{ id: "ws-a", slug: "a" }, { id: "ws-b", slug: "b" }]);
    const original = process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
    delete process.env.ATLAS_LOADTEST_ALLOWED_ORGS;
    try {
      const res = await app.fetch(platformRequest("GET", "/api/v1/platform/workspaces"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { workspaces: Array<{ neverSuspend: boolean }> };
      expect(body.workspaces.every((w) => w.neverSuspend === false)).toBe(true);
    } finally {
      if (original !== undefined) process.env.ATLAS_LOADTEST_ALLOWED_ORGS = original;
    }
  });
});

// abuseLevel surfacing — workspace_status (DB column) and the in-memory
// abuse level are independent. Before this field, a workspace that the
// abuse detector had auto-suspended via `recordQueryEvent` would still
// render "Active" on /admin/platform because the platform-admin route
// only echoed `workspace_status`. Operators saw a healthy workspace
// while chat returned `workspace_suspended` — the exact divergence this
// suite is the regression floor for.
describe("GET /api/v1/platform/workspaces — abuseLevel surfacing", () => {
  beforeEach(() => {
    mocks.setPlatformAdmin();
    mocks.hasInternalDB = true;
    mockLogWarn.mockClear();
  });

  // Clear in afterEach (not end-of-body) so a thrown assertion doesn't
  // leak `abuseStatusByWorkspace` entries into the next test.
  afterEach(() => {
    abuseStatusByWorkspace.clear();
  });

  function mockListWorkspaces(rows: Array<{ id: string; slug: string }>): void {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM organization o")) {
        return rows.map((r) => ({
          id: r.id,
          name: r.id,
          slug: r.slug,
          workspace_status: "active",
          plan_tier: "starter",
          byot: false,
          stripe_customer_id: null,
          trial_ends_at: null,
          suspended_at: null,
          deleted_at: null,
          region: "us",
          region_assigned_at: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          members: 1,
          conversations: 0,
          queries_last_24h: 0,
          connections: 0,
          scheduled_tasks: 0,
        }));
      }
      return [];
    });
  }

  it("returns abuseLevel='suspended' for a workspace the abuse detector flagged, even when status='active'", async () => {
    // The route reads `checkAbuseStatus` per row. Stub a "suspended"
    // verdict for ws-dharma via `abuseStatusByWorkspace` so the test
    // mirrors a production escalation without depending on the real
    // counter/escalation machinery (covered separately in abuse.test.ts).
    abuseStatusByWorkspace.set("ws-dharma", "suspended");
    mockListWorkspaces([{ id: "ws-dharma", slug: "dharma" }, { id: "ws-clean", slug: "clean" }]);

    const res = await app.fetch(platformRequest("GET", "/api/v1/platform/workspaces"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaces: Array<{ id: string; status: string; abuseLevel?: string }>;
      abuseRestoreStatus?: string;
    };
    const lookup = Object.fromEntries(body.workspaces.map((w) => [w.id, w]));
    expect(lookup["ws-dharma"].status).toBe("active");
    expect(lookup["ws-dharma"].abuseLevel).toBe("suspended");
    expect(lookup["ws-clean"].abuseLevel).toBe("none");
    // The route surfaces the boot-time rehydrate outcome so the page
    // can banner when enforcement is dark. Mock returns "ok".
    expect(body.abuseRestoreStatus).toBe("ok");
  });
});

// #2489 — `/platform/overview` is the home for deployment-wide scaffold
// (entities count, plugin count, plugin health, pool warnings). The
// `/admin/overview` route is no longer allowed to surface deployment-wide
// values, so a regression that re-introduces them on /admin would break
// the platform/org split.
describe("GET /api/v1/platform/overview — deployment scaffold (#2489)", () => {
  beforeEach(() => {
    mocks.setPlatformAdmin();
    mocks.hasInternalDB = true;
    mockLogWarn.mockClear();
  });

  it("returns plugin count, plugin health, and pool warnings", async () => {
    const res = await app.fetch(platformRequest("GET", "/api/v1/platform/overview"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    // `plugins` count comes from the registry mock (default registry is
    // empty). Asserting numeric type rather than 0 keeps the test robust
    // to test-mock fixtures that register a sample plugin later.
    expect(typeof body.plugins).toBe("number");
    expect(Array.isArray(body.pluginHealth)).toBe(true);
    expect(typeof body.entities).toBe("number");
    // requestId is threaded through for log correlation.
    expect(typeof body.requestId).toBe("string");
  });

  it("returns 403 when caller is not a platform admin", async () => {
    // Non-platform-admin (regular org admin) gets blocked by
    // createPlatformRouter — the `platform_admin` role is the gate.
    mocks.setOrgAdmin("org-1");
    const res = await app.fetch(platformRequest("GET", "/api/v1/platform/overview"));
    expect(res.status).toBe(403);
  });
});
