/**
 * CORS tests for explicit origin matching and non-matching origins (#1089 gap 4).
 *
 * The default cors.test.ts only tests the wildcard (*) path because
 * getSettingAuto is mocked to return undefined. This file mocks
 * getSettingAuto to return an explicit origin so we can test:
 * - Matching origin → Access-Control-Allow-Origin + Credentials
 * - Non-matching origin → No CORS headers set
 */

import { describe, it, expect, mock } from "bun:test";

// --- Mocks (same set as cors.test.ts, but with explicit CORS origin) ---

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve({ authenticated: true, mode: "none", user: undefined }),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: () =>
    Promise.resolve({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
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

mock.module("@atlas/api/lib/tools/explore", () => ({
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => "none",
  resetAuthModeCache: () => {},
}));

// Return explicit origin from getSettingAuto for CORS
mock.module("@atlas/api/lib/settings", () => ({
  getSetting: () => undefined,
  getSettingAuto: (key: string) => {
    if (key === "ATLAS_CORS_ORIGIN") return "https://app.example.com";
    return undefined;
  },
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

describe("CORS explicit origin matching", () => {
  it("matching origin sets Access-Control-Allow-Origin and Credentials", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/v1/chat", {
        method: "OPTIONS",
        headers: {
          Origin: "https://app.example.com",
          "Access-Control-Request-Method": "POST",
        },
      }),
    );

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("non-matching origin does not set Access-Control-Allow-Origin", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/v1/chat", {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.com",
          "Access-Control-Request-Method": "POST",
        },
      }),
    );

    // Non-matching origin: the middleware still responds to OPTIONS (204)
    // but should NOT have set the Allow-Origin header to the evil origin
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    // And no credentials header
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("matching origin on regular request also sets Credentials", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/health", {
        method: "GET",
        headers: {
          Origin: "https://app.example.com",
        },
      }),
    );

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });
});
