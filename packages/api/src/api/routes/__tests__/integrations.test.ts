/**
 * Tests for the platform-install routes (#2654, slice 6).
 *
 * Focus: the OAuth callback's response shape. Slice 5 already covered the
 * happy-path 302 + the credential-partial 302; slice 6 promotes hard
 * failures (`null` state, upstream `oauth.v2.access` non-OK) from JSON
 * 400/502 to 302 redirects when the caller is a browser (`Accept:
 * text/html`). JSON-Accept callers still get the original 400/502 so
 * curl-based debugging stays machine-readable.
 *
 * The test app mounts the integrations router at /api/v1/integrations
 * and stubs out the install handler's dispatch via a fake handler so the
 * tests don't depend on the real Slack `oauth.v2.access` round-trip or
 * the workspace_plugins INSERT.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Context, Effect, Layer } from "effect";
import { PlatformOAuthExchangeError } from "@atlas/api/lib/effect/errors";
import {
  MockInternalDB,
  makeMockInternalDBShimLayer,
} from "@atlas/api/testing/api-test-mocks";
import {
  _resetInstallHandlerRegistries,
  registerOAuthHandler,
  type OAuthPlatformInstallHandler,
} from "@atlas/api/lib/integrations/install";

// ---------------------------------------------------------------------------
// Auth — admin user with an org binding for the install route. The
// callback handler doesn't gate on auth (the state token is the gate),
// so the admin shape is only load-bearing for the install endpoint;
// callback tests pass anonymous requests through fine.
// ---------------------------------------------------------------------------

// Auth shape per test — overridden in DELETE tests that exercise
// non-admin / unauthenticated branches.
let mockAuthResult: unknown = {
  authenticated: true,
  mode: "managed",
  user: {
    id: "admin-1",
    role: "admin",
    activeOrganizationId: "ws-1",
  },
};

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mock(() => Promise.resolve(mockAuthResult)),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: () => undefined,
    redactPaths: [],
  };
});

mock.module("@atlas/ee/auth/ip-allowlist", () => ({
  checkIPAllowlist: () => Effect.succeed({ allowed: true }),
}));

// Config — only `deployMode` matters for these tests (the SaaS-misconfig
// 400 branch reads it). Default to self-hosted; individual tests flip
// to "saas" via `mockDeployMode`.
let mockDeployMode: "saas" | "self-hosted" | undefined = "self-hosted";

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({ deployMode: mockDeployMode }),
}));

// ---------------------------------------------------------------------------
// Internal DB — the catalog row lookup hits `internalQuery`. Default
// response is the Slack OAuth row; individual tests override via
// `mockInternalQuery.mockImplementationOnce` for the "platform not
// found" path.
//
// The DELETE handler makes additional `internalQuery` calls — a
// workspace_plugins SELECT to resolve teamId, then a workspace_plugins
// DELETE. Per-test setup overrides the default impl to keep those
// paths separable; `callOrder` records each call's "kind" (catalog
// SELECT / install SELECT / install DELETE) so the ADR-0003
// teardown-order assertion is robust.
// ---------------------------------------------------------------------------

const mockInternalQuery = mock(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => [
  { slug: "slack", install_model: "oauth", enabled: true },
]);

mock.module("@atlas/api/lib/db/internal", () => ({
  InternalDB: MockInternalDB,
  hasInternalDB: () => true,
  internalQuery: mockInternalQuery,
  internalExecute: mock(() => Promise.resolve()),
  makeInternalDBShimLayer: () => makeMockInternalDBShimLayer(mockInternalQuery, { available: true }),
  makeInternalDBLive: () => Layer.succeedContext(Context.empty()),
  createInternalDBTestLayer: () => makeMockInternalDBShimLayer(mockInternalQuery, { available: true }),
  getInternalDB: () => ({
    query: mockInternalQuery,
    connect: () => ({ query: mockInternalQuery, release: () => {} }),
    end: async () => {},
    on: () => {},
  }),
  closeInternalDB: async () => {},
  queryEffect: (sql: string, params?: unknown[]) =>
    Effect.tryPromise({
      try: () => mockInternalQuery(sql, params),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }),
  migrateInternalDB: async () => {},
  loadSavedConnections: async () => 0,
  findPatternBySQL: async () => null,
  insertLearnedPattern: () => {},
  insertSemanticAmendment: async () => {},
  getPendingAmendmentCount: async () => 0,
  getAutoApproveThreshold: () => 0.95,
  getAutoApproveTypes: () => new Set<string>(),
  getEncryptionKey: () => null,
  encryptSecret: (v: string) => v,
  decryptSecret: (v: string) => v,
  isPlaintextUrl: () => true,
  _resetEncryptionKeyCache: () => {},
  _resetPool: () => {},
  _resetCircuitBreaker: () => {},
}));

// ---------------------------------------------------------------------------
// Slack store — DELETE handler calls `deleteInstallation(teamId)` to
// drop the chat_cache row before deleting the workspace_plugins row.
// `callOrder` is a shared spool so the ADR-0003 ordering assertion has
// a single source of truth across both stores.
// ---------------------------------------------------------------------------

const callOrder: string[] = [];

const mockDeleteInstallation = mock(async (_teamId: string): Promise<void> => {
  callOrder.push("chat_cache.delete");
});

mock.module("@atlas/api/lib/slack/store", () => ({
  deleteInstallation: mockDeleteInstallation,
  // Other named exports are unused by the DELETE handler but must be
  // present — `mock.module()` requires every named export to be mocked
  // (CLAUDE.md "Mock all exports").
  getInstallation: mock(() => Promise.resolve(null)),
  getInstallationByOrg: mock(() => Promise.resolve(null)),
  saveInstallation: mock(() => Promise.resolve()),
  preserveOrgIdOnInstall: mock(() => Promise.resolve()),
  deleteInstallationByOrg: mock(() => Promise.resolve(false)),
  getBotToken: mock(() => Promise.resolve(null)),
  ENV_TEAM_ID: "env",
  KEY_PREFIX: "slack:installation:",
  FIELD: {
    botToken: "botToken",
    teamName: "teamName",
    orgId: "orgId",
    workspaceName: "workspaceName",
    installedAt: "installedAt",
    botUserId: "botUserId",
  },
}));

// ---------------------------------------------------------------------------
// Web origin — fixes the absolute redirect target so tests can assert
// the full URL without depending on the host's env.
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };
process.env.ATLAS_CORS_ORIGIN = "https://app.atlas.example";

// ---------------------------------------------------------------------------
// Fake OAuth handler — swapped in per test via the install registry's
// idempotent registerOAuthHandler. Drives the callback's three branches:
//
//   - happy:    returns { credentialResult: { written: true } }
//   - reconnect: returns { credentialResult: { written: false } }
//   - invalid:  returns null
//   - upstream: throws PlatformOAuthExchangeError
//
// Slice 5 already covers the handler's internal contract; here we only
// need the route's view of the four outcomes.
// ---------------------------------------------------------------------------

type CallbackResult = Awaited<ReturnType<OAuthPlatformInstallHandler["handleCallback"]>>;

let callbackImpl: () => Promise<CallbackResult> = async () => null;

const fakeHandler: OAuthPlatformInstallHandler = {
  kind: "oauth" as const,
  startInstall: async () => ({
    redirectUrl: "https://slack.com/oauth/v2/authorize?client_id=test&state=stub",
    stateToken: "stub",
  }),
  handleCallback: async () => callbackImpl(),
};

// ---------------------------------------------------------------------------
// Late imports (after mocks)
// ---------------------------------------------------------------------------

const { integrations } = await import("../integrations");
const { Hono } = await import("hono");

const app = new Hono();
app.route("/api/v1/integrations", integrations);

function request(path: string, init?: RequestInit) {
  return app.request(`http://localhost${path}`, init);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  registerOAuthHandler("slack", fakeHandler);
});

afterAll(() => {
  _resetInstallHandlerRegistries();
  process.env = { ...ORIGINAL_ENV };
});

beforeEach(() => {
  callbackImpl = async () => null;
  mockInternalQuery.mockImplementation(async () => [
    { slug: "slack", install_model: "oauth", enabled: true },
  ]);
  callOrder.length = 0;
  mockDeleteInstallation.mockClear();
  mockDeleteInstallation.mockImplementation(async (_teamId: string) => {
    callOrder.push("chat_cache.delete");
  });
  mockAuthResult = {
    authenticated: true,
    mode: "managed",
    user: {
      id: "admin-1",
      role: "admin",
      activeOrganizationId: "ws-1",
    },
  };
  mockDeployMode = "self-hosted";
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function happyResult(): CallbackResult {
  return {
    workspaceId: "ws-1" as never,
    catalogId: "slack",
    installRecord: {
      id: "install-1",
      workspaceId: "ws-1" as never,
      catalogId: "slack",
    },
    credentialResult: { written: true },
  };
}

function partialResult(): CallbackResult {
  return {
    workspaceId: "ws-1" as never,
    catalogId: "slack",
    installRecord: {
      id: "install-1",
      workspaceId: "ws-1" as never,
      catalogId: "slack",
    },
    credentialResult: { written: false, reason: "Credential persist failed — admin should retry via Reconnect" },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/integrations/slack/callback — happy path", () => {
  it("redirects to /admin/integrations?installed=slack on success", async () => {
    callbackImpl = async () => happyResult();

    const res = await request(
      "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
      { headers: { Accept: "text/html" } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.atlas.example/admin/integrations?installed=slack",
    );
  });

  it("redirects with ?reconnect=slack when the credential write missed (ADR-0003 partial)", async () => {
    callbackImpl = async () => partialResult();

    const res = await request(
      "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
      { headers: { Accept: "text/html" } },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.atlas.example/admin/integrations?reconnect=slack",
    );
  });
});

describe("GET /api/v1/integrations/slack/callback — invalid state", () => {
  it("redirects to /admin/integrations?error=slack&reason=invalid_state for browser callers", async () => {
    callbackImpl = async () => null;

    const res = await request(
      "/api/v1/integrations/slack/callback?code=auth-abc&state=tampered",
      { headers: { Accept: "text/html" } },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("https://app.atlas.example/admin/integrations");
    expect(location).toContain("error=slack");
    expect(location).toContain("reason=invalid_state");
  });

  it("still returns 400 JSON for application/json callers (back-compat for curl)", async () => {
    callbackImpl = async () => null;

    const res = await request(
      "/api/v1/integrations/slack/callback?code=auth-abc&state=tampered",
      { headers: { Accept: "application/json" } },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_state");
  });
});

describe("GET /api/v1/integrations/slack/callback — upstream Slack failure", () => {
  it("redirects to /admin/integrations?error=slack&reason=upstream_error for browser callers", async () => {
    callbackImpl = async () => {
      throw new PlatformOAuthExchangeError({
        message: "Slack rejected the OAuth code.",
        platform: "slack",
        upstreamError: "invalid_code",
      });
    };

    const res = await request(
      "/api/v1/integrations/slack/callback?code=bad-code&state=stub",
      { headers: { Accept: "text/html" } },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("error=slack");
    expect(location).toContain("reason=upstream_error");
  });

  it("still returns 502 JSON for application/json callers", async () => {
    callbackImpl = async () => {
      throw new PlatformOAuthExchangeError({
        message: "Slack rejected the OAuth code.",
        platform: "slack",
        upstreamError: "invalid_code",
      });
    };

    const res = await request(
      "/api/v1/integrations/slack/callback?code=bad-code&state=stub",
      { headers: { Accept: "application/json" } },
    );

    expect(res.status).toBe(502);
  });
});

describe("GET /api/v1/integrations/slack/callback — non-OAuth-exchange failure", () => {
  // Slice 5's SlackOAuthInstallHandler re-throws raw errors when the
  // workspace_plugins INSERT fails — those must NOT be downgraded to a
  // "click Reconnect" toast. The browser caller still sees a 500 with a
  // request id so the admin reports an actual bug instead of cycling
  // through an unhelpful retry loop.
  it("rethrows non-PlatformOAuthExchangeError for browser callers — runHandler maps to 500", async () => {
    callbackImpl = async () => {
      throw new Error("workspace_plugins INSERT failed: connection refused");
    };

    const res = await request(
      "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
      { headers: { Accept: "text/html" } },
    );

    // Definitely not a redirect masking the fault.
    expect(res.status).not.toBe(302);
    // runHandler's default mapper surfaces unknown errors as 500.
    expect(res.status).toBe(500);
  });

  it("rethrows non-PlatformOAuthExchangeError for JSON callers too", async () => {
    callbackImpl = async () => {
      throw new Error("workspace_plugins INSERT failed: connection refused");
    };

    const res = await request(
      "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
      { headers: { Accept: "application/json" } },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { requestId?: string };
    // 500 responses always include a requestId for log correlation
    // (runHandler bridge invariant).
    expect(body.requestId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/integrations/:platform — disconnect flow.
//
// Two-store teardown per ADR-0003: `chat_cache:<platform>:installation:<teamId>`
// is dropped BEFORE the `workspace_plugins` row, so credentials never
// outlive the install record. The ordering is load-bearing — if the
// install row went first and the chat_cache delete then failed, the
// gate would return false on the next event but the bot token would
// still be sitting in the credential store with no admin-visible way
// to reach it.
//
// Helpers below stage the workspace_plugins SELECT (config → teamId)
// and route the DELETE through `mockInternalQuery`'s SQL discrimination
// so the test can spool a single `callOrder` array across both stores.
// ---------------------------------------------------------------------------

function stageSlackInstallLookup(teamId: string | null) {
  mockInternalQuery.mockImplementation(async (sql: string, _params?: unknown[]): Promise<unknown[]> => {
    // Order matters: the DELETE statement also contains the substring
    // "FROM workspace_plugins", so DELETE must be matched before SELECT
    // or every DELETE would be mis-classified as a SELECT.
    if (sql.includes("DELETE FROM workspace_plugins")) {
      callOrder.push("workspace_plugins.delete");
      return [];
    }
    if (sql.includes("FROM plugin_catalog")) {
      return [{ slug: "slack", install_model: "oauth", enabled: true }];
    }
    if (sql.includes("FROM workspace_plugins")) {
      callOrder.push("workspace_plugins.select");
      return teamId === null ? [] : [{ team_id: teamId }];
    }
    return [];
  });
}

describe("DELETE /api/v1/integrations/slack — dual-store teardown", () => {
  it("deletes chat_cache BEFORE workspace_plugins (ADR-0003 ordering)", async () => {
    stageSlackInstallLookup("T-abc-123");

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(200);
    // Two-store teardown: chat_cache MUST happen before workspace_plugins.
    // The SELECTs can interleave with the catalog lookup, so filter the
    // spool down to just the teardown writes and assert the exact
    // sequence. A future refactor that swapped the two would fail this
    // even if both calls still succeeded — that's the ADR-0003
    // load-bearing invariant the comment in `integrations.ts` claims.
    const teardownSequence = callOrder.filter(
      (c) => c === "chat_cache.delete" || c === "workspace_plugins.delete",
    );
    expect(teardownSequence).toEqual([
      "chat_cache.delete",
      "workspace_plugins.delete",
    ]);
    expect(mockDeleteInstallation).toHaveBeenCalledWith("T-abc-123");
  });

  it("aborts (no workspace_plugins delete) when chat_cache delete fails — credentials must not outlive install record", async () => {
    stageSlackInstallLookup("T-abc-123");
    mockDeleteInstallation.mockImplementation(async () => {
      callOrder.push("chat_cache.delete");
      throw new Error("chat_cache table unavailable");
    });

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(500);
    expect(callOrder).toContain("chat_cache.delete");
    expect(callOrder).not.toContain("workspace_plugins.delete");
    const body = (await res.json()) as { requestId?: string };
    expect(body.requestId).toBeDefined();
  });

  it("returns 404 when no install row exists for the workspace", async () => {
    stageSlackInstallLookup(null);

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(404);
    // Neither store should be touched when there's nothing to tear down.
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("returns 404 when the platform slug is not in the catalog", async () => {
    mockInternalQuery.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes("FROM plugin_catalog")) return [];
      return [];
    });

    const res = await request("/api/v1/integrations/unknown", { method: "DELETE" });

    expect(res.status).toBe(404);
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
  });

  it("returns 401 when the request is unauthenticated", async () => {
    stageSlackInstallLookup("T-abc-123");
    mockAuthResult = {
      authenticated: false,
      status: 401,
      error: "Authentication required",
    };

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(401);
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("returns 403 when the caller is authenticated but not an admin", async () => {
    stageSlackInstallLookup("T-abc-123");
    mockAuthResult = {
      authenticated: true,
      mode: "managed",
      user: { id: "user-1", role: "member", activeOrganizationId: "ws-1" },
    };

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(403);
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("returns 501 for a catalog-enabled platform whose disconnect path isn't wired", async () => {
    // Future-Platform safety net: catalog returns an enabled `teams` row
    // (a real Platform), but `deleteCredentialStore` only dispatches
    // `slack` today. The 501 must short-circuit before either store
    // is touched — silently 404-ing or falling into the slack branch
    // would both be bugs.
    mockInternalQuery.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes("FROM plugin_catalog")) {
        return [{ slug: "teams", install_model: "oauth", enabled: true }];
      }
      return [];
    });

    const res = await request("/api/v1/integrations/teams", { method: "DELETE" });

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("disconnect_unavailable");
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("returns 400 missing_org_binding when managed-auth user has no active org", async () => {
    stageSlackInstallLookup("T-abc-123");
    mockAuthResult = {
      authenticated: true,
      mode: "managed",
      user: { id: "admin-1", role: "admin" }, // no activeOrganizationId
    };

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_org_binding");
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
  });

  it("returns 400 missing_org_binding when SaaS deploy lands a mode=none request (misconfig)", async () => {
    // SaaS pins managed auth in config, so a mode=none branch reaching
    // this endpoint means auth middleware regressed. Fail closed —
    // letting an unbound disconnect through would tear down a shared
    // sentinel-workspace install. Mirrors the F-04 install-hijack
    // defense on the install side.
    stageSlackInstallLookup("T-abc-123");
    mockDeployMode = "saas";
    mockAuthResult = {
      authenticated: true,
      mode: "none",
      user: undefined,
    };

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_org_binding");
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
  });

  it("self-hosted mode=none falls back to the 'self-hosted' sentinel workspaceId for the install lookup", async () => {
    // Single-tenant self-hosted dev: no real auth identity, but the
    // install was written under the same sentinel by the install
    // handler, so the SELECT must use it. If a future refactor flipped
    // to e.g. an empty string here, the disconnect would silently 404.
    const capturedParams: unknown[][] = [];
    mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]): Promise<unknown[]> => {
      if (params) capturedParams.push(params);
      if (sql.includes("DELETE FROM workspace_plugins")) {
        callOrder.push("workspace_plugins.delete");
        return [];
      }
      if (sql.includes("FROM plugin_catalog")) {
        return [{ slug: "slack", install_model: "oauth", enabled: true }];
      }
      if (sql.includes("FROM workspace_plugins")) {
        callOrder.push("workspace_plugins.select");
        return [{ team_id: "T-self-hosted" }];
      }
      return [];
    });
    mockAuthResult = { authenticated: true, mode: "none", user: undefined };

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(200);
    // Find the SELECT that resolved the install row and verify it was
    // keyed on the sentinel workspaceId.
    const selectParams = capturedParams.find(
      (p) => Array.isArray(p) && p[0] === "self-hosted" && p[1] === "catalog:slack",
    );
    expect(selectParams).toBeDefined();
  });
});
