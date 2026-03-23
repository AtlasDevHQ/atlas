/**
 * Tests for admin onboarding email API endpoints.
 *
 * Tests the adminOnboardingEmails sub-router directly.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";

// --- Auth mock ---

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: "org-1" },
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

// --- Internal DB mock ---

let mockHasInternalDB = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  getInternalDB: () => ({ query: () => Promise.resolve({ rows: [] }), end: async () => {}, on: () => {} }),
  internalQuery: mock(() => Promise.resolve([])),
  internalExecute: mock(() => {}),
}));

// --- Email engine mock ---

let mockStatuses: { statuses: Array<Record<string, unknown>>; total: number } = { statuses: [], total: 0 };
let mockEnabled = true;

mock.module("@atlas/api/lib/email/engine", () => ({
  getOnboardingStatuses: mock(() => Promise.resolve(mockStatuses)),
  isOnboardingEmailEnabled: () => mockEnabled,
}));

mock.module("@atlas/api/lib/email/sequence", () => ({
  ONBOARDING_SEQUENCE: [
    { step: "welcome", trigger: "signup_completed", fallbackHours: 0, subject: "Welcome to {{appName}}", description: "Welcome email" },
    { step: "connect_database", trigger: "database_connected", fallbackHours: 24, subject: "Connect your database", description: "Guide" },
  ],
}));

// --- Logger mock ---

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  withRequestContext: (_id: string, fn: () => unknown) => fn(),
}));

// --- Import router after mocks ---

const { adminOnboardingEmails } = await import("../routes/admin-onboarding-emails");

describe("GET /api/v1/admin/onboarding-emails", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
    mockEnabled = true;
    mockStatuses = { statuses: [], total: 0 };
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: "org-1" },
      }),
    );
  });

  it("returns 200 with empty statuses", async () => {
    const res = await adminOnboardingEmails.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; statuses: unknown[]; total: number };
    expect(body.enabled).toBe(true);
    expect(body.statuses).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("returns statuses when users exist", async () => {
    mockStatuses = {
      statuses: [
        {
          userId: "u1",
          email: "user@example.com",
          orgId: "org-1",
          sentSteps: ["welcome"],
          pendingSteps: ["connect_database", "first_query", "invite_team", "explore_features"],
          unsubscribed: false,
          createdAt: "2026-03-20T00:00:00Z",
        },
      ],
      total: 1,
    };

    const res = await adminOnboardingEmails.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; statuses: Array<{ sentSteps: string[] }> };
    expect(body.total).toBe(1);
    expect(body.statuses[0].sentSteps).toEqual(["welcome"]);
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({ authenticated: false, status: 401, error: "Invalid or expired token" }),
    );

    const res = await adminOnboardingEmails.request("/");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/admin/onboarding-emails/sequence", () => {
  beforeEach(() => {
    mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "simple-key",
        user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: "org-1" },
      }),
    );
  });

  it("returns sequence definition", async () => {
    const res = await adminOnboardingEmails.request("/sequence");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; steps: Array<{ step: string }> };
    expect(body.enabled).toBe(true);
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0].step).toBe("welcome");
  });
});
