/**
 * Tests for billing API endpoints.
 *
 * Covers: GET /billing, POST /billing/byot. (The portal route was
 * deleted in #3417 — portal access goes through the Better Auth Stripe
 * plugin's /subscription/billing-portal; see stripe-billing-portal.test.ts.)
 */

import { createConnectionMock } from "@atlas/api/testing/connection";
import {
  describe,
  it,
  expect,
  beforeEach,
  mock,
  type Mock,
} from "bun:test";

// --- Auth mock ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "user-1", mode: "simple-key", label: "User", role: "admin", activeOrganizationId: "org-1" },
    }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  rateLimitCleanupTick: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "simple-key",
  resetAuthModeCache: () => {},
}));

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: mock(() => []),
}));

mock.module("@atlas/api/lib/db/connection", () => createConnectionMock());

// --- Internal DB mock ---

let mockHasInternalDB = true;

const mockWorkspace = {
  id: "org-1",
  name: "Test Org",
  slug: "test-org",
  workspace_status: "active",
  plan_tier: "starter",
  byot: false,
  stripe_customer_id: "cus_test_123",
  trial_ends_at: null,
  suspended_at: null,
  deleted_at: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const mockGetWorkspaceDetails: Mock<(orgId: string) => Promise<unknown>> = mock(
  () => Promise.resolve({ ...mockWorkspace }),
);

const mockUpdateWorkspaceByot: Mock<(orgId: string, byot: boolean) => Promise<boolean>> = mock(
  () => Promise.resolve(true),
);

const mockInternalQuery: Mock<(...args: unknown[]) => Promise<unknown[]>> = mock(
  () => Promise.resolve([]),
);

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getWorkspaceDetails: mockGetWorkspaceDetails,
  updateWorkspaceByot: mockUpdateWorkspaceByot,
  getWorkspaceStatus: mock(() => Promise.resolve("active")),
  getInternalDB: () => ({ query: mock(() => Promise.resolve({ rows: [] })), end: mock(() => {}), on: mock(() => {}) }),
  internalQuery: mockInternalQuery,
  internalExecute: () => {},
  updateWorkspacePlanTier: mock(() => Promise.resolve(true)),
  setWorkspaceTrialEndsAt: mock(() => Promise.resolve(true)),
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
}));

// --- Metering mock ---

const mockUsage = {
  queryCount: 500,
  tokenCount: 25_000,
  activeUsers: 3,
  periodStart: "2026-03-01T00:00:00.000Z",
  periodEnd: "2026-04-01T00:00:00.000Z",
};

mock.module("@atlas/api/lib/metering", () => ({
  getCurrentPeriodUsage: mock(() => Promise.resolve({ ...mockUsage })),
  logUsageEvent: () => {},
  aggregateUsageSummary: async () => {},
  getUsageHistory: async () => [],
  getUsageBreakdown: async () => [],
}));

// --- Settings mock ---

// Only ATLAS_MODEL is a per-workspace override surfaced in the billing picker.
// ATLAS_PROVIDER is a deploy-level choice resolved from env, so the mock
// returns the saved model only for that key (mirrors the real store).
let mockSettingLiveValue: string | undefined = undefined;

mock.module("@atlas/api/lib/settings", () => ({
  getSettingLive: mock((key: string) =>
    Promise.resolve(key === "ATLAS_MODEL" ? mockSettingLiveValue : undefined),
  ),
  getSetting: mock(() => undefined),
  getSettingAuto: mock(() => undefined),
  setSetting: mock(async () => {}),
  deleteSetting: mock(async () => {}),
  loadSettings: mock(async () => 0),
  getSettingsForAdmin: mock(() => []),
  getSettingsRegistry: mock(() => []),
  getSettingDefinition: mock(() => undefined),
  getAllSettingOverrides: mock(async () => []),
  refreshSettingsTick: mock(async () => {}),
  _resetSettingsCache: mock(() => {}),
}));

// --- Logger mock ---

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  getRequestContext: () => null,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// --- Semantic mock (required by some route imports) ---

mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => [],
  loadSemanticLayer: () => {},
}));

// --- Import billing routes ---

import { billing } from "../routes/billing";
// Real resolver (not mocked) — the SSOT the billing endpoint and the agent
// loop share. Tests assert the endpoint reports exactly what this resolves so
// the picker default can't drift from the billed default (#3098).
import { resolveModelId } from "@atlas/api/lib/providers";
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono();
app.route("/api/v1/billing", billing);

function request(path: string, options?: RequestInit) {
  return app.request(`http://localhost${path}`, options);
}

// --- Tests ---

describe("billing routes", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockSettingLiveValue = undefined;
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: { id: "user-1", mode: "simple-key", label: "User", role: "admin", activeOrganizationId: "org-1" },
      }),
    );
    mockGetWorkspaceDetails.mockImplementation(() => Promise.resolve({ ...mockWorkspace }));
    mockUpdateWorkspaceByot.mockImplementation(() => Promise.resolve(true));
    mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  });

  // ── GET /billing ──────────────────────────────────────────────────

  describe("GET /api/v1/billing", () => {
    it("returns billing status for workspace", async () => {
      // Return seat count of 3 for member query, connection count of 2 for connections query
      mockInternalQuery.mockImplementation((...args: unknown[]) => {
        const sql = args[0];
        if (typeof sql === "string" && sql.includes("member")) {
          return Promise.resolve([{ count: 3 }]);
        }
        if (typeof sql === "string" && sql.includes("workspace_plugins") && sql.includes("pillar = 'datasource'")) {
          return Promise.resolve([{ count: 2 }]);
        }
        return Promise.resolve([]);
      });

      const res = await request("/api/v1/billing");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions on response shape
      const body = await res.json() as any;
      expect(body.workspaceId).toBe("org-1");
      expect(body.plan.tier).toBe("starter");
      expect(body.plan.displayName).toBe("Starter");
      expect(body.plan.byot).toBe(false);
      expect(body.plan.pricePerSeat).toBe(29);
      expect(body.limits.tokenBudgetPerSeat).toBeGreaterThan(0);
      expect(body.usage.queryCount).toBe(500);
      // Per-seat pricing fields
      expect(body.seats).toEqual({ count: 3, max: 10 });
      expect(body.connections).toEqual({ count: 2, max: 1 });
      // SSOT (#3098): with nothing saved, currentModel is exactly what the
      // agent loop resolves — NOT the plan's recommended model. Asserting
      // against the shared resolver guards against the picker advertising one
      // model while another is billed.
      expect(body.currentModel).toBe(resolveModelId(undefined, undefined));
      expect(body.overagePerMillionTokens).toBe(1.0);
      // Total token budget = tokenBudgetPerSeat * seatCount = 2M * 3 = 6M
      expect(body.limits.totalTokenBudget).toBe(6_000_000);
      // #3418 — the plan picker's source of truth. All three paid tiers are
      // always listed; `configured` reflects whether the deployment has the
      // tier's Stripe Price ID env var (none set in this test env).
      expect(body.availablePlans.map((p: { tier: string }) => p.tier)).toEqual([
        "starter",
        "pro",
        "business",
      ]);
      expect(body.availablePlans[0]).toMatchObject({
        tier: "starter",
        displayName: "Starter",
        pricePerSeat: 29,
        tokenBudgetPerSeat: 2_000_000,
        maxSeats: 10,
        maxConnections: 1,
      });
      expect(body.availablePlans[2]).toMatchObject({
        tier: "business",
        maxSeats: null,
        maxConnections: null,
      });
      // #3434 — non-trial tiers carry no effective trial end; trialDays is
      // null because paid tiers have no trialDays in their plan definition.
      expect(body.plan.trialEndsAtEffective).toBeNull();
      expect(body.plan.trialDays).toBeNull();
    });

    it("computes trialEndsAtEffective from trial_ends_at for trial workspaces (#3434)", async () => {
      const trialEnds = "2026-06-20T00:00:00.000Z";
      mockGetWorkspaceDetails.mockImplementation(() =>
        Promise.resolve({ ...mockWorkspace, plan_tier: "trial", trial_ends_at: trialEnds }),
      );

      const res = await request("/api/v1/billing");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions on response shape
      const body = await res.json() as any;
      expect(body.plan.tier).toBe("trial");
      expect(body.plan.trialEndsAtEffective).toBe(trialEnds);
      expect(body.plan.trialDays).toBe(14);
    });

    it("falls back to createdAt + TRIAL_DAYS when a trial workspace has NULL trial_ends_at (#3434)", async () => {
      mockGetWorkspaceDetails.mockImplementation(() =>
        Promise.resolve({ ...mockWorkspace, plan_tier: "trial", trial_ends_at: null }),
      );

      const res = await request("/api/v1/billing");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions on response shape
      const body = await res.json() as any;
      // mockWorkspace.createdAt = 2026-01-01 → +14d = 2026-01-15. The exact
      // date enforcement's isTrialExpired fallback computes.
      expect(body.plan.trialEndsAt).toBeNull();
      expect(body.plan.trialEndsAtEffective).toBe("2026-01-15T00:00:00.000Z");
    });

    it("defaults seat count to 1 when member query fails", async () => {
      mockInternalQuery.mockImplementation((...args: unknown[]) => {
        const sql = args[0];
        if (typeof sql === "string" && sql.includes("member")) {
          return Promise.reject(new Error("relation does not exist"));
        }
        return Promise.resolve([]);
      });

      const res = await request("/api/v1/billing");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions on response shape
      const body = await res.json() as any;
      expect(body.seats.count).toBe(1);
      // Budget should be tokenBudgetPerSeat * 1 = 2M
      expect(body.limits.totalTokenBudget).toBe(2_000_000);
    });

    it("defaults connection count to 0 when connections query fails", async () => {
      mockInternalQuery.mockImplementation((...args: unknown[]) => {
        const sql = args[0];
        if (typeof sql === "string" && sql.includes("workspace_plugins") && sql.includes("pillar = 'datasource'")) {
          return Promise.reject(new Error("relation does not exist"));
        }
        if (typeof sql === "string" && sql.includes("member")) {
          return Promise.resolve([{ count: 2 }]);
        }
        return Promise.resolve([]);
      });

      const res = await request("/api/v1/billing");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions on response shape
      const body = await res.json() as any;
      expect(body.connections.count).toBe(0);
    });

    it("reports the gateway provider default (Sonnet 4.6) when nothing is saved (#3098)", async () => {
      // The exact bug: on the SaaS gateway path with no saved model, the
      // picker must show what actually runs — Sonnet 4.6 — not the plan's
      // recommended model and not a hardcoded UI fallback.
      const origProvider = process.env.ATLAS_PROVIDER;
      const origModel = process.env.ATLAS_MODEL;
      process.env.ATLAS_PROVIDER = "gateway";
      delete process.env.ATLAS_MODEL;
      try {
        mockSettingLiveValue = undefined; // nothing persisted
        mockInternalQuery.mockImplementation((...args: unknown[]) => {
          const sql = args[0];
          if (typeof sql === "string" && sql.includes("member")) {
            return Promise.resolve([{ count: 1 }]);
          }
          return Promise.resolve([]);
        });

        const res = await request("/api/v1/billing");
        expect(res.status).toBe(200);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions on response shape
        const body = await res.json() as any;
        expect(body.currentModel).toBe("anthropic/claude-sonnet-4.6");
      } finally {
        if (origProvider !== undefined) process.env.ATLAS_PROVIDER = origProvider;
        else delete process.env.ATLAS_PROVIDER;
        if (origModel !== undefined) process.env.ATLAS_MODEL = origModel;
        else delete process.env.ATLAS_MODEL;
      }
    });

    it("uses setting override for currentModel when available", async () => {
      mockSettingLiveValue = "anthropic/claude-opus-4.8";
      mockInternalQuery.mockImplementation((...args: unknown[]) => {
        const sql = args[0];
        if (typeof sql === "string" && sql.includes("member")) {
          return Promise.resolve([{ count: 1 }]);
        }
        return Promise.resolve([]);
      });

      const res = await request("/api/v1/billing");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions on response shape
      const body = await res.json() as any;
      expect(body.currentModel).toBe("anthropic/claude-opus-4.8");
    });

    it("returns 401 when unauthenticated", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({ authenticated: false, error: "No credentials", status: 401 }),
      );
      const res = await request("/api/v1/billing");
      expect(res.status).toBe(401);
    });

    it("returns 404 when no internal DB", async () => {
      mockHasInternalDB = false;
      const res = await request("/api/v1/billing");
      expect(res.status).toBe(404);
    });

    it("returns 404 when workspace not found", async () => {
      mockGetWorkspaceDetails.mockImplementation(() => Promise.resolve(null));
      const res = await request("/api/v1/billing");
      expect(res.status).toBe(404);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions on response shape
      const body = await res.json() as any;
      expect(body.error).toBe("not_found");
    });

    it("returns 400 when no active org", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "admin", activeOrganizationId: undefined },
        }),
      );
      const res = await request("/api/v1/billing");
      expect(res.status).toBe(400);
    });
  });

  // ── POST /billing/byot ───────────────────────────────────────────

  describe("POST /api/v1/billing/byot", () => {
    it("toggles BYOT flag", async () => {
      const res = await request("/api/v1/billing/byot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions on response shape
      const body = await res.json() as any;
      expect(body.byot).toBe(true);
      expect(body.workspaceId).toBe("org-1");
    });

    it("returns 400 when missing enabled field", async () => {
      const res = await request("/api/v1/billing/byot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(422);
    });

    it("returns 404 when workspace not found", async () => {
      mockUpdateWorkspaceByot.mockImplementation(() => Promise.resolve(false));
      const res = await request("/api/v1/billing/byot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(404);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions on response shape
      const body = await res.json() as any;
      expect(body.error).toBe("not_found");
    });

    it("returns 403 for non-admin users", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "member", activeOrganizationId: "org-1" },
        }),
      );
      const res = await request("/api/v1/billing/byot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(403);
    });

    // #2240 — platform_admin (system-wide superuser) was getting 403 because
    // the inline gate was hardcoded to {admin, owner}. The outer adminAuth
    // already accepts platform_admin, so the inner check now needs to match.
    it("allows platform_admin to toggle BYOT", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "platform_admin", activeOrganizationId: "org-1" },
        }),
      );
      const res = await request("/api/v1/billing/byot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions on response shape
      const body = await res.json() as any;
      expect(body.byot).toBe(true);
    });

    it("allows owner role to toggle BYOT", async () => {
      mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "owner", activeOrganizationId: "org-1" },
        }),
      );
      const res = await request("/api/v1/billing/byot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
    });
  });
});
