/**
 * Unit tests for the security-headers middleware on the Hono API app.
 *
 * Per issue #1984 — auth-bearing surfaces (api.useatlas.dev) need HSTS,
 * CSP, X-Frame-Options, X-Content-Type-Options. Widget routes (/widget*)
 * are intentionally framable, so they MUST NOT receive X-Frame-Options
 * DENY and they retain their per-route `frame-ancestors *` CSP.
 */

import { describe, it, expect, mock } from "bun:test";
import { createConnectionMock } from "../../__mocks__/connection";

// --- Mocks (matching cors.test.ts shape) ---

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve({ authenticated: true, mode: "none", user: undefined }),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: () =>
    Promise.resolve({
      toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }),
      text: Promise.resolve(""),
    }),
}));

mock.module("@atlas/api/lib/startup", () => ({
  validateEnvironment: () => Promise.resolve([]),
  getStartupWarnings: () => [],
}));

mock.module("@atlas/api/lib/semantic", () => ({
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

mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({ resolveDatasourceUrl: () => "postgresql://mock:5432/test" }),
);

mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  explore: { type: "function" },
  invalidateExploreBackend: mock(() => {}),
  markNsjailFailed: mock(() => {}),
  markSidecarFailed: mock(() => {}),
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "none",
  resetAuthModeCache: () => {},
}));

mock.module("@atlas/api/lib/settings", () => ({
  getSetting: () => undefined,
  getSettingAuto: () => undefined,
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

const { app } = await import("../index");

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

  it("/widget HTML route returns 200 and keeps frame-ancestors * CSP", async () => {
    const res = await app.fetch(
      new Request("http://localhost/widget", { method: "GET" }),
    );

    // Status assertion proves the route actually matched (not a 404 fallthrough).
    expect(res.status).toBe(200);
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
