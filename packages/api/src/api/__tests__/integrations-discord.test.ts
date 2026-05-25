/**
 * Route-level tests for the new Discord static-bot install routes —
 * slice 11 of 1.5.3 Phase D (#2749).
 *
 *   GET /api/v1/integrations/discord/install
 *   GET /api/v1/integrations/discord/callback
 *
 * These routes are distinct from the legacy `/api/v1/discord/*` routes
 * (which write to a separate Postgres `discord_installations` table) —
 * the new routes write to `workspace_plugins` via
 * `DiscordStaticBotInstallHandler`, integrate with the install-handler
 * dispatch, and use the operator-shared OAuth bot-install pattern.
 *
 * Covers the high-value branches the slice introduces:
 *   - Admin auth + missing-org-binding (F-04)
 *   - Catalog lookup + install_model gate
 *   - Plan-tier deny (JSON vs prefersHtml redirect)
 *   - State-token verification at callback
 *   - Discord-side user cancel + missing guild_id
 *   - Happy path: callback → handler dispatch → 302 to /admin/integrations
 *
 * Handler-level error mapping (DiscordGuildIdInvalidError → 400 etc.)
 * is unit-tested in `discord-static-bot-handler.test.ts` and
 * `mapTaggedError`; this file's responsibility is the *route* wiring.
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

// ---------------------------------------------------------------------------
// Module mocks (must precede app import)
// ---------------------------------------------------------------------------

type DbRow = Record<string, unknown>;
type QueryResult = Promise<DbRow[]>;

let catalogRowResponse: DbRow[] = [];
let entitlementRowResponse: DbRow[] = [];

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => QueryResult> = mock(
  (sql: string) => {
    if (sql.includes("FROM plugin_catalog")) {
      return Promise.resolve(catalogRowResponse);
    }
    if (sql.includes("FROM organization")) {
      return Promise.resolve(entitlementRowResponse);
    }
    return Promise.resolve([]);
  },
);

// Partial mock — spread the real module's exports so admin auth,
// migration helpers, encryption helpers, and the dozens of other
// consumers in the import graph stay intact. Override `internalQuery`
// (the read path this route uses) and `hasInternalDB` (the
// `requireOrgContext()` middleware on `integrationsCatalog` short-
// circuits to 404 when DB is unconfigured — true in tests by default).
const realInternal = await import("@atlas/api/lib/db/internal");
mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
}));

// Auth — mutable for per-test admin/non-admin/unauthenticated scenarios.
// Default to an implicit-admin "mode: none" result with a user object
// carrying `activeOrganizationId`. The admin-auth preamble's role
// check skips when `mode === "none"` (no identity boundary), but
// `requireOrgContext` (applied by the integrations-catalog sub-router
// to every path under `/api/v1/integrations/*`) refuses without an
// orgId — so we still need the user object.
let authResultForTests: {
  authenticated: boolean;
  mode: string;
  status?: number;
  error?: string;
  user?: Record<string, unknown> | null;
} = {
  authenticated: true,
  mode: "none",
  user: {
    id: "user-admin",
    mode: "none",
    label: "Admin",
    role: "admin",
    activeOrganizationId: "org-test",
  },
};

const mockAuthenticateRequest: Mock<(req: Request) => Promise<unknown>> = mock(
  () => Promise.resolve(authResultForTests),
);

mock.module("@atlas/api/lib/auth/middleware", () => ({
  checkRateLimit: mock(() => ({ allowed: true })),
  authenticateRequest: mockAuthenticateRequest,
  getClientIP: mock(() => "127.0.0.1"),
  rateLimitCleanupTick: mock(() => {}),
}));

// Discord's API gets called once on the happy path (reachability
// round-trip via GET /guilds/{id}); every other test stops before
// the handler runs. Provide a default 200 payload so the mock counter
// also doubles as the "did we accidentally hit the real Discord API"
// signal.
const mockFetch: Mock<(...args: Parameters<typeof fetch>) => Promise<Response>> = mock(
  () =>
    Promise.resolve(
      new Response(JSON.stringify({ id: "123456789012345678", name: "Test Guild" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
);
globalThis.fetch = mockFetch as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DISCORD_CATALOG_ROW: DbRow = {
  slug: "discord",
  install_model: "static-bot",
  min_plan: "starter",
};

const STARTER_ENTITLEMENT: DbRow = {
  plan_tier: "starter",
  is_operator_workspace: false,
};

const FREE_ENTITLEMENT: DbRow = {
  plan_tier: "free",
  is_operator_workspace: false,
};

async function getApp() {
  const { app } = await import("../../api/index");
  return app;
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

describe("/api/v1/integrations/discord", () => {
  const savedBotToken = process.env.DISCORD_BOT_TOKEN;
  const savedClientId = process.env.DISCORD_CLIENT_ID;
  const savedPublicApiUrl = process.env.ATLAS_PUBLIC_API_URL;

  beforeEach(() => {
    process.env.DISCORD_BOT_TOKEN = "test-bot-token";
    process.env.DISCORD_CLIENT_ID = "test-client-id";
    process.env.DISCORD_PUBLIC_KEY = "test-public-key";
    process.env.ATLAS_PUBLIC_API_URL = "https://atlas.test";
    // Encryption key is required for state-token mint; reuse the
    // long-standing test value that other suites depend on.
    if (!process.env.ATLAS_ENCRYPTION_KEY) {
      process.env.ATLAS_ENCRYPTION_KEY = "test-encryption-key-32-bytes-long-aa";
    }
    catalogRowResponse = [DISCORD_CATALOG_ROW];
    entitlementRowResponse = [STARTER_ENTITLEMENT];
    authResultForTests = {
      authenticated: true,
      mode: "none",
      user: {
        id: "user-admin",
        mode: "none",
        label: "Admin",
        role: "admin",
        activeOrganizationId: "org-test",
      },
    };
    mockInternalQuery.mockClear();
    mockAuthenticateRequest.mockClear();
    mockFetch.mockClear();
  });

  afterEach(() => {
    if (savedBotToken !== undefined) process.env.DISCORD_BOT_TOKEN = savedBotToken;
    else delete process.env.DISCORD_BOT_TOKEN;
    if (savedClientId !== undefined) process.env.DISCORD_CLIENT_ID = savedClientId;
    else delete process.env.DISCORD_CLIENT_ID;
    if (savedPublicApiUrl !== undefined) process.env.ATLAS_PUBLIC_API_URL = savedPublicApiUrl;
    else delete process.env.ATLAS_PUBLIC_API_URL;
  });

  // -------------------------------------------------------------------------
  // GET /install
  // -------------------------------------------------------------------------

  describe("GET /install", () => {
    it("redirects to Discord's OAuth authorize URL on the happy path", async () => {
      const app = await getApp();
      const resp = await app.request("/api/v1/integrations/discord/install", {
        method: "GET",
        redirect: "manual",
      });
      expect(resp.status).toBe(302);
      const location = resp.headers.get("location") ?? "";
      expect(location).toContain("discord.com/oauth2/authorize");
      expect(location).toContain("client_id=test-client-id");
      // Permissions bitmask is the documented five-permission set
      // (View Channels + Send Messages + Embed Links + Read History +
      // Threads). Lock the wire value — drift here surprises admins on
      // the consent screen.
      expect(location).toContain("permissions=274877991936");
      // State token bound to (workspaceId, "catalog:discord") is
      // echoed back into the authorize URL. Don't pin the token's
      // shape — it's HMAC-signed and opaque to the route.
      expect(location).toMatch(/state=[A-Za-z0-9._-]+/);
    });

    it("returns 401 when caller is unauthenticated", async () => {
      authResultForTests = {
        authenticated: false,
        mode: "managed",
        status: 401,
        error: "Authentication required",
      };
      const app = await getApp();
      const resp = await app.request("/api/v1/integrations/discord/install", {
        method: "GET",
        redirect: "manual",
      });
      expect(resp.status).toBe(401);
    });

    it("returns 404 when Discord catalog row is missing or kill-switched", async () => {
      catalogRowResponse = [];
      const app = await getApp();
      const resp = await app.request("/api/v1/integrations/discord/install", {
        method: "GET",
      });
      expect(resp.status).toBe(404);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.error).toBe("not_found");
    });

    it("returns 400 wrong_install_model when catalog row's install_model is not 'static-bot'", async () => {
      catalogRowResponse = [{ ...DISCORD_CATALOG_ROW, install_model: "oauth" }];
      const app = await getApp();
      const resp = await app.request("/api/v1/integrations/discord/install", {
        method: "GET",
      });
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.error).toBe("wrong_install_model");
    });

    it("returns 403 plan_upgrade_required for JSON callers on a free plan", async () => {
      entitlementRowResponse = [FREE_ENTITLEMENT];
      const app = await getApp();
      const resp = await app.request("/api/v1/integrations/discord/install", {
        method: "GET",
        headers: { accept: "application/json" },
      });
      expect(resp.status).toBe(403);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.error).toBe("plan_upgrade_required");
      expect(body.required_plan).toBe("starter");
      expect(body.current_plan).toBe("free");
    });

    it("returns 302 to /admin/integrations for browser callers on a free plan", async () => {
      entitlementRowResponse = [FREE_ENTITLEMENT];
      const app = await getApp();
      const resp = await app.request("/api/v1/integrations/discord/install", {
        method: "GET",
        headers: { accept: "text/html,application/xhtml+xml" },
        redirect: "manual",
      });
      expect(resp.status).toBe(302);
      const location = resp.headers.get("location") ?? "";
      expect(location).toContain("/admin/integrations");
      expect(location).toContain("error=discord");
      expect(location).toContain("reason=plan_upgrade_required");
    });
  });

  // -------------------------------------------------------------------------
  // GET /callback
  // -------------------------------------------------------------------------

  describe("GET /callback", () => {
    async function mintValidState(): Promise<string> {
      const { mintOAuthStateToken } = await import(
        "@atlas/api/lib/integrations/install/oauth-state-token"
      );
      return mintOAuthStateToken("org-test", "catalog:discord");
    }

    it("returns 400 invalid_state when state token is forged / expired", async () => {
      const app = await getApp();
      const resp = await app.request(
        "/api/v1/integrations/discord/callback?state=not-a-valid-token&guild_id=123456789012345678",
        { method: "GET", headers: { accept: "application/json" } },
      );
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_state");
    });

    it("redirects to /admin/integrations with reason=invalid_state for browsers", async () => {
      const app = await getApp();
      const resp = await app.request(
        "/api/v1/integrations/discord/callback?state=not-a-valid-token&guild_id=123456789012345678",
        {
          method: "GET",
          headers: { accept: "text/html" },
          redirect: "manual",
        },
      );
      expect(resp.status).toBe(302);
      const location = resp.headers.get("location") ?? "";
      expect(location).toContain("error=discord");
      expect(location).toContain("reason=invalid_state");
    });

    it("returns 400 authorization_denied when Discord redirects with ?error= (user cancelled)", async () => {
      const state = await mintValidState();
      const app = await getApp();
      const resp = await app.request(
        `/api/v1/integrations/discord/callback?state=${encodeURIComponent(state)}&error=access_denied&error_description=User+cancelled`,
        { method: "GET", headers: { accept: "application/json" } },
      );
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.error).toBe("authorization_denied");
    });

    it("returns 400 missing_guild_id when Discord callback omits guild_id", async () => {
      const state = await mintValidState();
      const app = await getApp();
      const resp = await app.request(
        `/api/v1/integrations/discord/callback?state=${encodeURIComponent(state)}`,
        { method: "GET", headers: { accept: "application/json" } },
      );
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.error).toBe("missing_guild_id");
    });

    it("returns 404 when the catalog row is kill-switched between /install and /callback (codex P1)", async () => {
      // /install gates on `enabled = true`; if ops disables the row
      // mid-OAuth, /callback must refuse to write the install. The
      // catalog reload at callback time enforces this.
      catalogRowResponse = []; // no row matches `WHERE enabled = true`
      const state = await mintValidState();
      const app = await getApp();
      const resp = await app.request(
        `/api/v1/integrations/discord/callback?state=${encodeURIComponent(state)}&guild_id=123456789012345678`,
        { method: "GET", headers: { accept: "application/json" } },
      );
      expect(resp.status).toBe(404);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.error).toBe("not_found");
    });

    it("returns 403 plan_upgrade_required when the workspace plan was downgraded mid-OAuth (codex P1)", async () => {
      // Simulate a starter→free downgrade between /install (which
      // plan-checked successfully) and /callback. The defensive
      // re-check refuses to persist; admin UI surfaces the upgrade
      // prompt on redirect.
      entitlementRowResponse = [FREE_ENTITLEMENT];
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("FROM plugin_catalog")) {
          return Promise.resolve(catalogRowResponse);
        }
        if (sql.includes("FROM organization")) {
          return Promise.resolve(entitlementRowResponse);
        }
        return Promise.resolve([]);
      });
      const state = await mintValidState();
      const app = await getApp();
      const resp = await app.request(
        `/api/v1/integrations/discord/callback?state=${encodeURIComponent(state)}&guild_id=123456789012345678`,
        { method: "GET", headers: { accept: "application/json" } },
      );
      expect(resp.status).toBe(403);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.error).toBe("plan_upgrade_required");
    });

    it("dispatches into the Discord handler on the happy path and redirects to ?installed=discord", async () => {
      // The handler is registered at boot via
      // `registerBuiltinInstallHandlers` (env-gated on DISCORD_BOT_TOKEN +
      // DISCORD_CLIENT_ID, both set in beforeEach). The fetch mock above
      // returns a 200 guild payload, so reachability verification
      // succeeds and the UPSERT lands.
      mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("FROM plugin_catalog")) {
          return Promise.resolve(catalogRowResponse);
        }
        if (sql.includes("FROM organization")) {
          return Promise.resolve(entitlementRowResponse);
        }
        if (sql.includes("INSERT INTO workspace_plugins")) {
          return Promise.resolve([{ id: "install-row-1" }]);
        }
        return Promise.resolve([]);
      });

      const state = await mintValidState();
      const app = await getApp();
      const resp = await app.request(
        `/api/v1/integrations/discord/callback?state=${encodeURIComponent(state)}&guild_id=123456789012345678`,
        { method: "GET", redirect: "manual" },
      );
      expect(resp.status).toBe(302);
      const location = resp.headers.get("location") ?? "";
      expect(location).toContain("/admin/integrations");
      expect(location).toContain("installed=discord");
      // Discord's API was called exactly once for the reachability
      // round-trip — no double-call from a retry path.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
