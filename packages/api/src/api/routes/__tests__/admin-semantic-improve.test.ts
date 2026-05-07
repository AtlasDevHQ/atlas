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

  describe("GET /health — DB vs disk source selection", () => {
    // Pin the load-bearing branch: when there's an org context + internal
    // DB the endpoint must read from `loadEntitiesFromDB`. A refactor that
    // flips back to disk would silently restore the conflation that made
    // empty-DB SaaS workspaces show "13 entities, 100% coverage".
    let dbCalls = 0;
    let diskCalls = 0;
    beforeEach(() => {
      dbCalls = 0;
      diskCalls = 0;
      mock.module("@atlas/api/lib/semantic/expert/context-loader", () => ({
        loadEntitiesFromDB: async () => {
          dbCalls++;
          return { entities: [], totalRows: 0, parseFailures: 0 };
        },
        loadEntitiesFromDisk: async () => {
          diskCalls++;
          return [];
        },
        loadGlossaryFromDisk: async () => [],
      }));
      mock.module("@atlas/api/lib/semantic/expert/health", () => ({
        computeSemanticHealth: () => ({
          overall: 0,
          coverage: 0,
          descriptionQuality: 0,
          measureCoverage: 0,
          joinCoverage: 0,
          entityCount: 0,
          dimensionCount: 0,
          measureCount: 0,
          glossaryTermCount: 0,
        }),
      }));
    });

    it("prefers loadEntitiesFromDB when org context + internal DB present", async () => {
      mockHasInternalDB = true;
      const res = await adminSemanticImprove.request("/health");
      expect(res.status).toBe(200);
      expect(dbCalls).toBe(1);
      expect(diskCalls).toBe(0);
    });

    // Note: the disk-fallback branch (`!orgId || !hasInternalDB()`) requires
    // routing past requireOrgContext which itself depends on the internal
    // DB — exercising that path needs deeper middleware mocking than this
    // suite carries. The branch is small enough that the type system + the
    // single conditional in admin-semantic-improve.ts:923 keeps it honest;
    // the load-bearing assertion is "DB wins when both are present", above.

    it("response includes a status discriminator distinguishing empty from corrupt", async () => {
      mockHasInternalDB = true;
      // Override loader to return totalRows=2, parseFailures=2 (full corruption)
      mock.module("@atlas/api/lib/semantic/expert/context-loader", () => ({
        loadEntitiesFromDB: async () => ({ entities: [], totalRows: 2, parseFailures: 2 }),
        loadEntitiesFromDisk: async () => [],
        loadGlossaryFromDisk: async () => [],
      }));
      const res = await adminSemanticImprove.request("/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; parseFailures: number; totalRows: number };
      expect(body.status).toBe("corrupt");
      expect(body.parseFailures).toBe(2);
      expect(body.totalRows).toBe(2);
    });
  });
});
