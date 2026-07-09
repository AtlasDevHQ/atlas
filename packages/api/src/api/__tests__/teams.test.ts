/**
 * Route-level tests for /api/v1/teams — Azure AD admin-consent install,
 * now cap-gated (#3142).
 *
 * Teams is OAuth-shaped: the admin-consent callback returns an
 * Azure-verified tenant id (ownership proof). The callback dispatches that
 * tenant into the cap-gated static-bot handler (`confirmInstall` →
 * `checkChatIntegrationLimitAndInstall` → `workspace_plugins`) instead of
 * the retired uncapped `saveTeamsInstallation` write.
 *
 * F-04 (security): /install must require an authenticated workspace admin
 * so the OAuth state binds to a real org. Callbacks in SaaS mode must
 * refuse to bind a tenant when `oauthState.orgId` is undefined.
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

// The cap-gated install handler dispatched from the callback. We assert
// confirmInstall is called with (workspaceId, tenant) and can make it throw
// per-case (e.g. at-cap).
const mockConfirmInstall: Mock<
  (workspaceId: string, tenantId: string, proof?: string, extras?: unknown) => Promise<{ installRecord: { id: string } }>
> = mock(() => Promise.resolve({ installRecord: { id: "teams-install-1" } }));

mock.module("@atlas/api/lib/integrations/install/dispatch", () => ({
  getInstallHandler: mock(() => ({ kind: "static-bot" as const, oauthShaped: true as const, confirmInstall: mockConfirmInstall })),
  hasFormInstallHandler: mock(() => false),
  registerOAuthHandler: mock(() => {}),
  registerFormHandler: mock(() => {}),
  registerStaticBotHandler: mock(() => {}),
  registerOAuthDatasourceHandler: mock(() => {}),
  _resetInstallHandlerRegistries: mock(() => {}),
}));

// `@atlas/api/lib/teams/store` was deleted in #3161 — admin-integrations.ts no
// longer imports it (the legacy disconnect path was removed), so no mock needed.

// Mutable auth so tests can swap admin / unauth.
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

describe("/api/v1/teams (Azure admin-consent, cap-gated — #3142)", () => {
  const savedAppId = process.env.TEAMS_APP_ID;
  const savedAppPassword = process.env.TEAMS_APP_PASSWORD;

  beforeEach(() => {
    process.env.TEAMS_APP_ID = "test_app_id";
    process.env.TEAMS_APP_PASSWORD = "test_app_password";
    authResultForTests = { authenticated: true, mode: "none", user: null };
    mockAuthenticateRequest.mockClear();
    mockConfirmInstall.mockClear();
    mockConfirmInstall.mockImplementation(() => Promise.resolve({ installRecord: { id: "teams-install-1" } }));
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
      const resp = await app.request("/api/v1/teams/install", { method: "GET", redirect: "manual" });
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

    it("returns 401 when caller is unauthenticated (managed mode)", async () => {
      authResultForTests = { authenticated: false, mode: "managed", status: 401, error: "Authentication required" };
      const app = await getApp();
      const resp = await app.request("/api/v1/teams/install", { method: "GET", redirect: "manual" });
      expect(resp.status).toBe(401);
    });
  });

  describe("GET /api/v1/teams/callback", () => {
    it("dispatches the Azure-verified tenant into the cap-gated handler and redirects on success", async () => {
      const { saveOAuthState, _resetMemoryFallback } = await import("@atlas/api/lib/auth/oauth-state");
      _resetMemoryFallback();
      await saveOAuthState("teams-cb-ok", { orgId: "org-teams", provider: "teams" });

      const config = await import("@atlas/api/lib/config");
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for the deployMode path
      config._setConfigForTest({ deployMode: "self-hosted" } as any);
      try {
        const app = await getApp();
        const tenant = "11111111-2222-3333-4444-555555555555";
        const resp = await app.request(
          `/api/v1/teams/callback?state=teams-cb-ok&tenant=${tenant}&admin_consent=True`,
          { method: "GET", redirect: "manual" },
        );
        // No web origin configured in tests -> 200 HTML success.
        expect([200, 302]).toContain(resp.status);
        // The cap-gated handler ran with the verified tenant + bound workspace.
        expect(mockConfirmInstall).toHaveBeenCalledTimes(1);
        const [ws, tid] = mockConfirmInstall.mock.calls[0];
        expect(ws).toBe("org-teams");
        expect(tid).toBe(tenant);
      } finally {
        config._setConfigForTest(null);
      }
    });

    it("returns 400 in SaaS mode when oauth state has no orgId, and never installs", async () => {
      const { saveOAuthState, _resetMemoryFallback } = await import("@atlas/api/lib/auth/oauth-state");
      _resetMemoryFallback();
      await saveOAuthState("teams-cb-orphan", { provider: "teams" });

      const config = await import("@atlas/api/lib/config");
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for the deployMode path
      config._setConfigForTest({ deployMode: "saas" } as any);
      try {
        const app = await getApp();
        const tenant = "11111111-2222-3333-4444-555555555555";
        const resp = await app.request(
          `/api/v1/teams/callback?state=teams-cb-orphan&tenant=${tenant}&admin_consent=True`,
          { method: "GET" },
        );
        expect(resp.status).toBe(400);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.error).toBe("missing_org_binding");
        expect(mockConfirmInstall).not.toHaveBeenCalled();
      } finally {
        config._setConfigForTest(null);
      }
    });

    it("surfaces a failure (not a crash) when the workspace is at its chat-integration cap", async () => {
      const { ChatIntegrationLimitError } = await import("@atlas/api/lib/effect/errors");
      mockConfirmInstall.mockImplementationOnce(() =>
        Promise.reject(new ChatIntegrationLimitError({ message: "at cap", workspaceId: "org-teams", limit: 1 })),
      );
      const { saveOAuthState, _resetMemoryFallback } = await import("@atlas/api/lib/auth/oauth-state");
      _resetMemoryFallback();
      await saveOAuthState("teams-cb-cap", { orgId: "org-teams", provider: "teams" });

      const config = await import("@atlas/api/lib/config");
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for the deployMode path
      config._setConfigForTest({ deployMode: "self-hosted" } as any);
      try {
        const app = await getApp();
        const tenant = "11111111-2222-3333-4444-555555555555";
        const resp = await app.request(
          `/api/v1/teams/callback?state=teams-cb-cap&tenant=${tenant}&admin_consent=True`,
          { method: "GET", redirect: "manual" },
        );
        // No web origin -> HTML 500 "Installation Failed"; with one it'd be a 302.
        expect([302, 500]).toContain(resp.status);
        expect(mockConfirmInstall).toHaveBeenCalledTimes(1);
      } finally {
        config._setConfigForTest(null);
      }
    });
  });
});
