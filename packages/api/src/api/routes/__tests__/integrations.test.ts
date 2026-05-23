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
  registerFormHandler,
  registerOAuthHandler,
  type FormBasedInstallHandler,
  type OAuthPlatformInstallHandler,
} from "@atlas/api/lib/integrations/install";
import { EmailFormValidationError } from "@atlas/api/lib/integrations/install/email-form-handler";

// ---------------------------------------------------------------------------
// Auth — admin user with an org binding for the install route. The
// callback handler doesn't gate on auth (the state token is the gate),
// so the admin shape is only load-bearing for the install endpoint;
// callback tests pass anonymous requests through fine.
// ---------------------------------------------------------------------------

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: mock(() =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "admin-1",
        role: "admin",
        activeOrganizationId: "ws-1",
      },
    }),
  ),
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

// ---------------------------------------------------------------------------
// Internal DB — the catalog row lookup hits `internalQuery`. Default
// response is the Slack OAuth row; individual tests override via
// `mockInternalQuery.mockImplementationOnce` for the "platform not
// found" path.
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
  mockInternalQuery.mockImplementation(async () => [
    { slug: "slack", install_model: "oauth", enabled: true },
  ]);
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
      { slug: "email", install_model: "form", enabled: true },
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
      { slug: "email", install_model: "form", enabled: true },
    ]);
    // Simulate the real EmailFormInstallHandler refusing the form
    // for a missing password — the route must translate this to a
    // 400 with field-level detail.
    validateImpl = async () => {
      throw new EmailFormValidationError({ password: ["password is required"] });
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
      { slug: "slack", install_model: "oauth", enabled: true },
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
