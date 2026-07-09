/**
 * Unit tests for the Hono auth catch-all route.
 *
 * Tests that non-managed modes return 404, managed mode delegates
 * to Better Auth's fetch handler, and errors return 503.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

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
