/**
 * Route-level tests for /api/v1/discord — RETIRED legacy OAuth routes (#3145).
 *
 * The legacy Discord OAuth install/callback wrote an UNCAPPED
 * `discord_installations` row (bypassing the chat-integration cap). It's
 * retired in favor of the cap-gated `/api/v1/integrations/discord/*` flow
 * (`DiscordStaticBotInstallHandler.confirmInstall` →
 * `checkChatIntegrationLimitAndInstall`).
 *
 * These tests pin the retirement contract: both routes return 410 Gone and
 * NEVER call `saveDiscordInstallation` (the uncapped write).
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

const mockSaveDiscordInstallation: Mock<
  (guildId: string, opts?: { orgId?: string; guildName?: string }) => Promise<void>
> = mock(() => Promise.resolve());

// admin-integrations.ts still imports the by-org helpers (discord_installations
// is not dropped by this slice). Mock every export so unrelated routes load.
mock.module("@atlas/api/lib/discord/store", () => ({
  saveDiscordInstallation: mockSaveDiscordInstallation,
  getDiscordInstallation: mock(() => Promise.resolve(null)),
  getDiscordInstallationByOrg: mock(() => Promise.resolve(null)),
  deleteDiscordInstallation: mock(() => Promise.resolve()),
  deleteDiscordInstallationByOrg: mock(() => Promise.resolve(false)),
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

describe("/api/v1/discord (retired legacy OAuth routes — #3145)", () => {
  beforeEach(() => {
    mockSaveDiscordInstallation.mockClear();
  });

  it("GET /install returns 410 Gone and never starts an OAuth dance", async () => {
    const app = await getApp();
    const resp = await app.request("/api/v1/discord/install", {
      method: "GET",
      redirect: "manual",
    });
    expect(resp.status).toBe(410);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.error).toBe("endpoint_retired");
    expect(body.requestId).toBeDefined();
    expect(String(body.message)).toMatch(/integrations\/discord/);
    expect(mockSaveDiscordInstallation).not.toHaveBeenCalled();
  });

  it("GET /callback returns 410 Gone and never writes an (uncapped) install", async () => {
    const app = await getApp();
    const resp = await app.request(
      "/api/v1/discord/callback?code=test_code&state=legacy&guild_id=123456789",
      { method: "GET" },
    );
    expect(resp.status).toBe(410);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.error).toBe("endpoint_retired");
    expect(mockSaveDiscordInstallation).not.toHaveBeenCalled();
  });
});
