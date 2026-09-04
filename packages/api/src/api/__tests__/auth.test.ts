/**
 * Unit tests for `src/api/routes/auth.ts` — the Hono auth catch-all route and
 * the pure helpers it exports.
 *
 * Catch-all: non-managed modes return 404, managed mode delegates to Better
 * Auth's fetch handler, and errors return 503.
 *
 * Also covers the two helper surfaces that used to live in sibling files —
 * formerly `auth-client-ip.test.ts` (the F-06 IP-injection middleware) and
 * `auth-signup-normalize.test.ts` (the #1792 signup-envelope wrapper). Both
 * exercise the same source module with no `mock.module` of their own, so they
 * fold in here without changing what any assertion sees.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { Context } from "hono";

// --- Mocks ---

let mockAuthMode: string = "none";

void mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => mockAuthMode,
  resetAuthModeCache: () => {},
}));

/**
 * Mock Better Auth instance with a fetch-compatible .handler method.
 * Each test can override mockHandler.
 */
let mockHandler: (req: Request) => Response | Promise<Response> = () =>
  new Response("ok", { status: 200 });

void mock.module("@atlas/api/lib/auth/server", () => ({
  getAuthInstance: () => ({
    handler: (req: Request) => mockHandler(req),
  }),
  resetAuthInstance: () => {},
}));

// Mock modules needed by chat and health routes (loaded when importing ../index).
// We do NOT mock @/lib/logger — it works fine and mocking it globally would
// break other test files in the same bun test run.
void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve({ authenticated: true, mode: "none", user: undefined }),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

void mock.module("@atlas/api/lib/agent", () => ({
  runAgent: () =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
    }),
}));

void mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: () => Promise.resolve([]),
  getStartupWarnings: () => [],
}));

void mock.module("@atlas/api/lib/semantic", () => ({
  getOrgWhitelistedTables: () => new Set(),
  loadOrgWhitelist: async () => new Map(),
  invalidateOrgWhitelist: () => {},
  getOrgSemanticIndex: async () => "",
  invalidateOrgSemanticIndex: () => {},
  _resetOrgWhitelists: () => {},
  _resetOrgSemanticIndexes: () => {},
  getWhitelistedTables: () => new Set(),
  _resetWhitelists: () => {},
}));

void mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
}));

// Import after mocks
const { app } = await import("../index");

// The route module's pure helpers, resolved dynamically for the same reason the
// app is: a static `import` hoists above the `mock.module` calls, so
// `routes/auth` would bind the REAL `lib/auth/server` and the catch-all tests
// below would stop seeing `mockHandler`.
const {
  withClientIpHeader,
  shouldTrustProxyHeaders,
  stripPortSuffix,
  maybeNormalizeSignupResponse,
} = await import("../routes/auth");

describe("Auth catch-all route (/api/auth/*)", () => {
  beforeEach(() => {
    mockAuthMode = "none";
    mockHandler = () => new Response("ok", { status: 200 });
  });

  function makeRequest(
    method: "GET" | "POST" = "GET",
    path = "/api/auth/session",
  ): Request {
    return new Request(`http://localhost${path}`, { method });
  }

  // ----- Non-managed mode → 404 -----

  describe("non-managed mode", () => {
    for (const mode of ["none", "simple-key", "byot"] as const) {
      it(`returns 404 when auth mode is '${mode}' (GET)`, async () => {
        mockAuthMode = mode;
        const res = await app.fetch(makeRequest("GET"));

        expect(res.status).toBe(404);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.error).toBe("not_found");
        expect(body.message).toContain("not enabled");
      });

      it(`returns 404 when auth mode is '${mode}' (POST)`, async () => {
        mockAuthMode = mode;
        const res = await app.fetch(makeRequest("POST"));

        expect(res.status).toBe(404);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.error).toBe("not_found");
      });
    }
  });

  // ----- Managed mode → delegates to Better Auth -----

  describe("managed mode", () => {
    beforeEach(() => {
      mockAuthMode = "managed";
    });

    it("delegates GET to Better Auth handler", async () => {
      mockHandler = () =>
        Response.json({ session: { id: "sess_1" } }, { status: 200 });

      const res = await app.fetch(makeRequest("GET"));
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.session).toBeDefined();
    });

    it("delegates POST to Better Auth handler", async () => {
      mockHandler = () =>
        Response.json({ user: { id: "usr_1" } }, { status: 200 });

      const res = await app.fetch(makeRequest("POST"));
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.user).toBeDefined();
    });
  });

  // ----- Error handling → 503 -----

  describe("error handling", () => {
    beforeEach(() => {
      mockAuthMode = "managed";
    });

    it("returns 503 when handler throws", async () => {
      mockHandler = () => {
        throw new Error("DB connection failed");
      };

      const res = await app.fetch(makeRequest("GET"));
      expect(res.status).toBe(503);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("auth_service_error");
      expect(body.message).toContain("unavailable");
    });

    it("returns 503 when handler throws non-Error", async () => {
      mockHandler = () => {
        throw "unexpected string error";
      };

      const res = await app.fetch(makeRequest("GET"));
      expect(res.status).toBe(503);
    });
  });

  // ----- #3164/#3166: native admin remove-user endpoint is blocked -----

  describe("native admin remove-user endpoint (Codex P1 on #3171)", () => {
    beforeEach(() => {
      mockAuthMode = "managed";
    });

    it("refuses POST /api/auth/admin/remove-user with 403 + does NOT reach Better Auth", async () => {
      let handlerCalled = false;
      mockHandler = () => {
        handlerCalled = true;
        return Response.json({ ok: true }, { status: 200 });
      };

      const res = await app.fetch(makeRequest("POST", "/api/auth/admin/remove-user"));

      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("forbidden");
      expect(body.code).toBe("ATLAS_USE_ADMIN_API");
      expect(String(body.message)).toContain("/api/v1/admin/users/{id}");
      // The native delete must never reach Better Auth — that's the bypass.
      expect(handlerCalled).toBe(false);
    });

    it("does NOT block a GET to the same path (only the mutating POST is the bypass)", async () => {
      mockHandler = () => Response.json({ ok: true }, { status: 200 });
      const res = await app.fetch(makeRequest("GET", "/api/auth/admin/remove-user"));
      // GET isn't the delete verb — it falls through to Better Auth (which will
      // 404/405 it). We only assert we didn't 403-block it ourselves.
      expect(res.status).not.toBe(403);
    });

    it("still delegates other admin endpoints (e.g. list-users) to Better Auth", async () => {
      mockHandler = () => Response.json({ users: [] }, { status: 200 });
      const res = await app.fetch(makeRequest("POST", "/api/auth/admin/list-users"));
      expect(res.status).toBe(200);
    });
  });
});

/**
 * Regression tests for the F-06 IP-injection middleware (formerly
 * `auth-client-ip.test.ts`).
 *
 * `withClientIpHeader` is the trust boundary for Better Auth's rate
 * limiter: if it resolves the wrong IP, or lets an attacker spoof it,
 * or silently skips writing the header, the rate limits stop working.
 * These tests pin the behaviors the security audit called out.
 */

const ORIGINAL_ENV = { ...process.env };

// `withClientIpHeader` takes a Hono `Context`. For unit testing we only
// need the shape the function actually touches — `c.req.raw` and, when
// falling back to socket resolution, the underlying Bun `server` that
// Hono's `getConnInfo` reads via `c.env`. A plain object with those two
// fields is enough and keeps the tests off the real Hono app.
interface FakeCtx {
  req: { raw: Request };
  env: unknown;
}

function makeIpCtx(init: { headers?: Record<string, string>; serverIp?: string }): FakeCtx {
  const req = new Request("http://localhost/auth/sign-in/email", {
    method: "POST",
    headers: init.headers,
  });
  // Hono's getConnInfo calls server.requestIP(req). A minimal stub
  // returns { address } when we want to simulate a Bun socket, or
  // throws to simulate the "no server" case (Next.js standalone).
  const env = init.serverIp === undefined
    ? { requestIP: () => { throw new Error("no Bun server in env"); } }
    : { requestIP: () => ({ address: init.serverIp!, family: "IPv4", port: 54321 }) };
  return { req: { raw: req }, env };
}

describe("shouldTrustProxyHeaders", () => {
  it("defaults to false", () => {
    expect(shouldTrustProxyHeaders({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("trusts when ATLAS_TRUST_PROXY is 'true' or '1'", () => {
    expect(shouldTrustProxyHeaders({ ATLAS_TRUST_PROXY: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldTrustProxyHeaders({ ATLAS_TRUST_PROXY: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("ignores other truthy spellings to avoid accidental trust", () => {
    // Deliberately stricter than resolveRequireEmailVerification —
    // accidentally trusting a proxy that isn't actually in front of
    // you makes X-Forwarded-For client-spoofable.
    expect(shouldTrustProxyHeaders({ ATLAS_TRUST_PROXY: "yes" } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldTrustProxyHeaders({ ATLAS_TRUST_PROXY: "TRUE" } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldTrustProxyHeaders({ ATLAS_TRUST_PROXY: "on" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("auto-enables trust on Vercel (VERCEL=1)", () => {
    // Vercel's edge always sets X-Forwarded-For and never exposes a
    // Bun socket; without auto-trust, rate limiting would silently
    // no-op for every Vercel deploy.
    expect(shouldTrustProxyHeaders({ VERCEL: "1" } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("stripPortSuffix", () => {
  it("strips a trailing port from an IPv4 address", () => {
    expect(stripPortSuffix("1.2.3.4:54321")).toBe("1.2.3.4");
  });

  it("strips the bracketed port form from IPv6", () => {
    expect(stripPortSuffix("[2001:db8::1]:54321")).toBe("2001:db8::1");
    expect(stripPortSuffix("[::1]:54321")).toBe("::1");
  });

  it("leaves bare IPv6 untouched (no trailing port)", () => {
    // These must pass through unmangled — rate-limit buckets key on
    // the exact string, and rewriting `::1` to `::` would clobber it.
    expect(stripPortSuffix("::1")).toBe("::1");
    expect(stripPortSuffix("2001:db8::1")).toBe("2001:db8::1");
  });

  it("leaves IPv6 with zone identifier untouched", () => {
    // Link-local IPv6 (fe80::1%eth0) has multiple colons so the IPv4
    // port-strip heuristic doesn't fire. A future refactor that
    // simplifies to split-on-first-colon would silently mangle this.
    expect(stripPortSuffix("fe80::1%eth0")).toBe("fe80::1%eth0");
  });

  it("leaves non-numeric trailing segments untouched", () => {
    // Docstring promises "port suffix" not "anything after a colon".
    // A misconfigured proxy forwarding `host:something` or a malformed
    // `1.2.3.4:abc` must pass through — silently lopping off `:abc`
    // would hide a misconfiguration AND put the request in a bucket
    // the operator didn't expect.
    expect(stripPortSuffix("host:something")).toBe("host:something");
    expect(stripPortSuffix("1.2.3.4:abc")).toBe("1.2.3.4:abc");
  });

  it("leaves bare IPv4 untouched", () => {
    expect(stripPortSuffix("1.2.3.4")).toBe("1.2.3.4");
  });

  it("trims surrounding whitespace", () => {
    expect(stripPortSuffix("  1.2.3.4  ")).toBe("1.2.3.4");
  });
});

describe("withClientIpHeader", () => {
  beforeEach(() => {
    // Reset the env variables the middleware reads so tests don't leak
    // into each other.
    delete process.env.ATLAS_TRUST_PROXY;
    delete process.env.VERCEL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("strips any inbound x-atlas-client-ip header (spoof prevention)", () => {
    // An attacker cannot pick their own rate-limit bucket.
    const ctx = makeIpCtx({
      headers: { "x-atlas-client-ip": "99.99.99.99" },
      serverIp: "203.0.113.5",
    });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBe("203.0.113.5");
    expect(out.headers.get("x-atlas-client-ip")).not.toBe("99.99.99.99");
  });

  it("leaves x-atlas-client-ip unset when no IP source resolves", () => {
    // Better Auth will log a warn and skip rate limiting for this
    // request — preferable to writing "unknown" which would make one
    // attacker exhaust every other caller's bucket.
    const ctx = makeIpCtx({});
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBeNull();
  });

  it("does NOT consult X-Forwarded-For when ATLAS_TRUST_PROXY is unset", () => {
    // Without an explicit trust signal, any client can set
    // X-Forwarded-For to spoof their IP. The middleware must ignore
    // the header and fall back to the socket address.
    const ctx = makeIpCtx({
      headers: { "x-forwarded-for": "1.2.3.4" },
      serverIp: "203.0.113.5",
    });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBe("203.0.113.5");
  });

  it("uses X-Forwarded-For when ATLAS_TRUST_PROXY=true", () => {
    process.env.ATLAS_TRUST_PROXY = "true";
    const ctx = makeIpCtx({
      headers: { "x-forwarded-for": "1.2.3.4" },
      serverIp: "203.0.113.5",
    });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBe("1.2.3.4");
  });

  it("picks the first (client-most) entry of a multi-hop X-Forwarded-For", () => {
    // XFF chain: "<client>, <proxy1>, <proxy2>". Picking the last
    // entry would rate-limit by proxy IP, pooling every user behind
    // the same CDN into one bucket.
    process.env.ATLAS_TRUST_PROXY = "true";
    const ctx = makeIpCtx({
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1, 10.0.0.2" },
      serverIp: "127.0.0.1",
    });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBe("203.0.113.5");
  });

  it("falls back to X-Real-IP when XFF is absent and proxy is trusted", () => {
    process.env.ATLAS_TRUST_PROXY = "true";
    const ctx = makeIpCtx({
      headers: { "x-real-ip": "203.0.113.5" },
      serverIp: "127.0.0.1",
    });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBe("203.0.113.5");
  });

  it("passes IPv6 addresses through unmangled", () => {
    const ctx = makeIpCtx({ serverIp: "2001:db8::1" });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBe("2001:db8::1");
  });

  it("strips port suffixes from resolved IPs (per-bucket integrity)", () => {
    // Bun's server.requestIP sometimes returns "address:port" style
    // for forwarded sockets; leaving the port in would create one
    // bucket per ephemeral source port, silently defeating the limit.
    const ctx = makeIpCtx({ serverIp: "1.2.3.4:54321" });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBe("1.2.3.4");
  });

  it("strips port suffixes from X-Forwarded-For entries", () => {
    process.env.ATLAS_TRUST_PROXY = "true";
    const ctx = makeIpCtx({
      headers: { "x-forwarded-for": "203.0.113.5:443" },
    });
    const out = withClientIpHeader(ctx as never);
    expect(out.headers.get("x-atlas-client-ip")).toBe("203.0.113.5");
  });

  it("does not crash when getConnInfo throws (Next.js standalone / test harness)", () => {
    // On Vercel, `app.fetch(req)` is called without the Bun server,
    // so getConnInfo has nothing to read. The middleware must not
    // 500 the request — it falls back to leaving the header unset.
    const ctx = makeIpCtx({});
    expect(() => withClientIpHeader(ctx as never)).not.toThrow();
  });
});

/**
 * Regression tests for the Hono-route wrapper that carries the F-P3 /
 * #1792 fix (formerly `auth-signup-normalize.test.ts`).
 *
 * The parity test in `lib/auth/__tests__/rate-limit-integration.test.ts`
 * drives a real Better Auth instance and applies the pure helper at
 * the test boundary — that assertion proves the oracle is closed, but
 * it bypasses the wrapper. These tests own the wrapper's scope guards
 * and Response-rebuild invariants:
 *
 *   1. Path guard — only `/sign-up/email` responses are rewritten.
 *   2. Status guard — non-2xx (error envelopes) flow through untouched.
 *   3. Content-type guard — non-JSON bodies flow through untouched.
 *   4. Parse-failure guard — JSON-advertised but malformed bodies flow
 *      through untouched (unparseable ≠ target envelope).
 *   5. Fast-path identity — when the helper is a no-op, the ORIGINAL
 *      Response reference is returned. A rebuild would strip
 *      `Content-Length` unnecessarily and burn an allocation per
 *      signup forever.
 *   6. Content-Length drop — when the body IS rewritten, the stale
 *      upstream `Content-Length` is dropped so a strict client proxy
 *      doesn't truncate the trailing bytes.
 */

/**
 * Minimal Hono `Context` stub — only `c.req.path` is read by
 * `maybeNormalizeSignupResponse`. Using a narrow fake keeps the tests
 * off the real Hono app (which would require a live Better Auth
 * instance to exercise the catch-all).
 */
function makeSignupCtx(path: string): Context {
  return { req: { path } } as unknown as Context;
}

function jsonResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  const serialized = JSON.stringify(body);
  const headers = new Headers({ "content-type": "application/json", ...init?.headers });
  return new Response(serialized, { status: init?.status ?? 200, headers });
}

describe("maybeNormalizeSignupResponse — scope guards", () => {
  it("returns the upstream Response ref unchanged for non-signup paths", async () => {
    // A future refactor that broadens the wrapper's scope (e.g. moved
    // into a catch-all middleware without path scoping) would fail
    // this test because `/sign-in/email` bodies would start getting
    // rewritten with fabricated `image: null` fields.
    const upstream = jsonResponse({ user: { email: "a@example.com" } });
    const result = await maybeNormalizeSignupResponse(
      makeSignupCtx("/api/auth/sign-in/email"),
      upstream,
    );
    expect(result).toBe(upstream);
  });

  it("does not match a sub-path that tail-ends with /sign-up/email", async () => {
    // Strict `===` equality (not `endsWith`) keeps a plugin-registered
    // path like `/api/auth/plugin/sign-up/email` out of the rewrite
    // branch. Better Auth would 404 such a path today and the 2xx
    // guard would catch it anyway — but the explicit match pins the
    // scope contract so a future Better Auth route-registration bug
    // can't silently reopen the rewrite on a sibling path.
    const upstream = jsonResponse({ user: { email: "a@example.com" } });
    const result = await maybeNormalizeSignupResponse(
      makeSignupCtx("/api/auth/plugin/sign-up/email"),
      upstream,
    );
    expect(result).toBe(upstream);
  });

  it("returns the upstream Response ref unchanged for non-2xx signup status", async () => {
    // Better Auth's error envelopes (422 USER_ALREADY_EXISTS, 429
    // RATE_LIMITED, 400 VALIDATION) have a different schema — rewriting
    // them could corrupt legitimate `error`/`code` fields and mask
    // operator-visible failure modes. The synthetic 200 envelope is
    // the only one we're trying to match shapes with.
    const upstream = jsonResponse({ user: { email: "a@example.com" } }, { status: 422 });
    const result = await maybeNormalizeSignupResponse(
      makeSignupCtx("/api/auth/sign-up/email"),
      upstream,
    );
    expect(result).toBe(upstream);
  });

  it("returns the upstream Response ref unchanged for non-JSON content-type", async () => {
    // A redirect-to-verification-URL implementation (text/html body)
    // would otherwise get text passed through JSON.parse and trip the
    // parse-failure guard — which is fine, but short-circuiting at the
    // content-type check saves a clone+text+parse cycle.
    const upstream = new Response("<html>...</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    const result = await maybeNormalizeSignupResponse(
      makeSignupCtx("/api/auth/sign-up/email"),
      upstream,
    );
    expect(result).toBe(upstream);
  });

  it("returns the upstream Response ref unchanged when JSON body fails to parse", async () => {
    // Defensive: if Better Auth ever returns a malformed body with the
    // JSON content-type, the normalizer can't run — but the body can't
    // be our target envelope either, so pass-through is safe. The warn
    // log (not asserted here) exists for operator visibility.
    const upstream = new Response("{not json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const result = await maybeNormalizeSignupResponse(
      makeSignupCtx("/api/auth/sign-up/email"),
      upstream,
    );
    expect(result).toBe(upstream);
  });

  it("returns the upstream Response ref unchanged when body already has every parity key", async () => {
    // The fast-path: the synthetic existing-email envelope already
    // materializes all parity keys (`image`/`banExpires`/`banReason` — the
    // latter two moved to user.additionalFields in #3159). When all are
    // present the pure helper returns the same reference and the wrapper must
    // return the ORIGINAL `upstream` Response — not a rebuilt one — so we don't
    // strip `Content-Length` or allocate on the hot path.
    const upstream = jsonResponse({
      user: { id: "u1", email: "a@example.com", image: null, banExpires: null, banReason: null },
    });
    const result = await maybeNormalizeSignupResponse(
      makeSignupCtx("/api/auth/sign-up/email"),
      upstream,
    );
    expect(result).toBe(upstream);
  });
});

describe("maybeNormalizeSignupResponse — rewrite path", () => {
  it("rewrites the body to include image / banExpires / banReason: null when absent", async () => {
    const upstream = jsonResponse({
      user: { id: "u1", email: "a@example.com", name: "A", emailVerified: false },
    });
    const result = await maybeNormalizeSignupResponse(
      makeSignupCtx("/api/auth/sign-up/email"),
      upstream,
    );
    expect(result).not.toBe(upstream);
    expect(result.status).toBe(200);

    const parsed = (await result.json()) as { user: Record<string, unknown> };
    expect(parsed.user.image).toBeNull();
    expect(parsed.user.banExpires).toBeNull(); // #3159 parity key
    expect(parsed.user.banReason).toBeNull(); // #3159 parity key
    // Every sibling field survives the rewrite.
    expect(parsed.user.id).toBe("u1");
    expect(parsed.user.email).toBe("a@example.com");
    expect(parsed.user.name).toBe("A");
    expect(parsed.user.emailVerified).toBe(false);
  });

  it("drops stale Content-Length from the upstream headers on rewrite", async () => {
    // The rewritten body is strictly longer than the upstream (it gains the
    // missing parity keys — `image`/`banExpires`/`banReason`: null). If the
    // original Content-Length is carried over, a strict HTTP client would
    // truncate the trailing bytes and a parity key might not even make it to
    // the wire — silently reopening the oracle. Drop the header so the runtime
    // recomputes on send.
    const upstream = jsonResponse(
      { user: { id: "u1", email: "a@example.com" } },
      { headers: { "content-length": "42" } },
    );
    const result = await maybeNormalizeSignupResponse(
      makeSignupCtx("/api/auth/sign-up/email"),
      upstream,
    );
    expect(result.headers.get("content-length")).toBeNull();
  });

  it("preserves non-Content-Length upstream headers on rewrite", async () => {
    // Set-Cookie carries Better Auth's verification-email session, and
    // any `Vary` / cache-control signaling must survive the rewrite.
    // A header copy bug here would break email verification flow.
    const upstream = jsonResponse(
      { user: { id: "u1", email: "a@example.com" } },
      {
        headers: {
          "set-cookie": "atlas-session=abc; HttpOnly; SameSite=Lax",
          "vary": "Origin",
          "cache-control": "no-store",
        },
      },
    );
    const result = await maybeNormalizeSignupResponse(
      makeSignupCtx("/api/auth/sign-up/email"),
      upstream,
    );
    expect(result.headers.get("set-cookie")).toContain("atlas-session=abc");
    expect(result.headers.get("vary")).toBe("Origin");
    expect(result.headers.get("cache-control")).toBe("no-store");
  });

  it("handles application/json; charset=utf-8 content-type", async () => {
    // Better Auth sends `application/json` with explicit charset in
    // some code paths. The `includes("application/json")` check has
    // to survive that — a stricter `===` would regress to pass-through
    // and skip the rewrite.
    const upstream = new Response(
      JSON.stringify({ user: { id: "u1", email: "a@example.com" } }),
      { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
    );
    const result = await maybeNormalizeSignupResponse(
      makeSignupCtx("/api/auth/sign-up/email"),
      upstream,
    );
    expect(result).not.toBe(upstream);
    const parsed = (await result.json()) as { user: Record<string, unknown> };
    expect(parsed.user.image).toBeNull();
  });
});
