/**
 * Tests for `api/routes/middleware.ts`.
 *
 * Two halves, merged because both drive the SAME module behind the same four
 * `mock.module()` doubles (auth/middleware, logger, residency/misrouting,
 * residency/readonly) and the doubles below are the union of what each half
 * needed:
 *
 *   1. **Mode resolution.** `resolveMode()` / `parseModeFromCookie()` as pure
 *      functions, plus `resolveStatusClause` (the non-Effect content-mode port
 *      they pair with) and the `RequestContext` test layers that carry the
 *      resolved mode.
 *   2. **Trust-device surfacing and rate-limit buckets** (formerly
 *      `middleware-trust-device.test.ts`). `setTrustDeviceIdentifier()` is
 *      private, so each public middleware (`adminAuth`, `platformAdminAuth`,
 *      `standardAuth`, `requestContext`, `withRequestId`) is driven with a fake
 *      request and the downstream context state is asserted. Auth itself is
 *      mocked because the cookie extraction runs after auth succeeds.
 *
 * ⚠️ The `auth/middleware` double returns a REAL admin user and records every
 * `checkRateLimit` call. The mode-resolution half builds its own `AuthResult`
 * values and hands them to `resolveMode` directly, so it does not read the
 * double at all — but the bucket-routing tests at the bottom cannot run without
 * it, which is why the union is the recorded shape rather than the inert one.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { AuthResult } from "@atlas/api/lib/auth/types";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
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

// Records calls to `checkRateLimit` so the bucket-routing tests at the
// bottom of this file can assert which bucket each middleware debits.
// Populated by every middleware run; `beforeEach` resets it.
const checkRateLimitCalls: Array<{
  key: string;
  options?: { bucket?: string; orgId?: string };
}> = [];

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve({ authenticated: true, mode: "managed", user: authUser }),
  checkRateLimit: (key: string, options?: { bucket?: string; orgId?: string }) => {
    checkRateLimitCalls.push({ key, ...(options !== undefined ? { options } : {})});
    return { allowed: true };
  },
  getClientIP: () => "10.0.0.1",
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
}));

let withRequestContextCalls: Array<Record<string, unknown>> = [];

void mock.module("@atlas/api/lib/logger", () => {
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

void mock.module("@atlas/api/lib/residency/misrouting", () => ({
  detectMisrouting: async () => null,
  isStrictRoutingEnabled: () => false,
}));

void mock.module("@atlas/api/lib/residency/readonly", () => ({
  isWorkspaceMigrating: async () => false,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

const {
  resolveMode,
  parseModeFromCookie,
  adminAuth,
  platformAdminAuth,
  standardAuth,
  requestContext,
  withRequestId,
} = await import("../middleware");
const { resolveStatusClause } = await import("@atlas/api/lib/content-mode/port");

// ---------------------------------------------------------------------------
// Helpers — the fake Hono context the middleware half drives
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
  checkRateLimitCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminAuthResult(): AuthResult & { authenticated: true } {
  return {
    authenticated: true,
    mode: "managed",
    user: {
      id: "admin-1",
      mode: "managed",
      label: "admin@test.com",
      role: "admin",
      activeOrganizationId: "org-1",
    },
  };
}

function ownerAuth(): AuthResult & { authenticated: true } {
  return {
    authenticated: true,
    mode: "managed",
    user: {
      id: "owner-1",
      mode: "managed",
      label: "owner@test.com",
      role: "owner",
      activeOrganizationId: "org-1",
    },
  };
}

function platformAdminAuthResult(): AuthResult & { authenticated: true } {
  return {
    authenticated: true,
    mode: "managed",
    user: {
      id: "pa-1",
      mode: "managed",
      label: "platform@test.com",
      role: "platform_admin",
      activeOrganizationId: "org-1",
    },
  };
}

function memberAuth(): AuthResult & { authenticated: true } {
  return {
    authenticated: true,
    mode: "managed",
    user: {
      id: "member-1",
      mode: "managed",
      label: "member@test.com",
      role: "member",
      activeOrganizationId: "org-1",
    },
  };
}

function simpleKeyAuth(): AuthResult & { authenticated: true } {
  return {
    authenticated: true,
    mode: "simple-key",
    user: {
      id: "sk-1",
      mode: "simple-key",
      label: "key-user",
      // role is undefined — BYOT/simple-key users may not have explicit roles
    },
  };
}

function noneAuth(): AuthResult & { authenticated: true } {
  return {
    authenticated: true,
    mode: "none",
    user: undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveMode", () => {
  // ── Default behavior ────────────────────────────────────────────────

  it("defaults to published when no cookie or header", () => {
    expect(resolveMode(null, null, adminAuthResult())).toBe("published");
  });

  it("defaults to published when cookie is empty", () => {
    expect(resolveMode("", null, adminAuthResult())).toBe("published");
  });

  // ── Cookie reading ──────────────────────────────────────────────────

  it("reads developer from atlas-mode cookie for admin", () => {
    expect(resolveMode("atlas-mode=developer", null, adminAuthResult())).toBe("developer");
  });

  it("reads developer from atlas-mode cookie for owner", () => {
    expect(resolveMode("atlas-mode=developer", null, ownerAuth())).toBe("developer");
  });

  it("reads developer from atlas-mode cookie for platform_admin", () => {
    expect(resolveMode("atlas-mode=developer", null, platformAdminAuthResult())).toBe("developer");
  });

  it("reads published from atlas-mode cookie", () => {
    expect(resolveMode("atlas-mode=published", null, adminAuthResult())).toBe("published");
  });

  it("handles atlas-mode cookie among other cookies", () => {
    expect(resolveMode("session=abc; atlas-mode=developer; theme=dark", null, adminAuthResult())).toBe("developer");
  });

  // ── Header fallback ─────────────────────────────────────────────────

  it("falls back to X-Atlas-Mode header when no cookie", () => {
    expect(resolveMode(null, "developer", adminAuthResult())).toBe("developer");
  });

  it("cookie takes priority over header", () => {
    expect(resolveMode("atlas-mode=published", "developer", adminAuthResult())).toBe("published");
  });

  // ── Non-admin always published ──────────────────────────────────────

  it("non-admin (member) always resolves to published even with developer cookie", () => {
    expect(resolveMode("atlas-mode=developer", null, memberAuth())).toBe("published");
  });

  it("non-admin (member) always resolves to published even with developer header", () => {
    expect(resolveMode(null, "developer", memberAuth())).toBe("published");
  });

  // ── User with undefined role (BYOT / simple-key) ────────────────────

  it("user with undefined role resolves to published even with developer cookie", () => {
    expect(resolveMode("atlas-mode=developer", null, simpleKeyAuth())).toBe("published");
  });

  // ── Auth mode "none" (local dev) ───────────────────────────────────

  it("auth mode none (local dev) allows developer", () => {
    expect(resolveMode("atlas-mode=developer", null, noneAuth())).toBe("developer");
  });

  it("auth mode none without cookie defaults to published", () => {
    expect(resolveMode(null, null, noneAuth())).toBe("published");
  });

  // ── Invalid cookie values ──────────────────────────────────────────

  it("ignores invalid cookie value and defaults to published", () => {
    expect(resolveMode("atlas-mode=foobar", null, adminAuthResult())).toBe("published");
  });

  it("ignores invalid header value and defaults to published", () => {
    expect(resolveMode(null, "foobar", adminAuthResult())).toBe("published");
  });
});

// ---------------------------------------------------------------------------
// parseModeFromCookie
// ---------------------------------------------------------------------------

describe("parseModeFromCookie", () => {
  it("returns undefined for null", () => {
    expect(parseModeFromCookie(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseModeFromCookie("")).toBeUndefined();
  });

  it("reads atlas-mode value when present alone", () => {
    expect(parseModeFromCookie("atlas-mode=developer")).toBe("developer");
  });

  it("reads atlas-mode value among other cookies", () => {
    expect(parseModeFromCookie("session=abc; atlas-mode=developer; theme=dark")).toBe("developer");
  });

  it("is exact-match — different key prefixes do not collide", () => {
    expect(parseModeFromCookie("atlas-mode-other=developer")).toBeUndefined();
  });

  it("returns the full value verbatim — no special handling of unknown values", () => {
    // resolveMode() filters unknown values; parseModeFromCookie just extracts
    expect(parseModeFromCookie("atlas-mode=developer_extra")).toBe("developer_extra");
  });

  it("returns undefined when atlas-mode key is absent", () => {
    expect(parseModeFromCookie("session=abc; theme=dark")).toBeUndefined();
  });
});

// resolveStatusClause is the non-Effect public successor to
// `buildUnionStatusClause` (retired in #1531). The same mode-semantics
// invariants must hold for the simple-table clause regardless of which
// entry point emits it — cover them here so a regression in either the
// Effect path or the direct-call path (getPopularSuggestions) is caught.
// The Effect path has richer coverage in `content-mode/__tests__/registry.test.ts`.
describe("resolveStatusClause (simple content tables)", () => {
  it("published mode restricts to <alias>.status = 'published'", () => {
    expect(resolveStatusClause("query_suggestions", "published", "qs")).toBe(
      "qs.status = 'published'",
    );
  });

  it("developer mode includes draft alongside published", () => {
    expect(resolveStatusClause("query_suggestions", "developer", "qs")).toBe(
      "qs.status IN ('published', 'draft')",
    );
  });

  it("never returns archived in either mode (archived is always excluded)", () => {
    expect(resolveStatusClause("connections", "published", "c")).not.toContain("archived");
    expect(resolveStatusClause("connections", "developer", "c")).not.toContain("archived");
  });

  it("developer mode never surfaces draft_delete via the simple union", () => {
    // Tombstones only apply to semantic_entities (CTE overlay). Connections,
    // prompt_collections, and query_suggestions don't use draft_delete.
    expect(resolveStatusClause("prompt_collections", "developer", "p")).not.toContain(
      "draft_delete",
    );
  });

  it("undefined mode defaults to published (most restrictive)", () => {
    expect(resolveStatusClause("query_suggestions", undefined, "qs")).toBe(
      "qs.status = 'published'",
    );
  });

  it("accepts either the segment key or the physical table name for aliases", () => {
    expect(resolveStatusClause("prompts", "published", "p")).toBe(
      "p.status = 'published'",
    );
    expect(resolveStatusClause("prompt_collections", "published", "p")).toBe(
      "p.status = 'published'",
    );
  });

  it("throws for unregistered tables (prevents typo drift)", () => {
    expect(() => resolveStatusClause("bogus_table", "published", "b")).toThrow(
      /not a registered content-mode table/,
    );
  });

  it("throws for exotic tables — exotic entries need CTE overlays", () => {
    expect(() =>
      resolveStatusClause("semantic_entities", "developer", "s"),
    ).toThrow(/exotic entry/);
  });
});

// ---------------------------------------------------------------------------
// Test layer integration — verify mode flows through RequestContext
// ---------------------------------------------------------------------------

describe("RequestContext atlasMode", () => {
  it("createRequestContextTestLayer defaults to published", async () => {
    const { Effect } = await import("effect");
    const { createRequestContextTestLayer, RequestContext } = await import(
      "@atlas/api/lib/effect/services"
    );

    const layer = createRequestContextTestLayer();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* RequestContext;
        return ctx.atlasMode;
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toBe("published");
  });

  it("createRequestContextTestLayer accepts mode override", async () => {
    const { Effect } = await import("effect");
    const { createRequestContextTestLayer, RequestContext } = await import(
      "@atlas/api/lib/effect/services"
    );

    const layer = createRequestContextTestLayer({ atlasMode: "developer" });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* RequestContext;
        return ctx.atlasMode;
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toBe("developer");
  });

  it("buildTestLayer supports mode override via request partial", async () => {
    const { Effect } = await import("effect");
    const { RequestContext } = await import("@atlas/api/lib/effect/services");
    const { buildTestLayer } = await import("../../../__test-utils__/layers");

    const layer = buildTestLayer({ request: { atlasMode: "developer" } });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ctx = yield* RequestContext;
        return ctx.atlasMode;
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toBe("developer");
  });
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

// ---------------------------------------------------------------------------
// withRequestId — covers the admin.ts path (auth runs inline per-handler,
// so the cookie has to be parsed by this lightweight middleware before the
// route preamble has access to authResult)
// ---------------------------------------------------------------------------

describe("withRequestId — populates trustDeviceIdentifier on Hono context + ALS", () => {
  it("sets c.get('trustDeviceIdentifier') from a signed cookie", async () => {
    const c = fakeContext(
      buildRequest("better-auth.trust_device=hmac!trust-device-via-witness"),
    );

    await withRequestId(c as never, async () => {});

    expect(c.get("trustDeviceIdentifier")).toBe("trust-device-via-witness");
  });

  it("threads trustDeviceIdentifier into withRequestContext", async () => {
    const c = fakeContext(
      buildRequest("better-auth.trust_device=hmac!trust-device-witness-2"),
    );

    await withRequestId(c as never, async () => {});

    const lastCall =
      withRequestContextCalls[withRequestContextCalls.length - 1];
    expect(lastCall.trustDeviceIdentifier).toBe("trust-device-witness-2");
  });

  it("passes undefined when no cookie is present", async () => {
    const c = fakeContext(buildRequest(null));

    await withRequestId(c as never, async () => {});

    expect(c.get("trustDeviceIdentifier")).toBeUndefined();
    const lastCall =
      withRequestContextCalls[withRequestContextCalls.length - 1];
    expect(lastCall.trustDeviceIdentifier).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #2485 — admin bucket wiring regression pin
// ---------------------------------------------------------------------------

/**
 * Locks the bucket each auth middleware passes to `checkRateLimit`.
 * Without this, a refactor that drops the `"admin"` arg from
 * `rateLimitAndIPCheck`'s call sites in `adminAuth` / `platformAdminAuth`
 * would silently regress #2485 — the bucket-primitive isolation tests
 * in `lib/auth/__tests__/middleware.test.ts` exercise `checkRateLimit`
 * directly and would all stay green even with the wiring broken.
 * Mirrors the F-74 chat-bucket pin in `api/__tests__/chat.test.ts`.
 */
describe("auth middleware → checkRateLimit bucket routing (#2485, F-74)", () => {
  it("adminAuth debits the admin bucket", async () => {
    const c = fakeContext(buildRequest(null));

    await adminAuth(c as never, async () => {});

    expect(checkRateLimitCalls.length).toBe(1);
    // orgId rides along since #3406 so the workspace tier of the
    // rate-limit sub-bucket keys resolves for the authed org.
    expect(checkRateLimitCalls[0]!.options).toEqual({ bucket: "admin", orgId: "org-1" });
  });

  it("platformAdminAuth debits the admin bucket", async () => {
    authUser = platformUser;
    const c = fakeContext(buildRequest(null));

    await platformAdminAuth(c as never, async () => {});

    expect(checkRateLimitCalls.length).toBe(1);
    expect(checkRateLimitCalls[0]!.options).toEqual({ bucket: "admin", orgId: "org-1" });
  });

  it("standardAuth debits the default bucket (no options arg)", async () => {
    const c = fakeContext(buildRequest(null));

    await standardAuth(c as never, async () => {});

    // `rateLimitAndIPCheck` calls `checkRateLimit(key, { bucket: "default" })`
    // when invoked without an explicit bucket — the parameter default
    // turns into an explicit option object at the call site.
    expect(checkRateLimitCalls.length).toBe(1);
    expect(checkRateLimitCalls[0]!.options).toEqual({ bucket: "default", orgId: "org-1" });
  });
});
