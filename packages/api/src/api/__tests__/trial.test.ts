/**
 * Tests for the member-visible trial status endpoint (#3434).
 *
 * GET /api/v1/trial runs under standardAuth (NOT adminAuth) — every
 * workspace member can see the trial clock instead of discovering the
 * trial via a hard 403 when enforcement cuts the workspace off.
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

const DAY = 86_400_000;

// --- Auth mock: a plain MEMBER (no admin role) ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "user-1", mode: "simple-key", label: "User", role: "member", activeOrganizationId: "org-1" },
    }),
);

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mockAuthenticateRequest,
  checkRateLimit: mock(() => ({ allowed: true })),
  getClientIP: mock(() => null),
  resetRateLimits: mock(() => {}),
  rateLimitCleanupTick: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

void mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "simple-key",
  resetAuthModeCache: () => {},
}));

void mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: mock(() => Promise.resolve([])),
  getStartupWarnings: mock(() => []),
}));

void mock.module("@atlas/api/lib/db/connection", () => createConnectionMock());

// --- Internal DB mock ---

let mockHasInternalDB = true;

const baseWorkspace = {
  id: "org-1",
  name: "Test Org",
  slug: "test-org",
  workspace_status: "active",
  plan_tier: "trial",
  byot: false,
  stripe_customer_id: null,
  trial_ends_at: null,
  suspended_at: null,
  deleted_at: null,
  createdAt: "2026-06-01T00:00:00.000Z",
};

const mockGetWorkspaceDetails: Mock<(orgId: string) => Promise<unknown>> = mock(
  () => Promise.resolve({ ...baseWorkspace }),
);

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getWorkspaceDetails: mockGetWorkspaceDetails,
  getWorkspaceStatus: mock(() => Promise.resolve("active")),
  getInternalDB: () => ({ query: mock(() => Promise.resolve({ rows: [] })), end: mock(() => {}), on: mock(() => {}) }),
  internalQuery: mock(() => Promise.resolve([])),
  internalExecute: () => {},
  updateWorkspaceByot: mock(() => Promise.resolve(true)),
  updateWorkspacePlanTier: mock(() => Promise.resolve(true)),
  setWorkspaceTrialEndsAt: mock(() => Promise.resolve(true)),
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
  setWorkspaceRegion: mock(async () => {}),
  insertSemanticAmendment: mock(async () => "mock-amendment-id"),
  getPendingAmendmentCount: mock(async () => 0),
}));

// --- Metering mock (pulled in via enforcement import chain) ---

void mock.module("@atlas/api/lib/metering", () => ({
  getCurrentPeriodUsage: mock(() => Promise.resolve({ queryCount: 0, tokenCount: 0, activeUsers: 0, periodStart: "", periodEnd: "" })),
  logUsageEvent: () => {},
  aggregateUsageSummary: async () => {},
  getUsageHistory: async () => [],
  getUsageBreakdown: async () => [],
}));

// --- Logger mock ---

void mock.module("@atlas/api/lib/logger", () => ({
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

void mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => [],
  loadSemanticLayer: () => {},
}));

// --- Import trial routes ---

import { trial } from "../routes/trial";
import { invalidatePlanCache } from "@atlas/api/lib/billing/enforcement";
import { OpenAPIHono } from "@hono/zod-openapi";

const app = new OpenAPIHono();
app.route("/api/v1/trial", trial);

function request(path: string, options?: RequestInit) {
  return app.request(`http://localhost${path}`, options);
}

describe("GET /api/v1/trial", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    // The route reads workspaces through enforcement's plan cache — flush it
    // so each test's mockGetWorkspaceDetails implementation is observed.
    invalidatePlanCache();
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: { id: "user-1", mode: "simple-key", label: "User", role: "member", activeOrganizationId: "org-1" },
      }),
    );
    mockGetWorkspaceDetails.mockImplementation(() => Promise.resolve({ ...baseWorkspace }));
  });

  it("returns the trial clock to a plain member (no admin role)", async () => {
    const ends = new Date(Date.now() + 5 * DAY).toISOString();
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ ...baseWorkspace, trial_ends_at: ends }),
    );

    const res = await request("/api/v1/trial");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trial: { startedAt: string; endsAt: string; trialDays: number; expired: boolean } | null };
    expect(body.trial).not.toBeNull();
    expect(body.trial?.endsAt).toBe(ends);
    expect(body.trial?.startedAt).toBe(baseWorkspace.createdAt);
    expect(body.trial?.trialDays).toBe(14);
    expect(body.trial?.expired).toBe(false);
  });

  it("computes the effective end from createdAt when trial_ends_at is NULL (#3434 blind spot)", async () => {
    // createdAt 2026-06-01 + 14d = 2026-06-15
    const res = await request("/api/v1/trial");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trial: { endsAt: string } | null };
    expect(body.trial?.endsAt).toBe("2026-06-15T00:00:00.000Z");
  });

  it("flags an expired trial", async () => {
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({
        ...baseWorkspace,
        trial_ends_at: new Date(Date.now() - DAY).toISOString(),
      }),
    );

    const res = await request("/api/v1/trial");
    const body = (await res.json()) as { trial: { expired: boolean } | null };
    expect(body.trial?.expired).toBe(true);
  });

  it("returns trial: null for non-trial tiers", async () => {
    mockGetWorkspaceDetails.mockImplementation(() =>
      Promise.resolve({ ...baseWorkspace, plan_tier: "pro" }),
    );

    const res = await request("/api/v1/trial");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trial: unknown };
    expect(body.trial).toBeNull();
  });

  it("returns trial: null when there is no internal DB (self-hosted)", async () => {
    mockHasInternalDB = false;
    const res = await request("/api/v1/trial");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trial: unknown };
    expect(body.trial).toBeNull();
  });

  it("returns trial: null when no active organization", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: { id: "user-1", mode: "simple-key", label: "User", role: "member" },
      }),
    );

    const res = await request("/api/v1/trial");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trial: unknown };
    expect(body.trial).toBeNull();
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, mode: "simple-key", status: 401, error: "Invalid or expired token" }),
    );

    const res = await request("/api/v1/trial");
    expect(res.status).toBe(401);
  });
});
