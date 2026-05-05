/**
 * #2082 PR C.3 — verify the trust-device cookie threads through the auth
 * middlewares onto the Hono context (`c.get("trustDeviceIdentifier")`)
 * AND through `withRequestContext` so `logAdminAction` can pick it up
 * via `getRequestContext()`.
 *
 * Tests the orchestration in `setTrustDeviceIdentifier()` indirectly —
 * the helper is private so we drive each public middleware (`adminAuth`,
 * `platformAdminAuth`, `standardAuth`) with a fake request and assert the
 * downstream context state. Auth itself is mocked because the cookie
 * extraction runs after auth succeeds.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the middleware module
// ---------------------------------------------------------------------------

const adminUser = {
  id: "admin-1",
  mode: "managed" as const,
  label: "admin@test.com",
  role: "admin" as const,
  activeOrganizationId: "org-1",
};

const platformUser = {
  ...adminUser,
  id: "platform-1",
  role: "platform_admin" as const,
};

let authUser: typeof adminUser | typeof platformUser = adminUser;

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve({ authenticated: true, mode: "managed", user: authUser }),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => "10.0.0.1",
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
}));

let withRequestContextCalls: Array<Record<string, unknown>> = [];

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => logger,
  };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (ctx: Record<string, unknown>, fn: () => unknown) => {
      withRequestContextCalls.push(ctx);
      return fn();
    },
    getRequestContext: () => undefined,
    redactPaths: [],
  };
});

mock.module("@atlas/api/lib/residency/misrouting", () => ({
  detectMisrouting: async () => null,
  isStrictRoutingEnabled: () => false,
}));

mock.module("@atlas/api/lib/residency/readonly", () => ({
  isWorkspaceMigrating: async () => false,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

const {
  adminAuth,
  platformAdminAuth,
  standardAuth,
  requestContext,
} = await import("../middleware");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeContext {
  req: { raw: Request; method: string; header: (name: string) => string | undefined };
  set: (key: string, value: unknown) => void;
  get: (key: string) => unknown;
  json: (
    body: Record<string, unknown>,
    status?: number,
    headers?: Record<string, string>,
  ) => Response;
  var: Record<string, unknown>;
}

function fakeContext(req: Request): FakeContext {
  const vars: Record<string, unknown> = {};
  return {
    req: {
      raw: req,
      method: req.method,
      header: (name: string) => req.headers.get(name) ?? undefined,
    },
    set: (key, value) => {
      vars[key] = value;
    },
    get: (key) => vars[key],
    json: (body, status = 200, _headers) =>
      new Response(JSON.stringify(body), { status }),
    var: vars,
  };
}

function buildRequest(cookieHeader: string | null): Request {
  const headers: Record<string, string> = {};
  if (cookieHeader) headers.cookie = cookieHeader;
  return new Request("http://test.local/admin/orgs", {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  authUser = adminUser;
  withRequestContextCalls = [];
});

// ---------------------------------------------------------------------------
// adminAuth
// ---------------------------------------------------------------------------

describe("adminAuth — trust-device cookie surfacing", () => {
  it("populates c.get('trustDeviceIdentifier') from a signed cookie", async () => {
    const c = fakeContext(
      buildRequest("better-auth.trust_device=hmac!trust-device-abc123"),
    );

    await adminAuth(c as never, async () => {});

    expect(c.get("trustDeviceIdentifier")).toBe("trust-device-abc123");
  });

  it("populates undefined when no cookie is present", async () => {
    const c = fakeContext(buildRequest(null));

    await adminAuth(c as never, async () => {});

    // Strictly undefined — never the empty string or null. Downstream
    // consumers (`requestContext`, the Effect bridge) test for undefined
    // and skip writing the field when absent.
    expect(c.get("trustDeviceIdentifier")).toBeUndefined();
  });

  it("populates undefined when the cookie is malformed", async () => {
    // Cookie with no '!' separator — extractor returns null, surfaces as undefined.
    const c = fakeContext(
      buildRequest("better-auth.trust_device=missing-bang-marker"),
    );

    await adminAuth(c as never, async () => {});

    expect(c.get("trustDeviceIdentifier")).toBeUndefined();
  });

  it("ignores cookies with a non-trust-device prefix on the value", async () => {
    const c = fakeContext(
      buildRequest("better-auth.trust_device=hmac!session-token-abc"),
    );

    await adminAuth(c as never, async () => {});

    expect(c.get("trustDeviceIdentifier")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// platformAdminAuth + standardAuth — same surfacing path
// ---------------------------------------------------------------------------

describe("platformAdminAuth — trust-device cookie surfacing", () => {
  it("populates c.get('trustDeviceIdentifier') from a signed cookie", async () => {
    authUser = platformUser;
    const c = fakeContext(
      buildRequest("better-auth.trust_device=hmac!trust-device-platform"),
    );

    await platformAdminAuth(c as never, async () => {});

    expect(c.get("trustDeviceIdentifier")).toBe("trust-device-platform");
  });
});

describe("standardAuth — trust-device cookie surfacing", () => {
  it("populates c.get('trustDeviceIdentifier') from a signed cookie", async () => {
    const c = fakeContext(
      buildRequest("better-auth.trust_device=hmac!trust-device-user"),
    );

    await standardAuth(c as never, async () => {});

    expect(c.get("trustDeviceIdentifier")).toBe("trust-device-user");
  });
});

// ---------------------------------------------------------------------------
// requestContext — threads trustDeviceIdentifier through withRequestContext
// ---------------------------------------------------------------------------

describe("requestContext — propagates trustDeviceIdentifier into AsyncLocalStorage", () => {
  it("includes trustDeviceIdentifier in withRequestContext call when cookie is present", async () => {
    const c = fakeContext(
      buildRequest("better-auth.trust_device=hmac!trust-device-abc123"),
    );
    // Pre-populate auth state since requestContext expects auth middleware to have run
    await adminAuth(c as never, async () => {
      await requestContext(c as never, async () => {});
    });

    expect(withRequestContextCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = withRequestContextCalls[withRequestContextCalls.length - 1];
    expect(lastCall.trustDeviceIdentifier).toBe("trust-device-abc123");
  });

  it("passes undefined when the cookie is absent", async () => {
    const c = fakeContext(buildRequest(null));

    await adminAuth(c as never, async () => {
      await requestContext(c as never, async () => {});
    });

    const lastCall = withRequestContextCalls[withRequestContextCalls.length - 1];
    expect(lastCall.trustDeviceIdentifier).toBeUndefined();
  });
});
