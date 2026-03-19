/**
 * Tests for billing API endpoints.
 *
 * Covers: GET /billing, POST /billing/portal, POST /billing/byot.
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
  _stopCleanup: mock(() => {}),
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
  plan_tier: "team",
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
  setWorkspaceStripeCustomerId: mock(() => Promise.resolve(true)),
  setWorkspaceTrialEndsAt: mock(() => Promise.resolve(true)),
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
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

// --- Stripe mock ---

mock.module("stripe", () => ({
  default: class StripeMock {
    billingPortal = {
      sessions: {
        create: mock(() => Promise.resolve({ url: "https://billing.stripe.com/session/test_123" })),
      },
    };
  },
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
import { Hono } from "hono";

const app = new Hono();
app.route("/api/v1/billing", billing);

function request(path: string, options?: RequestInit) {
  return app.request(`http://localhost${path}`, options);
}

// --- Tests ---

describe("billing routes", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
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
      const res = await request("/api/v1/billing");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions on response shape
      const body = await res.json() as any;
      expect(body.workspaceId).toBe("org-1");
      expect(body.plan.tier).toBe("team");
      expect(body.plan.displayName).toBe("Team");
      expect(body.plan.byot).toBe(false);
      expect(body.limits.queriesPerMonth).toBeGreaterThan(0);
      expect(body.usage.queryCount).toBe(500);
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

  // ── POST /billing/portal ──────────────────────────────────────────

  describe("POST /api/v1/billing/portal", () => {
    it("returns portal URL", async () => {
      // Need STRIPE_SECRET_KEY for the portal route to create a Stripe client
      process.env.STRIPE_SECRET_KEY = "sk_test_fake";
      const res = await request("/api/v1/billing/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnUrl: "http://localhost:3000/settings" }),
      });
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions on response shape
      const body = await res.json() as any;
      expect(body.url).toContain("stripe.com");
      delete process.env.STRIPE_SECRET_KEY;
    });

    it("returns 400 when no stripe customer", async () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_fake";
      mockGetWorkspaceDetails.mockImplementation(() =>
        Promise.resolve({ ...mockWorkspace, stripe_customer_id: null }),
      );
      const res = await request("/api/v1/billing/portal", { method: "POST" });
      expect(res.status).toBe(400);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertions on response shape
      const body = await res.json() as any;
      expect(body.error).toBe("no_customer");
      delete process.env.STRIPE_SECRET_KEY;
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
      expect(res.status).toBe(400);
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
  });
});
