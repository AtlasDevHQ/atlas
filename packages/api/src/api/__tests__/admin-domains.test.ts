/**
 * Tests for admin custom domain API endpoints.
 *
 * Covers the EE-disabled path (loadDomains() returns null) to guarantee write
 * endpoints emit 403 { error: "enterprise_required" } — the contract the web
 * page.tsx `isPlanGated` branch (#1622) and AdminContentWrapper's
 * EnterpriseUpsell routing (feature-disabled.tsx) rely on.
 *
 * Tests the adminDomains sub-router directly (not through the parent admin
 * router) to avoid needing to mock every sub-router dependency.
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
  rateLimitCleanupTick: mock(() => {}),
  _setValidatorOverrides: mock(() => {}),
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "simple-key",
  resetAuthModeCache: () => {},
}));

// --- Internal DB mock ---

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  getInternalDB: () => ({ query: () => Promise.resolve({ rows: [] }), end: async () => {}, on: () => {} }),
  internalQuery: () => Promise.resolve([]),
  internalExecute: () => {},
  getWorkspaceDetails: mock(async () => ({ plan_tier: "free" })),
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// --- EE domains mock: loadDomains returns null to simulate EE-off build ---
//
// The admin-domains.ts router calls `loadDomains()` from shared-domains.ts,
// which dynamic-imports "@atlas/ee/platform/domains" and catches
// MODULE_NOT_FOUND to return null. Mocking shared-domains lets us control
// that null branch directly without having to forge a MODULE_NOT_FOUND
// from the EE import.

const mockLoadDomains: Mock<() => Promise<unknown>> = mock(() => Promise.resolve(null));

// Preserve the real helper exports — customDomainError is consumed by
// runEffect's error mapping. Re-export with the mocked loadDomains.
const realShared = await import("../routes/shared-domains");

mock.module("../routes/shared-domains", () => ({
  CustomDomainSchema: realShared.CustomDomainSchema,
  DomainCheckResponseSchema: realShared.DomainCheckResponseSchema,
  customDomainError: realShared.customDomainError,
  loadDomains: mockLoadDomains,
}));

// --- Import sub-router AFTER mocks ---

const { adminDomains } = await import("../routes/admin-domains");

// --- Helpers ---

function resetMocks() {
  mockLoadDomains.mockImplementation(() => Promise.resolve(null));
  mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: "org-1" },
    }),
  );
}

async function request(urlPath: string, method: string, body?: unknown) {
  const init: RequestInit = { method, headers: {} };
  if (body) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return adminDomains.request(`http://localhost${urlPath}`, init);
}

// --- Tests ---

describe("admin custom domain — EE disabled (loadDomains returns null)", () => {
  beforeEach(resetMocks);

  it("POST / returns 403 enterprise_required so the web isPlanGated branch fires", async () => {
    const res = await request("/", "POST", { domain: "data.acme.com" });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string; message: string; requestId: string };
    expect(json.error).toBe("enterprise_required");
    expect(json.message).toBeTruthy();
    expect(json.requestId).toBeDefined();
  });

  it("DELETE / returns 403 enterprise_required (write endpoint, matches POST)", async () => {
    const res = await request("/", "DELETE");
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("enterprise_required");
  });

  it("POST /verify returns 403 enterprise_required (write endpoint)", async () => {
    const res = await request("/verify", "POST");
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("enterprise_required");
  });

  it("POST /verify-dns returns 403 enterprise_required (write endpoint)", async () => {
    const res = await request("/verify-dns", "POST");
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("enterprise_required");
  });

  it("GET / keeps 404 not_available (read endpoints unchanged per #1623 scope)", async () => {
    // Reads are intentionally untouched — AdminContentWrapper still renders
    // FeatureGate(404) on the page. If a future change wants the full
    // EnterpriseUpsell on page load, reads would need to flip too; for now
    // the issue scope is the dead enterprise_required branch on the write
    // path (#1622 → #1623).
    const res = await request("/", "GET");
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("not_available");
  });
});
