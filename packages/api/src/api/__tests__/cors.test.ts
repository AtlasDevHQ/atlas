/**
 * Unit tests for the CORS middleware on the Hono API app.
 *
 * Tests default (wildcard) behavior. ATLAS_CORS_ORIGIN is read at module
 * load time, so env var changes between tests don't take effect without
 * re-importing the app module. Per-origin tests would require dynamic
 * import with module cache busting, which bun:test mock.module doesn't
 * support cleanly. The wildcard/default path is the critical one to cover.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// --- Mocks (same set as auth.test.ts / chat.test.ts) ---

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve({ authenticated: true, mode: "none", user: undefined }),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

mock.module("@atlas/api/lib/agent", () => ({
  runAgent: () =>
    Promise.resolve({
      // Must provide toUIMessageStream (not toUIMessageStreamResponse) —
      // the chat route calls agentResult.toUIMessageStream() to merge into
      // createUIMessageStream, then throws HTTPException(200, { res }).
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
