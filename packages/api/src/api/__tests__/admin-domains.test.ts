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

/**
 * Assert the contract shape that `AdminContentWrapper.isEnterpriseRequired()`
 * and `page.tsx` isPlanGated depend on: `{ error: "enterprise_required",
 * message: <non-empty>, requestId: <defined> }`. Pulled into a helper so every
 * write-path test locks down the same shape — otherwise adding a new write
 * endpoint with a subtly different shape would slip through.
 */
async function expectEnterpriseRequired403(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const json = (await res.json()) as { error: string; message: string; requestId: string };
  expect(json.error).toBe("enterprise_required");
  expect(json.message).toBeTruthy();
  expect(json.requestId).toBeDefined();
}

describe("admin custom domain — EE disabled (loadDomains returns null)", () => {
  beforeEach(resetMocks);

  it("POST / returns 403 enterprise_required so the web isPlanGated branch fires", async () => {
    const res = await request("/", "POST", { domain: "data.acme.com" });
    await expectEnterpriseRequired403(res);
  });

  it("DELETE / returns 403 enterprise_required (write endpoint, matches POST)", async () => {
    const res = await request("/", "DELETE");
    await expectEnterpriseRequired403(res);
  });

  it("POST /verify returns 403 enterprise_required (write endpoint)", async () => {
    const res = await request("/verify", "POST");
    await expectEnterpriseRequired403(res);
  });

  it("POST /verify-dns returns 403 enterprise_required (write endpoint)", async () => {
    const res = await request("/verify-dns", "POST");
    await expectEnterpriseRequired403(res);
  });

  it("message does not leak EE module internals (no MODULE_NOT_FOUND, stack, @atlas/ee)", async () => {
    // `classifyError` sanitizes domain-error messages for 5xx but passes 4xx
    // messages through. The EnterpriseError message is hand-authored in
    // admin-domains.ts (EE_REQUIRED_MESSAGE), so this guards against a future
    // refactor that accidentally stringifies a module-load error into the
    // response body. A user-facing 403 should never expose infra internals.
    const res = await request("/", "POST", { domain: "data.acme.com" });
    const json = (await res.json()) as { message: string };
    expect(json.message).not.toMatch(/MODULE_NOT_FOUND|stack|@atlas\/ee/i);
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
