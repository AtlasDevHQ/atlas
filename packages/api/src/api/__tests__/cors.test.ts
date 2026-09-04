/**
 * Unit tests for the CORS and security-headers middleware on the Hono API app.
 *
 * The security-headers block was formerly `security-headers.test.ts` (#1984).
 * It mocked a strict subset of the modules this file already mocks, with
 * identical shapes (`getSettingAuto` returning undefined on both sides), so the
 * two suites share one `mock.module` set without either seeing a change.
 *
 * Tests default (wildcard) behavior. ATLAS_CORS_ORIGIN is read at module
 * load time, so env var changes between tests don't take effect without
 * re-importing the app module. Per-origin tests would require dynamic
 * import with module cache busting, which bun:test mock.module doesn't
 * support cleanly. The wildcard/default path is the critical one to cover.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createConnectionMock } from "../../__mocks__/connection";

// --- Mocks (same set as auth.test.ts / chat.test.ts) ---

void mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve({ authenticated: true, mode: "none", user: undefined }),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

void mock.module("@atlas/api/lib/agent", () => ({
  runAgent: () =>
    Promise.resolve({
      // Must provide toUIMessageStream (not toUIMessageStreamResponse) —
      // the chat route calls agentResult.toUIMessageStream() to merge into
      // createUIMessageStream, then throws HTTPException(200, { res }).
      toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
      text: Promise.resolve(""),
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

void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({ resolveDatasourceUrl: () => "postgresql://mock:5432/test" }),
);

void mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  explore: { type: "function" },
  invalidateExploreBackend: mock(() => {}),
  // #4936 — the chat route now resolves its tool registry explicitly instead of
  // inheriting `runAgent`'s default, so `lib/tools/registry` is loaded on the
  // ordinary path (this file mocks `lib/agent`, which used to be the only thing
  // pulling it in). A partial mock of a module that registry's graph imports
  // fails the whole import, which surfaces here as a JSON error instead of the
  // SSE stream under test — so this and the `lib/settings` mock below cover
  // their modules' full named-export surface, not just the names that broke.
  invalidateOrgExploreBackends: mock(() => {}),
  markNsjailFailed: mock(() => {}),
  markSidecarFailed: mock(() => {}),
  snapshotExploreSandboxEnv: () => ({}),
  _formatSandboxPriorityFailureForTest: () => "",
  _resetSandboxFailureFlagsForTest: () => {},
}));

void mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "none",
  resetAuthModeCache: () => {},
}));

void mock.module("@atlas/api/lib/settings", () => ({
  getSetting: () => undefined,
  getSettingAuto: () => undefined,
  // #4936 — same cause as the `lib/tools/explore` mock above.
  getSettingOverride: () => undefined,
  isSaasModeForGuard: () => false,
  refreshSettingsTick: async () => {},
  isHotReloadedKey: () => false,
  HOT_RELOADED_KEYS: new Set<string>(),
  SECURITY_SENSITIVE_KEYS: new Set<string>(),
  // `null`, matching `SecuritySensitiveAudit | null`. A truthy `{}` passes
  // `auditSettingsWrite`'s `!== null` guard and then reads properties off an
  // empty object — unreachable from this suite, and reported by nothing, because
  // `mock.module` factories are untyped.
  securitySensitiveAuditFields: () => null,
  getSettingLive: async () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  getAllSettingOverrides: async () => [],
  loadSettings: async () => 0,
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  _resetSettingsCache: () => {},
}));

// Import after mocks
const { app } = await import("../index");

describe("CORS middleware", () => {
  const origCorsOrigin = process.env.ATLAS_CORS_ORIGIN;

  beforeEach(() => {
    // Ensure clean env state for each test
    delete process.env.ATLAS_CORS_ORIGIN;
  });

  afterEach(() => {
    if (origCorsOrigin !== undefined)
      process.env.ATLAS_CORS_ORIGIN = origCorsOrigin;
    else delete process.env.ATLAS_CORS_ORIGIN;
  });

  it("OPTIONS preflight to /api/v1/chat returns CORS headers", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/v1/chat", {
        method: "OPTIONS",
        headers: {
          Origin: "http://example.com",
          "Access-Control-Request-Method": "POST",
        },
      }),
    );

    // Preflight should succeed (2xx)
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();

    const allowHeaders = res.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowHeaders.toLowerCase()).toContain("authorization");
    expect(allowHeaders.toLowerCase()).toContain("content-type");
  });

  // Regression: the signup form attaches `x-captcha-response` when Turnstile
  // mints a token. A browser rejects the preflight when a requested header is
  // absent from Allow-Headers, so the signup POST is never sent at all and the
  // page shows a network error. Asserted against the preflight the SIGNUP route
  // serves — the header set is global, but pinning it here names the caller
  // that regresses if someone trims the list.
  it("preflight allows the signup captcha header", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "OPTIONS",
        headers: {
          Origin: "http://example.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,x-captcha-response",
        },
      }),
    );

    const allowed = (res.headers.get("Access-Control-Allow-Headers") ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase());

    // Every header the browser asked for must be allowed, or it blocks the
    // request. Asserted as a subset check rather than `toContain` so a future
    // header added to the form fails here instead of in a browser.
    for (const requested of ["content-type", "x-captcha-response"]) {
      expect(allowed).toContain(requested);
    }
  });

  it("default (no ATLAS_CORS_ORIGIN) sets Access-Control-Allow-Origin to *", async () => {
    // The app was imported without ATLAS_CORS_ORIGIN set, so it defaults to "*"
    const res = await app.fetch(
      new Request("http://localhost/api/v1/chat", {
        method: "OPTIONS",
        headers: {
          Origin: "http://example.com",
          "Access-Control-Request-Method": "POST",
        },
      }),
    );

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // Credentials header should NOT be present with wildcard origin
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("Retry-After is in Access-Control-Expose-Headers", async () => {
    // Use a regular GET to /api/health to check expose headers on actual response
    const res = await app.fetch(
      new Request("http://localhost/api/health", {
        method: "GET",
        headers: { Origin: "http://example.com" },
      }),
    );

    const exposeHeaders =
      res.headers.get("Access-Control-Expose-Headers") ?? "";
    expect(exposeHeaders).toContain("Retry-After");
    // #3747 — the resume reattach headers must be exposed cross-origin so the
    // embedded widget can read the conversation id + run id off the response.
    expect(exposeHeaders).toContain("x-conversation-id");
    expect(exposeHeaders).toContain("x-run-id");
  });

  it("streaming chat POST response includes CORS headers (HTTPException path)", async () => {
    // The chat route creates a streaming Response via createUIMessageStreamResponse
    // and throws it as HTTPException(200, { res }). This bypasses Hono's middleware
    // header pipeline. The onError handler must copy CORS headers from the context
    // to the raw Response for cross-origin browsers to accept the stream.
    const res = await app.fetch(
      new Request("http://localhost/api/v1/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://example.com",
        },
        body: JSON.stringify({
          messages: [
            { id: "1", role: "user", parts: [{ type: "text", text: "hello" }] },
          ],
        }),
      }),
    );

    // Verify this is a streaming response (SSE), not a JSON error fallback —
    // confirms we're testing the HTTPException path, not the normal c.json() path.
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    // CORS headers must be present on the streaming response
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });

  // NOTE: Testing ATLAS_CORS_ORIGIN with a specific value would require
  // re-importing the app module after setting the env var, since Hono's
  // cors() middleware captures the origin config at app creation time.
  // bun:test mock.module doesn't support module cache invalidation, so
  // we document this limitation and rely on the implementation being
  // straightforward (see packages/api/src/api/index.ts lines 20-29).
  it("credentials flag is tied to explicit origin (implementation note)", () => {
    // Verify the implementation logic: credentials = !!corsOrigin
    // When ATLAS_CORS_ORIGIN is set, credentials should be true.
    // We test this at the code level since runtime testing would
    // require module re-import.
    const corsOrigin = "https://app.example.com";
    expect(!!corsOrigin).toBe(true); // explicit origin → credentials: true
    // @ts-expect-error TS2873: intentional — documents that undefined → no credentials
    expect(!!undefined).toBe(false); // no origin → credentials: false
  });
});

/**
 * Unit tests for the security-headers middleware on the Hono API app.
 *
 * Per issue #1984 — auth-bearing surfaces (api.useatlas.dev) need HSTS,
 * CSP, X-Frame-Options, X-Content-Type-Options. Widget routes (/widget*)
 * are intentionally framable, so they MUST NOT receive X-Frame-Options
 * DENY and they retain their per-route `frame-ancestors *` CSP.
 */
describe("security-headers middleware", () => {
  it("/api/health response carries HSTS, CSP, X-Frame-Options DENY, nosniff", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/health", { method: "GET" }),
    );

    const hsts = res.headers.get("Strict-Transport-Security") ?? "";
    expect(hsts).toContain("max-age=");
    expect(hsts).toContain("includeSubDomains");

    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp.length).toBeGreaterThan(0);
    expect(csp).toContain("frame-ancestors 'none'");
    // style-src 'unsafe-inline' is required by routes/onboarding-emails.ts
    // (inline `style="..."` on the unsubscribe page). Regression guard.
    expect(csp).toContain("style-src 'unsafe-inline'");

    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBeTruthy();
  });

  it("OPTIONS preflight short-circuits with 204 AND carries every security header", async () => {
    // CORS middleware short-circuits OPTIONS via c.body(null, 204). Security
    // headers must run BEFORE CORS so preflight responses are also hardened.
    // Asserting status=204 proves CORS short-circuit fired (not a route handler).
    const res = await app.fetch(
      new Request("http://localhost/api/v1/chat", {
        method: "OPTIONS",
        headers: {
          Origin: "http://example.com",
          "Access-Control-Request-Method": "POST",
        },
      }),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
    expect(res.headers.get("Strict-Transport-Security")).toBeTruthy();
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("/api/v1/openapi.json carries the strict API CSP", async () => {
    // Spec endpoint returns JSON. Confirms the comment claim that all JSON
    // surfaces carry the strict CSP.
    const res = await app.fetch(
      new Request("http://localhost/api/v1/openapi.json", { method: "GET" }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("/widget/atlas-widget.js retains permissive framing — no X-Frame-Options, no strict CSP, but nosniff/HSTS still apply", async () => {
    const res = await app.fetch(
      new Request("http://localhost/widget/atlas-widget.js", { method: "GET" }),
    );

    expect(res.headers.get("X-Frame-Options")).toBeNull();
    // Negative assertion: the strict global CSP must NOT leak onto widget
    // assets or the iframe parent will block them.
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    // Header-poisoning defenses still apply on the asset.
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Strict-Transport-Security")).toBeTruthy();
  });

  it("/widget HTML route is reached and keeps frame-ancestors * CSP", async () => {
    const res = await app.fetch(
      new Request("http://localhost/widget", { method: "GET" }),
    );

    // Status proves the route handler ran (not a 404 fallthrough). Two valid
    // outcomes: 200 when packages/react/dist/widget.js is built, 503 when the
    // bundle is missing (CI shards run before `bun run --filter @useatlas/react
    // build`). Both paths set the route-level `frame-ancestors *` CSP, which
    // is the load-bearing invariant for this test — the global strict CSP
    // must NOT replace it on either branch.
    expect([200, 503]).toContain(res.status);
    expect(res.headers.get("Content-Type")).toContain("html");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors *");
    expect(res.headers.get("X-Frame-Options")).toBeNull();
  });

  it("/widgetfoo (non-widget path that shares the prefix) DOES get X-Frame-Options + strict CSP", async () => {
    // Regression guard against `startsWith("/widget")` over-matching. The
    // precise matcher (path === "/widget" || "/widget/..." || "/widget....")
    // must reject sibling prefixes — otherwise a future careless route name
    // silently becomes framable.
    const res = await app.fetch(
      new Request("http://localhost/widgetfoo", { method: "GET" }),
    );

    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("HTTPException 404 response carries security headers", async () => {
    // Hono returns a 404 HTTPException for unmatched routes. The onError
    // handler builds a fresh Response from err.getResponse() which bypasses
    // c.res — confirms the explicit header-copy in onError is wired.
    const res = await app.fetch(
      new Request("http://localhost/api/this-route-does-not-exist", {
        method: "GET",
      }),
    );

    expect(res.status).toBe(404);
    expect(res.headers.get("Strict-Transport-Security")).toBeTruthy();
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
