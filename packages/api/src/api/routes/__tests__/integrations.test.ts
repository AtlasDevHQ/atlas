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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Context, Effect, Layer } from "effect";
import { PlatformOAuthExchangeError } from "@atlas/api/lib/effect/errors";
import {
  MockInternalDB,
  makeMockInternalDBShimLayer,
} from "@atlas/api/testing/api-test-mocks";
import {
  _resetInstallHandlerRegistries,
  registerFormHandler,
  registerOAuthHandler,
  type FormBasedInstallHandler,
  type OAuthPlatformInstallHandler,
} from "@atlas/api/lib/integrations/install";
import { FormInstallValidationError } from "@atlas/api/lib/integrations/install/email-form-handler";

// ---------------------------------------------------------------------------
// Auth — admin user with an org binding for the install route. The
// callback handler doesn't gate on auth (the state token is the gate),
// so the admin shape is only load-bearing for the install endpoint;
// callback tests pass anonymous requests through fine.
// ---------------------------------------------------------------------------

// Swappable auth result so individual tests can drive the route's
// auth-failure branches (F-04 SaaS mode=none, missing-org, 401, 403).
// Defaults to the admin happy path; per-suite `beforeEach` blocks
// override via `authResultImpl = …`.
type AuthResult = {
  authenticated: boolean;
  mode: "managed" | "none";
  user?: {
    id: string;
    role: string;
    activeOrganizationId?: string;
    // DELETE tests use `claims.twoFactorEnabled` to pass / fail the
    // `shouldRequireMfaForAuthResult` gate. Install/callback tests
    // can omit it — those branches don't reach the MFA check.
    claims?: Record<string, unknown>;
  };
  error?: string;
  status?: 401 | 403 | 500;
};
let authResultImpl: () => Promise<AuthResult> = async () => ({
  authenticated: true,
  mode: "managed",
  user: {
    id: "admin-1",
    role: "admin",
    activeOrganizationId: "ws-1",
    // Default test admin has MFA enrolled so the DELETE handler's
    // gate passes — the unenrolled branch gets its own test.
    claims: { twoFactorEnabled: true },
  },
});

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mock(() => authResultImpl()),
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

// Swappable deploy mode so F-04 SaaS-mode=none tests can simulate the
// SaaS posture without bleeding into the OAuth callback suites.
let deployModeImpl: () => string | undefined = () => undefined;

mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => ({ deployMode: deployModeImpl() }),
  defineConfig: (c: unknown) => c,
}));

// ---------------------------------------------------------------------------
// Internal DB — the catalog row lookup hits `internalQuery`. Default
// response is the Slack OAuth row; individual tests override via
// `mockInternalQuery.mockImplementationOnce` for the "platform not
// found" path.
// ---------------------------------------------------------------------------

// SQL-aware default: route the catalog query and the workspace
// entitlement query (#2701 / #2702) to distinct mock rows. Each
// test's `mockImplementation` override still receives both queries
// — to keep existing tests terse, the override only needs to supply
// the catalog row; the org row is patched in below if absent.
function defaultMockInternalQuery(sql: string): unknown[] {
  if (sql.includes("FROM organization")) {
    return [{ plan_tier: "business", is_operator_workspace: false }];
  }
  return [{ slug: "slack", install_model: "oauth", enabled: true, min_plan: "starter" }];
}

const mockInternalQuery = mock(
  async (sql: string, _params?: unknown[]): Promise<unknown[]> => defaultMockInternalQuery(sql),
);

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

const mockDeleteCredentialBundle = mock(async (_workspaceId: string, _catalogId: string): Promise<boolean> => {
  callOrder.push("integration_credentials.delete");
  return true;
});

mock.module("@atlas/api/lib/integrations/credentials/store", () => ({
  deleteCredentialBundle: mockDeleteCredentialBundle,
  // CLAUDE.md "Mock all exports" — the disconnect path only calls
  // `deleteCredentialBundle`; stub the read/write so other tests that
  // import this module don't see partial mocks.
  readCredentialBundle: mock(() => Promise.resolve(null)),
  saveCredentialBundle: mock(() => Promise.resolve()),
}));

mock.module("@atlas/api/lib/slack/store", () => ({
  deleteInstallation: mockDeleteInstallation,
  // mock.module() requires every named export to be mocked (CLAUDE.md
  // "Mock all exports"). The disconnect handler only calls
  // `deleteInstallation`; the rest are no-op stubs.
  getInstallation: mock(() => Promise.resolve(null)),
  getInstallationByOrg: mock(() => Promise.resolve(null)),
  saveInstallation: mock(() => Promise.resolve()),
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

// Misrouting — disconnect calls `detectMisrouting` + `isStrictRoutingEnabled`
// to refuse cross-region requests. Default to "not misrouted, strict off"
// so the happy path runs; the 421 test flips both.
let mockMisrouted:
  | {
      expectedRegion: string;
      actualRegion: string;
      correctApiUrl: string | undefined;
    }
  | null = null;
let mockStrictRouting = false;

mock.module("@atlas/api/lib/residency/misrouting", () => ({
  detectMisrouting: () => Promise.resolve(mockMisrouted),
  isStrictRoutingEnabled: () => mockStrictRouting,
}));

// `verifyOAuthStateToken` needs an encryption key to round-trip a real
// token, but the test env doesn't configure one. Stub the module so
// tests can drive the route's `verifiedState` branch (used by the
// /callback mid-OAuth plan re-check) without standing up the keyset.
// CLAUDE.md: mock ALL named exports — partial mocks break other
// test files. `mintOAuthStateToken` is mocked too even though no
// test below calls it directly.
let stubVerifiedState: { workspaceId: string; catalogId: string } | null = null;
mock.module("@atlas/api/lib/integrations/install/oauth-state-token", () => ({
  mintOAuthStateToken: () => "stub",
  verifyOAuthStateToken: () => stubVerifiedState,
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
type ValidateResult = Awaited<ReturnType<FormBasedInstallHandler["validateConfig"]>>;

let callbackImpl: () => Promise<CallbackResult> = async () => null;

const fakeHandler: OAuthPlatformInstallHandler = {
  kind: "oauth" as const,
  startInstall: async () => ({
    redirectUrl: "https://slack.com/oauth/v2/authorize?client_id=test&state=stub",
    stateToken: "stub",
  }),
  handleCallback: async () => callbackImpl(),
};

// Stubbed form handler — slug "email". The form-install tests below
// swap `validateImpl` per test so we can drive the validation /
// happy-path branches without depending on Postgres or real
// encryption. The real implementation is tested in
// `email-form-handler.test.ts`.
let validateImpl: (form: unknown) => Promise<ValidateResult> = async () => ({
  installRecord: { id: "install-email-1", workspaceId: "ws-1" as never, catalogId: "email" },
  credentialWritten: true,
});

const fakeFormHandler: FormBasedInstallHandler = {
  kind: "form" as const,
  validateConfig: async (_wsid, formData) => validateImpl(formData),
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
  registerFormHandler("email", fakeFormHandler);
});

afterAll(() => {
  _resetInstallHandlerRegistries();
  process.env = { ...ORIGINAL_ENV };
});

beforeEach(() => {
  callbackImpl = async () => null;
  mockInternalQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM organization")) {
      return [{ plan_tier: "business", is_operator_workspace: false }];
    }
    return [{ slug: "slack", install_model: "oauth", enabled: true, min_plan: "starter" }];
  });
  authResultImpl = async () => ({
    authenticated: true,
    mode: "managed",
    user: {
      id: "admin-1",
      role: "admin",
      activeOrganizationId: "ws-1",
      claims: { twoFactorEnabled: true },
    },
  });
  deployModeImpl = () => undefined;
  callOrder.length = 0;
  mockDeleteInstallation.mockClear();
  mockDeleteInstallation.mockImplementation(async (_teamId: string) => {
    callOrder.push("chat_cache.delete");
  });
  mockDeleteCredentialBundle.mockClear();
  mockDeleteCredentialBundle.mockImplementation(async () => {
    callOrder.push("integration_credentials.delete");
    return true;
  });
  mockMisrouted = null;
  mockStrictRouting = false;
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
// POST /:platform/install-form — slice 7 (#2660)
// ---------------------------------------------------------------------------

describe("POST /api/v1/integrations/:platform/install-form — happy path", () => {
  beforeEach(() => {
    // Catalog lookup returns the Email row for the form-install
    // branch; reset between tests since other suites pin "slack".
    mockInternalQuery.mockImplementation(async () => [
      { slug: "email", install_model: "form", enabled: true, min_plan: "free" },
    ]);
    validateImpl = async () => ({
      installRecord: {
        id: "install-email-happy",
        workspaceId: "ws-1" as never,
        catalogId: "email",
      },
      credentialWritten: true,
    });
  });

  it("dispatches to the form handler and returns the install id on success", async () => {
    const res = await request("/api/v1/integrations/email/install-form", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: "smtp.example.com",
        port: 587,
        username: "u",
        password: "p",
        fromAddress: "atlas@example.com",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { installed: boolean; installId: string; platform: string };
    expect(body).toEqual({
      installed: true,
      platform: "email",
      installId: "install-email-happy",
    });
  });
});

describe("POST /api/v1/integrations/:platform/install-form — validation failure", () => {
  beforeEach(() => {
    mockInternalQuery.mockImplementation(async () => [
      { slug: "email", install_model: "form", enabled: true, min_plan: "free" },
    ]);
    // Simulate the real EmailFormInstallHandler refusing the form
    // for a missing password — the route must translate this to a
    // 400 with field-level detail.
    validateImpl = async () => {
      throw new FormInstallValidationError({
        fieldErrors: { password: ["password is required"] },
      });
    };
  });

  it("returns 400 with fieldErrors when the handler rejects the form", async () => {
    const res = await request("/api/v1/integrations/email/install-form", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "smtp.example.com" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      message: string;
      fieldErrors: Record<string, string[]>;
      requestId: string;
    };
    expect(body.error).toBe("invalid_form_data");
    expect(body.fieldErrors.password).toEqual(["password is required"]);
    expect(body.requestId).toBeDefined();
  });
});

describe("POST /api/v1/integrations/:platform/install-form — wrong install_model", () => {
  beforeEach(() => {
    // Catalog lookup returns the Slack row (oauth) but the caller
    // hit the form-install endpoint for it — must reject with 400.
    mockInternalQuery.mockImplementation(async () => [
      { slug: "slack", install_model: "oauth", enabled: true, min_plan: "free" },
    ]);
  });

  it("refuses with 400 wrong_install_model when the catalog row is OAuth", async () => {
    const res = await request("/api/v1/integrations/slack/install-form", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("wrong_install_model");
  });
});

describe("POST /api/v1/integrations/:platform/install-form — unknown platform", () => {
  beforeEach(() => {
    mockInternalQuery.mockImplementation(async () => []);
  });

  it("returns 404 when the catalog row doesn't exist", async () => {
    const res = await request("/api/v1/integrations/nope/install-form", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// F-04 install-hijack — SaaS deploy + mode=none must refuse outright.
// The OAuth route's mirror guard is exercised by slice 5 tests; here we
// pin the same posture for the new /install-form route so a managed-auth
// regression can't slip past both.
// ---------------------------------------------------------------------------

describe("POST /install-form — F-04 SaaS-mode-none guard", () => {
  beforeEach(() => {
    mockInternalQuery.mockImplementation(async () => [
      { slug: "email", install_model: "form", enabled: true, min_plan: "free" },
    ]);
    authResultImpl = async () => ({
      authenticated: true,
      mode: "none",
      // Even with a user object present, mode=none under SaaS is a
      // misconfig — the route refuses without consulting it.
      user: { id: "anon", role: "admin", activeOrganizationId: undefined },
    });
  });

  it("refuses with 400 missing_org_binding under SaaS deploy + mode=none", async () => {
    deployModeImpl = () => "saas";
    const res = await request("/api/v1/integrations/email/install-form", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "smtp.example.com" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_org_binding");
  });
});

// ---------------------------------------------------------------------------
// Missing org binding (managed mode, no activeOrganizationId) — pins
// the second auth-side fail-closed branch.
// ---------------------------------------------------------------------------

describe("POST /install-form — managed mode missing activeOrganizationId", () => {
  beforeEach(() => {
    mockInternalQuery.mockImplementation(async () => [
      { slug: "email", install_model: "form", enabled: true, min_plan: "free" },
    ]);
    authResultImpl = async () => ({
      authenticated: true,
      mode: "managed",
      user: { id: "admin-1", role: "admin", activeOrganizationId: undefined },
    });
  });

  it("refuses with 400 missing_org_binding when the user has no active org", async () => {
    const res = await request("/api/v1/integrations/email/install-form", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "smtp.example.com" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_org_binding");
  });
});

// ---------------------------------------------------------------------------
// Dispatch failure modes — handler not registered (501) and kind
// mismatch (501). The kind mismatch is the "catalog says form but
// dispatch returns OAuth" canary — without it a registration typo
// would silently call .startInstall() on a form handler.
// ---------------------------------------------------------------------------

describe("POST /install-form — dispatch failures", () => {
  beforeEach(() => {
    mockInternalQuery.mockImplementation(async () => [
      { slug: "email", install_model: "form", enabled: true, min_plan: "free" },
    ]);
  });

  it("returns 501 handler_unavailable when no form handler is registered for the slug", async () => {
    _resetInstallHandlerRegistries();
    try {
      const res = await request("/api/v1/integrations/email/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("handler_unavailable");
    } finally {
      // Restore both handlers used by the rest of the suite.
      registerOAuthHandler("slack", fakeHandler);
      registerFormHandler("email", fakeFormHandler);
    }
  });

  it("returns 501 handler_unavailable when the registered handler's kind doesn't match the catalog row", async () => {
    // Force the kind mismatch: a real misconfig would land here if an
    // operator wired registerFormHandler against an OAuth handler.
    _resetInstallHandlerRegistries();
    registerFormHandler("email", fakeHandler as unknown as FormBasedInstallHandler);
    try {
      const res = await request("/api/v1/integrations/email/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("handler_unavailable");
    } finally {
      registerOAuthHandler("slack", fakeHandler);
      registerFormHandler("email", fakeFormHandler);
    }
  });
});

// ---------------------------------------------------------------------------
// Plan-tier gating (#2701 / #2702) — install + install-form + callback
// each return 403 plan_upgrade_required when the workspace's tier ranks
// below the catalog row's min_plan, and operator workspaces bypass the
// check entirely. Disconnect is intentionally NOT plan-checked so a
// downgraded customer can always clean up their existing install.
// ---------------------------------------------------------------------------

describe("plan-tier gating", () => {
  describe("GET /:platform/install — denies when plan is below min_plan", () => {
    beforeEach(() => {
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "free", is_operator_workspace: false }];
        }
        // Slack ships at min_plan='starter' in the real catalog.
        return [{ slug: "slack", install_model: "oauth", enabled: true, min_plan: "starter" }];
      });
    });

    it("redirects browser callers to /admin/integrations?error=slack&reason=plan_upgrade_required", async () => {
      const res = await request("/api/v1/integrations/slack/install", {
        headers: { Accept: "text/html" },
      });
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("error=slack");
      expect(location).toContain("reason=plan_upgrade_required");
      expect(location).toContain("required_plan=starter");
    });

    it("returns 403 plan_upgrade_required JSON for non-browser callers", async () => {
      const res = await request("/api/v1/integrations/slack/install", {
        headers: { Accept: "application/json" },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: string;
        required_plan: string;
        current_plan: string;
      };
      expect(body.error).toBe("plan_upgrade_required");
      expect(body.required_plan).toBe("starter");
      expect(body.current_plan).toBe("free");
    });
  });

  describe("POST /:platform/install-form — denies when plan is below min_plan", () => {
    beforeEach(() => {
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "trial", is_operator_workspace: false }];
        }
        return [{ slug: "email", install_model: "form", enabled: true, min_plan: "business" }];
      });
    });

    it("returns 403 plan_upgrade_required with required_plan + current_plan", async () => {
      const res = await request("/api/v1/integrations/email/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: "smtp.example.com" }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: string;
        required_plan: string;
        current_plan: string;
      };
      expect(body.error).toBe("plan_upgrade_required");
      expect(body.required_plan).toBe("business");
      expect(body.current_plan).toBe("trial");
    });
  });

  describe("operator-workspace bypass — admits regardless of plan", () => {
    it("/install admits an operator workspace even when plan_tier=trial and min_plan=business", async () => {
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "trial", is_operator_workspace: true }];
        }
        return [{ slug: "slack", install_model: "oauth", enabled: true, min_plan: "business" }];
      });

      const res = await request("/api/v1/integrations/slack/install");
      // Happy path — redirects to the upstream Slack OAuth page.
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("slack.com/oauth");
    });

    it("/install-form admits an operator workspace even with a starve-low plan_tier", async () => {
      // Reset validateImpl — earlier suites set it to throw a
      // FormInstallValidationError; here we want the happy path.
      validateImpl = async () => ({
        installRecord: { id: "install-email-op", workspaceId: "ws-1" as never, catalogId: "email" },
        credentialWritten: true,
      });
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "trial", is_operator_workspace: true }];
        }
        return [{ slug: "email", install_model: "form", enabled: true, min_plan: "business" }];
      });

      const res = await request("/api/v1/integrations/email/install-form", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: "smtp.example.com" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { installed: boolean };
      expect(body.installed).toBe(true);
    });
  });

  describe("GET /:platform/callback — defensive mid-OAuth plan re-check", () => {
    afterEach(() => {
      stubVerifiedState = null;
    });

    it("denies when the workspace plan dropped below min_plan between /install and /callback", async () => {
      // Mid-OAuth downgrade: a workspace clicks Connect on Salesforce
      // (passes plan check at /install), then somewhere between the
      // Salesforce redirect and the callback the plan drops (billing
      // event, admin downgrade, whatever). The defensive re-check
      // at /callback must catch this — otherwise we'd write
      // workspace_plugins + integration_credentials for a workspace
      // the catalog won't admit, leaving the user with a card that
      // can't be reconnected and a credential that won't refresh.
      stubVerifiedState = { workspaceId: "ws-down", catalogId: "catalog:slack" };
      callbackImpl = async () => happyResult();
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "free", is_operator_workspace: false }];
        }
        return [{ slug: "slack", install_model: "oauth", enabled: true, min_plan: "starter" }];
      });

      // JSON caller — structured 403 body
      const res = await request(
        "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
        { headers: { Accept: "application/json" } },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: string;
        required_plan: string;
        current_plan: string;
      };
      expect(body.error).toBe("plan_upgrade_required");
      expect(body.required_plan).toBe("starter");
      expect(body.current_plan).toBe("free");
    });

    it("redirects browser callers to /admin/integrations?error=<platform>&reason=plan_upgrade_required on mid-OAuth downgrade", async () => {
      stubVerifiedState = { workspaceId: "ws-down", catalogId: "catalog:slack" };
      callbackImpl = async () => happyResult();
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "free", is_operator_workspace: false }];
        }
        return [{ slug: "slack", install_model: "oauth", enabled: true, min_plan: "starter" }];
      });

      const res = await request(
        "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
        { headers: { Accept: "text/html" } },
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("error=slack");
      expect(location).toContain("reason=plan_upgrade_required");
      expect(location).toContain("required_plan=starter");
    });

    it("falls through to the handler when the entitlement read throws — does not burn the OAuth code", async () => {
      // DB-blip handling: if the mid-OAuth plan re-check fails
      // (transient pg outage between /install and /callback), the
      // upstream OAuth code is single-use — 500ing here means the
      // user retries with an expired code and gets a confusing
      // 502 from the provider. Log + fall through to the handler;
      // the original /install already plan-checked.
      stubVerifiedState = { workspaceId: "ws-blip", catalogId: "catalog:slack" };
      callbackImpl = async () => happyResult();
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FROM organization")) {
          throw new Error("simulated transient pg outage");
        }
        return [{ slug: "slack", install_model: "oauth", enabled: true, min_plan: "starter" }];
      });

      const res = await request(
        "/api/v1/integrations/slack/callback?code=auth-abc&state=stub",
        { headers: { Accept: "text/html" } },
      );
      // Happy-path redirect — install lands despite the plan re-check
      // failing. A 5xx here would be the regression to guard against.
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://app.atlas.example/admin/integrations?installed=slack",
      );
    });
  });

  describe("DELETE /:platform — not plan-checked (downgrade cleanup always works)", () => {
    it("permits a free-tier workspace to disconnect an install that requires business", async () => {
      // Worst case: the workspace downgraded post-install and is now
      // below the catalog gate. Disconnect must still succeed —
      // otherwise the install is stranded with no admin-visible UI to
      // clear its credentials.
      mockInternalQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("DELETE FROM workspace_plugins")) {
          callOrder.push("workspace_plugins.delete");
          return [];
        }
        if (sql.includes("FROM plugin_catalog")) {
          return [{ id: "catalog:slack", slug: "slack", install_model: "oauth", enabled: true, min_plan: "business" }];
        }
        if (sql.includes("FROM workspace_plugins")) {
          return [{ team_id: "T-downgraded" }];
        }
        if (sql.includes("FROM organization")) {
          return [{ plan_tier: "free", is_operator_workspace: false }];
        }
        return [];
      });

      const res = await request("/api/v1/integrations/slack", { method: "DELETE" });
      expect(res.status).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/integrations/:platform — disconnect flow.
//
// Two-store teardown per ADR-0003: `chat_cache:<platform>:installation:<teamId>`
// is dropped BEFORE the `workspace_plugins` row, so credentials never
// outlive the install record. The ordering is load-bearing — if the
// install row went first and the chat_cache delete then failed, the
// bot token would still be sitting in the credential store with no
// admin-visible UI to reach it.
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
      // Both the install-side helper (`getInstallableCatalogRowBySlug` —
      // gated on `enabled = true`) and the disconnect-side helper
      // (`getCatalogRowBySlugForDisconnect` — no gate) hit this branch.
      // Return a row with both shapes' fields populated so a single mock
      // serves both.
      return [{ id: "catalog:slack", slug: "slack", install_model: "oauth", enabled: true }];
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
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("returns 404 when the platform slug is not in the catalog", async () => {
    // Catalog SELECT returns no rows for the unknown slug. The
    // disconnect-side helper doesn't filter on `enabled`, so this
    // branch only fires for truly absent slugs — not for kill-switched
    // real Platforms.
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
    authResultImpl = async () => ({
      authenticated: false,
      mode: "managed",
      status: 401,
      error: "Authentication required",
    });

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(401);
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("returns 403 when the caller is authenticated but not an admin", async () => {
    stageSlackInstallLookup("T-abc-123");
    authResultImpl = async () => ({
      authenticated: true,
      mode: "managed",
      user: {
        id: "user-1",
        role: "member",
        activeOrganizationId: "ws-1",
        claims: { twoFactorEnabled: true },
      },
    });

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(403);
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("returns 501 for a real catalog platform whose disconnect path isn't wired", async () => {
    // Future-Platform safety net: catalog returns a `teams` row (a real
    // Platform), but `deleteCredentialStore` only dispatches `slack`
    // today. The 501 must short-circuit before either store is touched.
    mockInternalQuery.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes("FROM plugin_catalog")) {
        return [{ id: "catalog:teams", slug: "teams", install_model: "oauth", enabled: true }];
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
    authResultImpl = async () => ({
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-1",
        role: "admin",
        // no activeOrganizationId
        claims: { twoFactorEnabled: true },
      },
    });

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_org_binding");
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
  });

  it("returns 400 missing_org_binding when SaaS deploy lands a mode=none request (misconfig)", async () => {
    // SaaS pins managed auth in config, so a mode=none branch reaching
    // this endpoint means auth middleware regressed. Fail closed.
    stageSlackInstallLookup("T-abc-123");
    deployModeImpl = () => "saas";
    authResultImpl = async () => ({
      authenticated: true,
      mode: "none",
      user: undefined,
    });

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_org_binding");
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
  });

  it("returns 403 mfa_enrollment_required when a managed admin lacks an enrolled second factor", async () => {
    // Codex P1 — DELETE is destructive; bypass the MFA gate and an admin
    // who only knows a password could disconnect a tenant install. Keep
    // parity with the `mfaRequired` middleware applied to every other
    // admin write surface.
    stageSlackInstallLookup("T-abc-123");
    authResultImpl = async () => ({
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-1",
        role: "admin",
        activeOrganizationId: "ws-1",
        // No twoFactorEnabled / passkeyCount → not enrolled.
        claims: {},
      },
    });

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("mfa_enrollment_required");
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("returns 421 misdirected_request when strict routing detects a cross-region miss", async () => {
    // Codex P2 — `adminAuth`'s misrouting check is what every other
    // admin write inherits via `createAdminRouter`. This handler isn't
    // mounted under that router so the check is inlined.
    stageSlackInstallLookup("T-abc-123");
    mockMisrouted = {
      expectedRegion: "eu",
      actualRegion: "us",
      correctApiUrl: "https://api.eu.useatlas.dev",
    };
    mockStrictRouting = true;

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(421);
    const body = (await res.json()) as { error: string; expectedRegion: string };
    expect(body.error).toBe("misdirected_request");
    expect(body.expectedRegion).toBe("eu");
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("proceeds when misrouting is detected but strict routing is disabled (graceful mode)", async () => {
    stageSlackInstallLookup("T-abc-123");
    mockMisrouted = {
      expectedRegion: "eu",
      actualRegion: "us",
      correctApiUrl: undefined,
    };
    mockStrictRouting = false;

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(200);
  });

  it("succeeds even when the catalog row is kill-switched (enabled=false)", async () => {
    // Codex P2 — ops disables a Platform via plugin_catalog.enabled=false
    // as a kill switch. Existing installs MUST still be tearable down,
    // otherwise the disable strands credentials in chat_cache.
    mockInternalQuery.mockImplementation(async (sql: string): Promise<unknown[]> => {
      if (sql.includes("DELETE FROM workspace_plugins")) {
        callOrder.push("workspace_plugins.delete");
        return [];
      }
      if (sql.includes("FROM plugin_catalog")) {
        // enabled: false — the kill-switched state.
        return [{ id: "catalog:slack", slug: "slack" }];
      }
      if (sql.includes("FROM workspace_plugins")) {
        callOrder.push("workspace_plugins.select");
        return [{ team_id: "T-kill-switched" }];
      }
      return [];
    });

    const res = await request("/api/v1/integrations/slack", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(mockDeleteInstallation).toHaveBeenCalledWith("T-kill-switched");
    expect(callOrder).toContain("workspace_plugins.delete");
  });

  it("self-hosted mode=none falls back to the 'self-hosted' sentinel workspaceId for the install lookup", async () => {
    // Single-tenant self-hosted dev: no real auth identity, but the
    // install was written under the same sentinel by the install
    // handler, so the SELECT must use it.
    const capturedParams: unknown[][] = [];
    mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]): Promise<unknown[]> => {
      if (params) capturedParams.push(params);
      if (sql.includes("DELETE FROM workspace_plugins")) {
        callOrder.push("workspace_plugins.delete");
        return [];
      }
      if (sql.includes("FROM plugin_catalog")) {
        return [{ id: "catalog:slack", slug: "slack", install_model: "oauth", enabled: true }];
      }
      if (sql.includes("FROM workspace_plugins")) {
        callOrder.push("workspace_plugins.select");
        return [{ team_id: "T-self-hosted" }];
      }
      return [];
    });
    // mode=none bypasses the MFA gate (managed-only) and the SaaS
    // misconfig branch (deploy mode stays undefined → not "saas").
    authResultImpl = async () => ({
      authenticated: true,
      mode: "none",
      user: undefined,
    });

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

// ---------------------------------------------------------------------------
// DELETE /api/v1/integrations/salesforce — dual-store teardown for the
// first lazy OAuth integration (#2658).
//
// Same ADR-0003 ordering as Slack but the credential store is
// `integration_credentials` keyed by (workspace_id, catalog_id) rather
// than `chat_cache` keyed by team_id.
// ---------------------------------------------------------------------------

function stageSalesforceInstallLookup(present: boolean) {
  mockInternalQuery.mockImplementation(async (sql: string, _params?: unknown[]): Promise<unknown[]> => {
    if (sql.includes("DELETE FROM workspace_plugins")) {
      callOrder.push("workspace_plugins.delete");
      return [];
    }
    if (sql.includes("FROM plugin_catalog")) {
      return [{ id: "catalog:salesforce", slug: "salesforce", install_model: "oauth", enabled: true }];
    }
    if (sql.includes("FROM workspace_plugins")) {
      callOrder.push("workspace_plugins.select");
      // Salesforce installs don't carry team_id — `team_id` resolves to NULL
      // through the JSONB extraction. The disconnect path tolerates a null
      // teamId for non-Slack platforms.
      return present ? [{ team_id: null }] : [];
    }
    return [];
  });
}

describe("DELETE /api/v1/integrations/salesforce — dual-store teardown", () => {
  it("deletes integration_credentials BEFORE workspace_plugins (ADR-0003 ordering)", async () => {
    stageSalesforceInstallLookup(true);

    const res = await request("/api/v1/integrations/salesforce", { method: "DELETE" });

    expect(res.status).toBe(200);
    const teardownSequence = callOrder.filter(
      (c) => c === "integration_credentials.delete" || c === "workspace_plugins.delete",
    );
    expect(teardownSequence).toEqual([
      "integration_credentials.delete",
      "workspace_plugins.delete",
    ]);
    expect(mockDeleteCredentialBundle).toHaveBeenCalledWith("ws-1", "catalog:salesforce");
    expect(mockDeleteInstallation).not.toHaveBeenCalled();
  });

  it("aborts (no workspace_plugins delete) when integration_credentials delete fails", async () => {
    stageSalesforceInstallLookup(true);
    mockDeleteCredentialBundle.mockImplementationOnce(async () => {
      callOrder.push("integration_credentials.delete");
      throw new Error("integration_credentials write conflict");
    });

    const res = await request("/api/v1/integrations/salesforce", { method: "DELETE" });

    expect(res.status).toBe(500);
    expect(callOrder).toContain("integration_credentials.delete");
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });

  it("returns 404 when no Salesforce install row exists for the workspace", async () => {
    stageSalesforceInstallLookup(false);

    const res = await request("/api/v1/integrations/salesforce", { method: "DELETE" });

    expect(res.status).toBe(404);
    expect(mockDeleteCredentialBundle).not.toHaveBeenCalled();
    expect(callOrder).not.toContain("workspace_plugins.delete");
  });
});
