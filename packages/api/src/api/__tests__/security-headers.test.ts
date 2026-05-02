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

    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBeTruthy();
  });

  it("OPTIONS preflight to /api/v1/chat carries security headers", async () => {
    // CORS middleware short-circuits OPTIONS via c.body(null, 204). Security
    // headers must run BEFORE CORS so preflight responses are also hardened.
    const res = await app.fetch(
      new Request("http://localhost/api/v1/chat", {
        method: "OPTIONS",
        headers: {
          Origin: "http://example.com",
          "Access-Control-Request-Method": "POST",
        },
      }),
    );

    expect(res.headers.get("Strict-Transport-Security")).toBeTruthy();
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("/widget/atlas-widget.js retains permissive framing — no X-Frame-Options DENY, no global CSP", async () => {
    // Widget routes set their own CSP (frame-ancestors *) for cross-origin
    // iframe embedding. Global X-Frame-Options DENY would break embeds.
    const res = await app.fetch(
      new Request("http://localhost/widget/atlas-widget.js", { method: "GET" }),
    );

    expect(res.headers.get("X-Frame-Options")).toBeNull();

    // Widget JS asset itself does not set CSP (only the HTML page does).
    // The important invariant is X-Frame-Options absent so embeds work.
    // HSTS + nosniff still apply — they're safe everywhere.
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Strict-Transport-Security")).toBeTruthy();
  });

  it("/widget HTML keeps frame-ancestors * CSP (route-level override)", async () => {
    // The widget HTML page sets Content-Security-Policy: frame-ancestors *
    // explicitly. Global middleware MUST NOT replace it with the strict CSP.
    const res = await app.fetch(
      new Request("http://localhost/widget", { method: "GET" }),
    );

    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors *");
    expect(res.headers.get("X-Frame-Options")).toBeNull();
  });
});
