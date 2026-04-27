/**
 * Tests for admin semantic improve routes.
 *
 * Tests the session management and proposal approval/rejection endpoints.
 * The streaming chat endpoint requires a full agent mock and is covered
 * by browser tests.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

let mockHasInternalDB = true;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockHasInternalDB,
  internalQuery: async () => [],
  internalExecute: async () => {},
  setWorkspaceRegion: async () => {},
  insertSemanticAmendment: async () => "mock-amendment-id",
  getPendingAmendmentCount: async () => 0,
}));

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve({
      authenticated: true,
      mode: "managed",
      user: {
        id: "user-1",
        mode: "managed",
        label: "admin@test.dev",
        role: "admin",
        activeOrganizationId: "org-test",
        claims: { twoFactorEnabled: true },
      },
    }),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: () => ({ requestId: "test-req-id" }),
  };
});

mock.module("@atlas/api/lib/effect/hono", () => ({
  runHandler: async (_c: unknown, _label: string, fn: () => unknown) => fn(),
  runEffect: async (_c: unknown, effect: unknown) => effect,
}));

mock.module("@atlas/api/lib/security/abuse", () => ({
  checkAbuseStatus: () => ({ level: "ok" }),
}));

mock.module("@atlas/api/lib/workspace", () => ({
  checkWorkspaceStatus: async () => ({ allowed: true }),
}));

mock.module("@atlas/api/lib/billing/enforcement", () => ({
  checkPlanLimits: async () => ({ allowed: true }),
}));

// Mock the agent and expert registry (not needed for session/proposal tests)
mock.module("@atlas/api/lib/agent", () => ({
  runAgent: async () => ({
    toUIMessageStream: () => new ReadableStream(),
  }),
}));

mock.module("@atlas/api/lib/tools/expert-registry", () => ({
  buildExpertRegistry: () => ({
    getAll: () => ({}),
    freeze: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { adminSemanticImprove } from "../admin-semantic-improve";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admin-semantic-improve", () => {
  beforeEach(() => {
    mockHasInternalDB = true;
  });

  describe("GET /sessions", () => {
    it("returns session list", async () => {
      const res = await adminSemanticImprove.request("/sessions");
      expect(res.status).toBe(200);

      const body = (await res.json()) as { sessions: unknown[] };
      expect(body.sessions).toBeInstanceOf(Array);
    });
  });

  describe("GET /sessions/:id", () => {
    it("returns 404 for non-existent session", async () => {
      const res = await adminSemanticImprove.request(
        "/sessions/00000000-0000-0000-0000-000000000000",
      );
      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
    });
  });

  describe("POST /proposals/:id/approve", () => {
    it("returns 404 when no session exists", async () => {
      const res = await adminSemanticImprove.request("/proposals/0/approve", {
        method: "POST",
      });
      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
    });

    it("returns 400 for non-numeric proposal ID", async () => {
      const res = await adminSemanticImprove.request("/proposals/abc/approve", {
        method: "POST",
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_id");
    });
  });

  describe("POST /proposals/:id/reject", () => {
    it("returns 404 when no session exists", async () => {
      const res = await adminSemanticImprove.request("/proposals/0/reject", {
        method: "POST",
      });
      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
    });

    it("returns 400 for non-numeric proposal ID", async () => {
      const res = await adminSemanticImprove.request("/proposals/abc/reject", {
        method: "POST",
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_id");
    });
  });
});
