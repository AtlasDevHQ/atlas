/**
 * Route-level tests for /api/v1/discord install + callback.
 *
 * F-04 (security): /install must require an authenticated workspace admin
 * so the OAuth state binds to a real org. Callbacks in SaaS mode must
 * refuse to bind a guild authorization when oauthState.orgId is undefined.
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

const mockSaveDiscordInstallation: Mock<
  (
    guildId: string,
    opts?: { orgId?: string; guildName?: string },
  ) => Promise<void>
> = mock(() => Promise.resolve());

// Mock every export — admin-integrations.ts imports the by-org helpers.
mock.module("@atlas/api/lib/discord/store", () => ({
  saveDiscordInstallation: mockSaveDiscordInstallation,
  getDiscordInstallation: mock(() => Promise.resolve(null)),
  getDiscordInstallationByOrg: mock(() => Promise.resolve(null)),
  deleteDiscordInstallation: mock(() => Promise.resolve()),
  deleteDiscordInstallationByOrg: mock(() => Promise.resolve(false)),
}));

// Discord callback exchanges code → token via fetch. Stub global fetch so
// the SaaS-rejection test never reaches the real Discord API. (The load-bearing
// assertion of the SaaS test is the rejection, which fires before fetch.) Bun's
// per-file isolated runner means leaving fetch swapped is fine for this process.
globalThis.fetch = mock(() =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        access_token: "discord-token",
        token_type: "Bearer",
        guild: { id: "123456789", name: "Test Guild" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  ),
) as unknown as typeof fetch;

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

describe("/api/v1/discord", () => {
  const savedClientId = process.env.DISCORD_CLIENT_ID;
  const savedClientSecret = process.env.DISCORD_CLIENT_SECRET;

  beforeEach(() => {
    process.env.DISCORD_CLIENT_ID = "test_client_id";
    process.env.DISCORD_CLIENT_SECRET = "test_client_secret";
    authResultForTests = { authenticated: true, mode: "none", user: null };
    mockAuthenticateRequest.mockClear();
    mockSaveDiscordInstallation.mockClear();
    mockCheckRateLimit.mockClear();
  });

  afterEach(() => {
    if (savedClientId !== undefined) process.env.DISCORD_CLIENT_ID = savedClientId;
    else delete process.env.DISCORD_CLIENT_ID;
    if (savedClientSecret !== undefined) process.env.DISCORD_CLIENT_SECRET = savedClientSecret;
    else delete process.env.DISCORD_CLIENT_SECRET;
  });

  describe("GET /api/v1/discord/install", () => {
    it("redirects to Discord OAuth when admin is authenticated (implicit-admin mode none)", async () => {
      const app = await getApp();
      const resp = await app.request("/api/v1/discord/install", {
        method: "GET",
        redirect: "manual",
      });
      expect(resp.status).toBe(302);
      const location = resp.headers.get("location") ?? "";
      expect(location).toContain("discord.com/oauth2/authorize");
      expect(location).toContain("test_client_id");
    });

    it("returns 501 when DISCORD_CLIENT_ID is not configured", async () => {
      delete process.env.DISCORD_CLIENT_ID;
      const app = await getApp();
      const resp = await app.request("/api/v1/discord/install", { method: "GET" });
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
      const resp = await app.request("/api/v1/discord/install", {
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
      const resp = await app.request("/api/v1/discord/install", {
        method: "GET",
        redirect: "manual",
      });
      expect(resp.status).toBe(403);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.error).toBe("forbidden_role");
      expect(body.requestId).toBeDefined();
    });
  });

  describe("GET /api/v1/discord/callback", () => {
    // F-04: callback must reject orphan state in SaaS mode
    it("returns 400 in SaaS mode when oauth state has no orgId", async () => {
      const { saveOAuthState, _resetMemoryFallback } = await import(
        "@atlas/api/lib/auth/oauth-state"
      );
      _resetMemoryFallback();
      await saveOAuthState("orphan-discord-state", { provider: "discord" });

      const config = await import("@atlas/api/lib/config");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for the deployMode path
      config._setConfigForTest({ deployMode: "saas" } as any);

      try {
        const app = await getApp();
        const resp = await app.request(
          "/api/v1/discord/callback?code=test_code&state=orphan-discord-state&guild_id=123",
          { method: "GET" },
        );
        expect(resp.status).toBe(400);
        const body = (await resp.json()) as Record<string, unknown>;
        expect(body.error).toBe("missing_org_binding");
        expect(mockSaveDiscordInstallation).not.toHaveBeenCalled();
      } finally {
        config._setConfigForTest(null);
      }
    });

    it("does NOT reject orphan state in self-hosted mode (platform-wide install allowed)", async () => {
      const { saveOAuthState, _resetMemoryFallback } = await import(
        "@atlas/api/lib/auth/oauth-state"
      );
      _resetMemoryFallback();
      await saveOAuthState("orphan-discord-state-sh", { provider: "discord" });

      const config = await import("@atlas/api/lib/config");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial ResolvedConfig is sufficient for the deployMode path
      config._setConfigForTest({ deployMode: "self-hosted" } as any);

      try {
        const app = await getApp();
        const resp = await app.request(
          "/api/v1/discord/callback?code=test_code&state=orphan-discord-state-sh",
          { method: "GET" },
        );
        // Self-hosted MUST NOT reject with the F-04 SaaS guard. Whatever
        // happens after (token exchange success/failure) is tested elsewhere
        // by the existing OAuth callback tests; the load-bearing assertion
        // here is "no missing_org_binding rejection".
        if (resp.status === 400) {
          const body = (await resp.json()) as Record<string, unknown>;
          expect(body.error).not.toBe("missing_org_binding");
        }
      } finally {
        config._setConfigForTest(null);
      }
    });
  });
});
