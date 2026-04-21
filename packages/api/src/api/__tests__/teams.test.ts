/**
 * Route-level tests for /api/v1/teams install + callback.
 *
 * F-04 (security): /install must require an authenticated workspace admin
 * so the OAuth state binds to a real org. Callbacks in SaaS mode must
 * refuse to bind a tenant authorization when oauthState.orgId is undefined.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  type Mock,
} from "bun:test";

// --- Mocks (must be at module top before app import) ---

const mockSaveTeamsInstallation: Mock<
  (tenantId: string, opts?: { orgId?: string }) => Promise<void>
> = mock(() => Promise.resolve());

// Partial mocks would break admin-integrations.ts which imports the by-org helpers.
// Mock every export from teams/store so unrelated routes still load.
mock.module("@atlas/api/lib/teams/store", () => ({
  saveTeamsInstallation: mockSaveTeamsInstallation,
  getTeamsInstallation: mock(() => Promise.resolve(null)),
  getTeamsInstallationByOrg: mock(() => Promise.resolve(null)),
  deleteTeamsInstallation: mock(() => Promise.resolve()),
  deleteTeamsInstallationByOrg: mock(() => Promise.resolve(false)),
}));

// Mutable auth so tests can swap admin / unauth / non-admin
let authResultForTests: {
  authenticated: boolean;
  mode: string;
  status?: number;
  error?: string;
  user?: unknown;
} = { authenticated: true, mode: "none", user: null };

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () => Promise.resolve(authResultForTests),
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

describe("/api/v1/teams", () => {
  const savedAppId = process.env.TEAMS_APP_ID;
  const savedAppPassword = process.env.TEAMS_APP_PASSWORD;

  beforeEach(() => {
    process.env.TEAMS_APP_ID = "test_app_id";
    process.env.TEAMS_APP_PASSWORD = "test_app_password";
    authResultForTests = { authenticated: true, mode: "none", user: null };
    mockAuthenticateRequest.mockClear();
    mockSaveTeamsInstallation.mockClear();
    mockCheckRateLimit.mockClear();
  });

  afterEach(() => {
    if (savedAppId !== undefined) process.env.TEAMS_APP_ID = savedAppId;
    else delete process.env.TEAMS_APP_ID;
    if (savedAppPassword !== undefined) process.env.TEAMS_APP_PASSWORD = savedAppPassword;
    else delete process.env.TEAMS_APP_PASSWORD;
  });

  describe("GET /api/v1/teams/install", () => {
    it("redirects to Azure AD admin consent when admin is authenticated (implicit-admin mode none)", async () => {
      const app = await getApp();
      const resp = await app.request("/api/v1/teams/install", {
        method: "GET",
        redirect: "manual",
      });
      expect(resp.status).toBe(302);
      const location = resp.headers.get("location") ?? "";
      expect(location).toContain("login.microsoftonline.com");
      expect(location).toContain("test_app_id");
    });

    it("returns 501 when TEAMS_APP_ID is not configured", async () => {
      delete process.env.TEAMS_APP_ID;
      const app = await getApp();
      const resp = await app.request("/api/v1/teams/install", { method: "GET" });
      expect(resp.status).toBe(501);
    });

    // F-04: anonymous /install was an install-hijack vector
    it("returns 401 when caller is unauthenticated (managed mode)", async () => {
      authResultForTests = {
        authenticated: false,
        mode: "managed",
        status: 401,
        error: "Authentication required",
      };
      const app = await getApp();
      const resp = await app.request("/api/v1/teams/install", {
        method: "GET",
        redirect: "manual",
      });
      expect(resp.status).toBe(401);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.requestId).toBeDefined();
    });

    it("returns 403 when caller is authenticated but not an admin", async () => {
      authResultForTests = {
        authenticated: true,
        mode: "managed",
        user: {
          id: "user-1",
          mode: "managed",
          label: "User",
          role: "member",
          activeOrganizationId: "org-test",
        },
      };
      const app = await getApp();
      const resp = await app.request("/api/v1/teams/install", {
        method: "GET",
        redirect: "manual",
      });
      expect(resp.status).toBe(403);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.error).toBe("forbidden_role");
      expect(body.requestId).toBeDefined();
    });
  });

  describe("GET /api/v1/teams/callback", () => {
    // F-04: callback must reject orphan state in SaaS mode
    it("returns 400 in SaaS mode when oauth state has no orgId", async () => {
      const { saveOAuthState, _resetMemoryFallback } = await import(
        "@atlas/api/lib/auth/oauth-state"
      );
      _resetMemoryFallback();
      await saveOAuthState("orphan-teams-state", { provider: "teams" });

      const config = await import("@atlas/api/lib/config");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for the deployMode path
      config._setConfigForTest({ deployMode: "saas" } as any);

      try {
        const app = await getApp();
        // tenant must be a valid UUID — mint one for the request
        const tenant = "11111111-2222-3333-4444-555555555555";
        const resp = await app.request(
          `/api/v1/teams/callback?state=orphan-teams-state&tenant=${tenant}&admin_consent=True`,
          { method: "GET" },
        );
        expect(resp.status).toBe(400);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.error).toBe("missing_org_binding");
        expect(mockSaveTeamsInstallation).not.toHaveBeenCalled();
      } finally {
        config._setConfigForTest(null);
      }
    });

    it("allows orphan state in self-hosted mode (platform-wide install)", async () => {
      const { saveOAuthState, _resetMemoryFallback } = await import(
        "@atlas/api/lib/auth/oauth-state"
      );
      _resetMemoryFallback();
      await saveOAuthState("orphan-teams-state-sh", { provider: "teams" });

      const config = await import("@atlas/api/lib/config");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for the deployMode path
      config._setConfigForTest({ deployMode: "self-hosted" } as any);

      try {
        const app = await getApp();
        const tenant = "11111111-2222-3333-4444-555555555555";
        const resp = await app.request(
          `/api/v1/teams/callback?state=orphan-teams-state-sh&tenant=${tenant}&admin_consent=True`,
          { method: "GET" },
        );
        expect(resp.status).toBe(200);
        expect(mockSaveTeamsInstallation).toHaveBeenCalledWith(tenant, { orgId: undefined });
      } finally {
        config._setConfigForTest(null);
      }
    });
  });
});
