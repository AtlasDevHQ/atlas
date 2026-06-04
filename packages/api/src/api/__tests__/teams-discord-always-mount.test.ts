/**
 * Locks the always-mount contract for /api/v1/teams and /api/v1/discord.
 *
 * The PR-#2831 fix removed import-time `if (process.env.TEAMS_APP_ID)` and
 * `if (process.env.DISCORD_CLIENT_ID)` gates around `app.route(...)` because
 * ESM modules are cached per realm — under a shared-worker `bun test
 * --parallel` cutover (#2802), whichever env value won the import race froze
 * the routing decision for the worker's lifetime.
 *
 * The other test files (`teams.test.ts`, `discord.test.ts`) set the env in
 * `beforeEach` BEFORE the first `getApp()` call, then `delete` it inside the
 * 501 test. That proves the request-time check works but doesn't catch a
 * regression that re-adds the import-time gate (the routes would still be
 * mounted because env was set at the moment of import; the request-time
 * delete would still yield 501).
 *
 * This file flips the order: delete the env vars BEFORE the dynamic import
 * runs. A revert to the import-time gate would skip `app.route(...)` and the
 * request would 404 — failing here loudly. Subprocess-per-file isolation
 * gives this file a fresh module realm.
 */

import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";

// --- Mocks (must be at module top before app import) ---

// `@atlas/api/lib/teams/store` was deleted in #3161 and is no longer in the
// app's import graph (the legacy `routes/teams.ts` install route doesn't touch
// it), so it no longer needs mocking here.

mock.module("@atlas/api/lib/discord/store", () => ({
  saveDiscordInstallation: mock(() => Promise.resolve()),
  getDiscordInstallation: mock(() => Promise.resolve(null)),
  getDiscordInstallationByOrg: mock(() => Promise.resolve(null)),
  deleteDiscordInstallation: mock(() => Promise.resolve()),
  deleteDiscordInstallationByOrg: mock(() => Promise.resolve(false)),
}));

mock.module("@atlas/api/lib/auth/middleware", () => ({
  checkRateLimit: mock(() => ({ allowed: true })),
  authenticateRequest: mock(() =>
    Promise.resolve({ authenticated: true, mode: "none", user: null }),
  ),
  getClientIP: mock(() => "127.0.0.1"),
  rateLimitCleanupTick: mock(() => {}),
}));

describe("/api/v1/{teams,discord} always-mount contract", () => {
  const savedTeamsAppId = process.env.TEAMS_APP_ID;
  const savedDiscordClientId = process.env.DISCORD_CLIENT_ID;
  const savedDiscordClientSecret = process.env.DISCORD_CLIENT_SECRET;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };

  beforeAll(async () => {
    // Unset BEFORE the dynamic import — the assertion is that the routes
    // mount even when the platform env is missing at module-evaluation time.
    delete process.env.TEAMS_APP_ID;
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;

    const mod = (await import("../../api/index")) as {
      app: { request: (path: string, init?: RequestInit) => Promise<Response> };
    };
    app = mod.app;
  });

  afterAll(() => {
    if (savedTeamsAppId !== undefined) process.env.TEAMS_APP_ID = savedTeamsAppId;
    if (savedDiscordClientId !== undefined)
      process.env.DISCORD_CLIENT_ID = savedDiscordClientId;
    if (savedDiscordClientSecret !== undefined)
      process.env.DISCORD_CLIENT_SECRET = savedDiscordClientSecret;
  });

  it("/api/v1/teams/install returns 501 (not 404) when TEAMS_APP_ID unset at import", async () => {
    const resp = await app.request("/api/v1/teams/install", { method: "GET" });
    expect(resp.status).toBe(501);
  });

  it("/api/v1/discord/install returns 410 (not 404) — legacy OAuth route retired in #3145", async () => {
    // The legacy uncapped Discord OAuth install was retired in #3145 (the
    // cap-gated path is /api/v1/integrations/discord/install). The route stays
    // mounted and returns 410 Gone regardless of env, so a stale Discord
    // redirect lands on an explicit "moved" signal, not a 404.
    const resp = await app.request("/api/v1/discord/install", { method: "GET" });
    expect(resp.status).toBe(410);
  });
});
