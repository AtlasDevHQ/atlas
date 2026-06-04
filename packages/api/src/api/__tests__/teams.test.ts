/**
 * Route-level tests for /api/v1/teams — RETIRED legacy OAuth routes (#3142).
 *
 * The Azure AD admin-consent install/callback dance was retired under
 * umbrella #2994 because it wrote an UNCAPPED `teams_installations` row
 * (bypassing the chat-integration cap) and produced a non-routable bind.
 * Teams now installs via the cap-gated static-bot `/install-form` flow.
 *
 * These tests pin the retirement contract: both routes return 410 Gone
 * and NEVER call `saveTeamsInstallation` (the uncapped write).
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  mock,
  type Mock,
} from "bun:test";

// --- Mocks (must be at module top before app import) ---

const mockSaveTeamsInstallation: Mock<
  (tenantId: string, opts?: { orgId?: string }) => Promise<void>
> = mock(() => Promise.resolve());

// Partial mocks would break admin-integrations.ts which imports the by-org
// helpers (the legacy disconnect path, retired separately in #3154). Mock
// every export from teams/store so unrelated routes still load.
mock.module("@atlas/api/lib/teams/store", () => ({
  saveTeamsInstallation: mockSaveTeamsInstallation,
  getTeamsInstallation: mock(() => Promise.resolve(null)),
  getTeamsInstallationByOrg: mock(() => Promise.resolve(null)),
  deleteTeamsInstallation: mock(() => Promise.resolve()),
  deleteTeamsInstallationByOrg: mock(() => Promise.resolve(false)),
}));

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () => Promise.resolve({ authenticated: true, mode: "none", user: null }),
);

const mockCheckRateLimit: Mock<() => { allowed: boolean; retryAfterMs?: number }> = mock(
  () => ({ allowed: true }),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  checkRateLimit: mockCheckRateLimit,
  authenticateRequest: mockAuthenticateRequest,
  getClientIP: mock(() => "127.0.0.1"),
  rateLimitCleanupTick: mock(() => {}),
}));

// --- Test setup ---

async function getApp() {
  const { app } = await import("../../api/index");
  return app;
}

describe("/api/v1/teams (retired legacy OAuth routes — #3142)", () => {
  beforeEach(() => {
    mockSaveTeamsInstallation.mockClear();
  });

  it("GET /install returns 410 Gone and never starts an OAuth dance", async () => {
    const app = await getApp();
    const resp = await app.request("/api/v1/teams/install", {
      method: "GET",
      redirect: "manual",
    });
    expect(resp.status).toBe(410);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.error).toBe("endpoint_retired");
    expect(body.requestId).toBeDefined();
    // The retirement message points the caller at the new install surface.
    expect(String(body.message)).toMatch(/Admin → Integrations/);
    // Critically: the legacy uncapped install write must never fire.
    expect(mockSaveTeamsInstallation).not.toHaveBeenCalled();
  });

  it("GET /callback returns 410 Gone and never writes an (uncapped) install", async () => {
    const app = await getApp();
    // Even with a well-formed-looking legacy callback, no tenant is bound.
    const tenant = "11111111-2222-3333-4444-555555555555";
    const resp = await app.request(
      `/api/v1/teams/callback?state=legacy&tenant=${tenant}&admin_consent=True`,
      { method: "GET" },
    );
    expect(resp.status).toBe(410);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.error).toBe("endpoint_retired");
    expect(mockSaveTeamsInstallation).not.toHaveBeenCalled();
  });
});
