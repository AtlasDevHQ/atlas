/**
 * Route-level tests for the Slack `/install` pre-redirect chat-integration cap
 * gate (#2998).
 *
 *   GET /api/v1/integrations/slack/install
 *
 * `SlackOAuthInstallHandler.startInstall` runs a read-only chat-integration cap
 * precheck (`checkChatIntegrationLimit`) BEFORE minting the Slack authorize URL,
 * so an at-cap workspace is refused before completing the full OAuth dance
 * (Slack minting a bot token + installing the app). This file proves the *route*
 * translates the handler's thrown tagged errors:
 *
 *   - ChatIntegrationLimitError → 429 `plan_limit_exceeded` (JSON) /
 *     302 `?error=slack&reason=plan_limit_reached` (browser)
 *   - BillingCheckFailedError   → 503 `billing_check_failed`
 *   - allowed                   → 302 to slack.com/oauth/v2/authorize
 *
 * Mirrors `integrations-discord.test.ts`'s harness. The cap-decision logic and
 * the handler's throw contract are unit-tested in
 * `billing/__tests__/enforcement.test.ts` and
 * `integrations/install/__tests__/slack-oauth-handler.test.ts`; this file's
 * responsibility is the *route* wiring.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
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
let organizationRowResponse: DbRow[] = [];
/** Rows the chat-integration COUNT(*) FILTER aggregate returns. */
let countRowResponse: DbRow[] = [];

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => QueryResult> = mock(
  (sql: string) => {
    if (sql.includes("FROM plugin_catalog")) {
      return Promise.resolve(catalogRowResponse);
    }
    if (sql.includes("FROM organization")) {
      return Promise.resolve(organizationRowResponse);
    }
    if (sql.includes("COUNT(*) FILTER")) {
      return Promise.resolve(countRowResponse);
    }
    return Promise.resolve([]);
  },
);

// Spread the real module so the dozens of other consumers in the import graph
// stay intact; override the read path this route + the cap precheck use.
// `getWorkspaceDetails` (used by the cap precheck via `getCachedWorkspace`)
// resolves through `internalQuery` internally, so the override covers it.
const realInternal = await import("@atlas/api/lib/db/internal");
mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
}));

// Auth — implicit-admin "mode: none" with a user carrying activeOrganizationId
// (the integrations router needs the org binding for the install record).
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

// The cap is read-only — startInstall never reaches Slack — but guard against
// an accidental real network call leaking out of the handler.
const mockFetch: Mock<(...args: Parameters<typeof fetch>) => Promise<Response>> = mock(
  () => Promise.resolve(new Response("{}", { status: 200 })),
);
globalThis.fetch = mockFetch as unknown as typeof fetch;

// The real enforcement module runs (NOT mocked) so the route → handler →
// checkChatIntegrationLimit → checkResourceLimit chain is exercised end to end.
// Import its cache invalidator so per-test workspace state can't bleed.
const { invalidatePlanCache } = await import("@atlas/api/lib/billing/enforcement");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SLACK_CATALOG_ROW: DbRow = {
  slug: "slack",
  install_model: "oauth",
  enabled: true,
  min_plan: "starter",
};

// Both `getWorkspaceEntitlement` (plan_tier + is_operator_workspace) and the
// cap precheck's `getWorkspaceDetails` (full workspace row) read `FROM
// organization`; one fixture satisfies both. Starter caps chat integrations at 1.
const STARTER_ORG: DbRow = {
  id: "org-test",
  name: "Test",
  slug: "test",
  workspace_status: "active",
  plan_tier: "starter",
  is_operator_workspace: false,
  byot: false,
  trial_ends_at: null,
  createdAt: "2026-01-01T00:00:00Z",
};

async function getApp() {
  const { app } = await import("../../api/index");
  return app;
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

describe("/api/v1/integrations/slack/install — chat-integration cap (#2998)", () => {
  const savedClientId = process.env.SLACK_CLIENT_ID;
  const savedClientSecret = process.env.SLACK_CLIENT_SECRET;
  const savedPublicApiUrl = process.env.ATLAS_PUBLIC_API_URL;
  const savedEncryptionKey = process.env.ATLAS_ENCRYPTION_KEY;

  // The Slack OAuth handler registers at module load only when SLACK_CLIENT_ID /
  // SLACK_CLIENT_SECRET / ATLAS_PUBLIC_API_URL are set (see register.ts). Since
  // the first getApp() import is what runs registerBuiltinInstallHandlers, the
  // env must be set BEFORE it — otherwise the route binds in 501 mode for the
  // whole file. Warm the build here with the env set (mirrors the discord suite,
  // #3089) so the one-time import cost doesn't race the per-test timeout.
  beforeAll(async () => {
    process.env.SLACK_CLIENT_ID = "test-slack-client-id";
    process.env.SLACK_CLIENT_SECRET = "test-slack-client-secret";
    process.env.ATLAS_PUBLIC_API_URL = "https://atlas.test";
    if (!process.env.ATLAS_ENCRYPTION_KEY) {
      process.env.ATLAS_ENCRYPTION_KEY = "test-encryption-key-32-bytes-long-aa";
    }
    await getApp();
  }, 30_000);

  beforeEach(() => {
    process.env.SLACK_CLIENT_ID = "test-slack-client-id";
    process.env.SLACK_CLIENT_SECRET = "test-slack-client-secret";
    process.env.ATLAS_PUBLIC_API_URL = "https://atlas.test";
    if (!process.env.ATLAS_ENCRYPTION_KEY) {
      process.env.ATLAS_ENCRYPTION_KEY = "test-encryption-key-32-bytes-long-aa";
    }
    catalogRowResponse = [SLACK_CATALOG_ROW];
    organizationRowResponse = [STARTER_ORG];
    countRowResponse = [{ others: 0, this_count: 0 }];
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
    invalidatePlanCache();
  });

  afterEach(() => {
    if (savedClientId !== undefined) process.env.SLACK_CLIENT_ID = savedClientId;
    else delete process.env.SLACK_CLIENT_ID;
    if (savedClientSecret !== undefined) process.env.SLACK_CLIENT_SECRET = savedClientSecret;
    else delete process.env.SLACK_CLIENT_SECRET;
    if (savedPublicApiUrl !== undefined) process.env.ATLAS_PUBLIC_API_URL = savedPublicApiUrl;
    else delete process.env.ATLAS_PUBLIC_API_URL;
    if (savedEncryptionKey !== undefined) process.env.ATLAS_ENCRYPTION_KEY = savedEncryptionKey;
    else delete process.env.ATLAS_ENCRYPTION_KEY;
  });

  it("redirects to Slack's OAuth authorize URL when under the cap", async () => {
    countRowResponse = [{ others: 0, this_count: 0 }]; // no existing chat installs
    const app = await getApp();
    const resp = await app.request("/api/v1/integrations/slack/install", {
      method: "GET",
      redirect: "manual",
    });
    expect(resp.status).toBe(302);
    const location = resp.headers.get("location") ?? "";
    expect(location).toContain("slack.com/oauth/v2/authorize");
    expect(location).toContain("client_id=test-slack-client-id");
    // The handler never reached out to Slack — startInstall only builds a URL.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 429 plan_limit_exceeded (with limit) for JSON callers at the cap — before any Slack redirect", async () => {
    // One other chat platform already installed; starter cap = 1.
    countRowResponse = [{ others: 1, this_count: 0 }];
    const app = await getApp();
    const resp = await app.request("/api/v1/integrations/slack/install", {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    expect(resp.status).toBe(429);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.error).toBe("plan_limit_exceeded");
    expect(body.limit).toBe(1);
    // Never redirected to Slack.
    expect(resp.headers.get("location")).toBeNull();
  });

  it("redirects browser callers at the cap to /admin/integrations?reason=plan_limit_reached", async () => {
    countRowResponse = [{ others: 1, this_count: 0 }];
    const app = await getApp();
    const resp = await app.request("/api/v1/integrations/slack/install", {
      method: "GET",
      headers: { accept: "text/html,application/xhtml+xml" },
      redirect: "manual",
    });
    expect(resp.status).toBe(302);
    const location = resp.headers.get("location") ?? "";
    expect(location).toContain("/admin/integrations");
    expect(location).toContain("error=slack");
    expect(location).toContain("reason=plan_limit_reached");
    // Redirected to the admin UI, NOT to Slack.
    expect(location).not.toContain("slack.com");
  });

  it("allows reconnect (this_count > 0) even over the cap — redirects to Slack", async () => {
    // Slack already installed and the workspace is over its starter cap on other
    // platforms; re-auth must still be allowed (never increases the count).
    countRowResponse = [{ others: 5, this_count: 1 }];
    const app = await getApp();
    const resp = await app.request("/api/v1/integrations/slack/install", {
      method: "GET",
      redirect: "manual",
    });
    expect(resp.status).toBe(302);
    expect(resp.headers.get("location") ?? "").toContain("slack.com/oauth/v2/authorize");
  });

  it("returns 503 billing_check_failed when the cap count can't be read (fail closed)", async () => {
    // Empty aggregate result → the count can't be determined → fail closed as a
    // transient 503 "try again", NOT a 429 "upgrade".
    countRowResponse = [];
    const app = await getApp();
    const resp = await app.request("/api/v1/integrations/slack/install", {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.error).toBe("billing_check_failed");
    expect(resp.headers.get("location")).toBeNull();
  });
});
