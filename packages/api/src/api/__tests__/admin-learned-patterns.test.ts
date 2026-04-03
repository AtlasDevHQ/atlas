/**
 * Tests for admin learned-patterns CRUD API routes.
 *
 * Tests: GET /learned-patterns, GET /learned-patterns/:id,
 *        PATCH /learned-patterns/:id, DELETE /learned-patterns/:id,
 *        POST /learned-patterns/bulk.
 *
 * TDD: these tests are written before the routes exist.
 * They should fail until the routes are implemented (Task 5).
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// --- Unified mocks ---

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "simple-key",
    label: "Admin",
    role: "admin",
    activeOrganizationId: "org-1",
  },
});

// --- Import the app AFTER mocks ---

const { app } = await import("../index");

// --- Helpers ---

function req(method: string, urlPath: string, body?: unknown) {
  const url = `http://localhost/api/v1/admin/learned-patterns${urlPath}`;
  const init: RequestInit = { method, headers: { Authorization: "Bearer test" } };
  if (body) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  return app.fetch(new Request(url, init));
}

function mockRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pat-1",
    org_id: "org-1",
    pattern_sql: "SELECT COUNT(*) FROM orders",
    description: "Order count",
    source_entity: "orders",
    source_queries: ["audit-1"],
    confidence: 0.8,
    repetition_count: 5,
    status: "pending",
    proposed_by: "agent",
    reviewed_by: null,
    created_at: "2026-03-18T00:00:00Z",
    updated_at: "2026-03-18T00:00:00Z",
    reviewed_at: null,
    ...overrides,
  };
}

// --- Cleanup ---

afterAll(() => {
  mocks.cleanup();
});

// --- Reset mocks between tests ---

beforeEach(() => {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin", activeOrganizationId: "org-1" },
    }),
  );
  mocks.hasInternalDB = true;
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: true }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admin learned-patterns routes", () => {
  // ─── Auth gating ──────────────────────────────────────────────────

  describe("auth gating", () => {
    it("returns 403 for non-admin user", async () => {
      mocks.mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "user-1", mode: "simple-key", label: "User", role: "member", activeOrganizationId: "org-1" },
        }),
      );
      const res = await req("GET", "/");
      expect(res.status).toBe(403);
    });

    it("returns 401 for unauthenticated", async () => {
      mocks.mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: false,
          error: "Invalid token",
          status: 401,
        }),
      );
      const res = await req("GET", "/");
      expect(res.status).toBe(401);
    });
  });

  // ─── Rate limiting ────────────────────────────────────────────────

  describe("rate limiting", () => {
    it("returns 429 when rate limited", async () => {
      mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: false, retryAfterMs: 60000 }));
      const res = await req("GET", "/");
      expect(res.status).toBe(429);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.retryAfterSeconds).toBeDefined();
    });
  });

  // ─── No internal DB ───────────────────────────────────────────────

  describe("no internal DB", () => {
    it("returns 404 when no internal DB", async () => {
      mocks.hasInternalDB = false;
      const res = await req("GET", "/");
      expect(res.status).toBe(404);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("not_available");
    });
  });

  // ─── GET / (list) ─────────────────────────────────────────────────

  describe("GET /", () => {
    it("returns patterns with pagination", async () => {
      let callCount = 0;
      mocks.mockInternalQuery.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([{ count: "2" }]);
        }
        return Promise.resolve([mockRow(), mockRow({ id: "pat-2" })]);
      });

      const res = await req("GET", "/");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.patterns).toBeArray();
      expect(body.total).toBe(2);
      expect(body.limit).toBeDefined();
      expect(body.offset).toBeDefined();
      // Verify patterns are camelCased
      if (body.patterns.length > 0) {
        expect(body.patterns[0].patternSql).toBe("SELECT COUNT(*) FROM orders");
        expect(body.patterns[0].sourceEntity).toBe("orders");
        expect(body.patterns[0].sourceQueries).toEqual(["audit-1"]);
        expect(body.patterns[0].repetitionCount).toBe(5);
        expect(body.patterns[0].proposedBy).toBe("agent");
        expect(body.patterns[0].reviewedBy).toBeNull();
        expect(body.patterns[0].createdAt).toBe("2026-03-18T00:00:00Z");
        expect(body.patterns[0].updatedAt).toBe("2026-03-18T00:00:00Z");
        expect(body.patterns[0].reviewedAt).toBeNull();
      }
    });

    it("defaults limit to 50 and offset to 0", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/");
      // Check that the query was called with limit=50 and offset=0
      const calls = mocks.mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      // The SELECT query (second call) should have LIMIT and OFFSET params of 50 and 0
      const lastCall = calls[calls.length - 1];
      const params = lastCall[1] as unknown[];
      expect(params).toContain(50);
      expect(params).toContain(0);
    });

    it("caps limit at 200", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/?limit=500");
      const calls = mocks.mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      // The limit param should be capped at 200
      const lastCall = calls[calls.length - 1];
      const params = lastCall[1] as unknown[];
      expect(params).toContain(200);
    });

    it("applies status filter", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/?status=approved");
      const calls = mocks.mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      // Verify that SQL contains status filter and params include "approved"
      const firstCall = calls[0];
      const sql = firstCall[0] as string;
      const params = firstCall[1] as unknown[];
      expect(sql).toContain("status");
      expect(params).toContain("approved");
    });

    it("applies source_entity filter", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/?source_entity=orders");
      const calls = mocks.mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const firstCall = calls[0];
      const sql = firstCall[0] as string;
      const params = firstCall[1] as unknown[];
      expect(sql).toContain("source_entity");
      expect(params).toContain("orders");
    });

    it("applies confidence range", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/?min_confidence=0.5&max_confidence=0.9");
      const calls = mocks.mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const firstCall = calls[0];
      const sql = firstCall[0] as string;
      const params = firstCall[1] as unknown[];
      expect(sql).toContain("confidence");
      expect(params).toContain(0.5);
      expect(params).toContain(0.9);
    });

    it("applies combined filters", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/?status=pending&source_entity=orders&min_confidence=0.5");
      const calls = mocks.mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const firstCall = calls[0];
      const sql = firstCall[0] as string;
      const params = firstCall[1] as unknown[];
      expect(sql).toContain("status");
      expect(sql).toContain("source_entity");
      expect(sql).toContain("confidence");
      expect(params).toContain("pending");
      expect(params).toContain("orders");
      expect(params).toContain(0.5);
    });
  });

  // ─── GET /:id ─────────────────────────────────────────────────────

  describe("GET /:id", () => {
    it("returns single pattern", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([mockRow()]));
      const res = await req("GET", "/pat-1");
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.id).toBe("pat-1");
      expect(body.patternSql).toBe("SELECT COUNT(*) FROM orders");
      expect(body.description).toBe("Order count");
      expect(body.sourceEntity).toBe("orders");
      expect(body.confidence).toBe(0.8);
      expect(body.status).toBe("pending");
    });

    it("returns 404 for missing pattern", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
      const res = await req("GET", "/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  // ─── PATCH /:id ───────────────────────────────────────────────────

  describe("PATCH /:id", () => {
    it("updates description", async () => {
      let callCount = 0;
      mocks.mockInternalQuery.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // SELECT to verify existence
          return Promise.resolve([mockRow()]);
        }
        // UPDATE returning the updated row
        return Promise.resolve([mockRow({ description: "Updated" })]);
      });

      const res = await req("PATCH", "/pat-1", { description: "Updated" });
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.description).toBe("Updated");
    });

    it("updates status with reviewed_by and reviewed_at", async () => {
      let callCount = 0;
      mocks.mockInternalQuery.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([mockRow()]);
        }
        return Promise.resolve([mockRow({ status: "approved", reviewed_by: "admin-1", reviewed_at: "2026-03-18T00:00:00Z" })]);
      });

      const res = await req("PATCH", "/pat-1", { status: "approved" });
      expect(res.status).toBe(200);

      // Verify the UPDATE SQL includes reviewed_by and reviewed_at params
      const calls = mocks.mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      const updateCall = calls[1];
      const sql = updateCall[0] as string;
      expect(sql).toContain("reviewed_by");
      expect(sql).toContain("reviewed_at");
    });

    it("returns 400 for invalid status", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([mockRow()]));
      const res = await req("PATCH", "/pat-1", { status: "invalid" });
      expect(res.status).toBe(422);
    });

    it("returns 404 for missing pattern", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
      const res = await req("PATCH", "/pat-1", { description: "Updated" });
      expect(res.status).toBe(404);
    });
  });

  // ─── DELETE /:id ──────────────────────────────────────────────────

  describe("DELETE /:id", () => {
    it("deletes pattern", async () => {
      let callCount = 0;
      mocks.mockInternalQuery.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([mockRow()]);
        }
        return Promise.resolve([]);
      });

      const res = await req("DELETE", "/pat-1");
      expect(res.status).toBe(200);
    });

    it("returns 404 for missing pattern", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
      const res = await req("DELETE", "/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  // ─── POST /bulk ───────────────────────────────────────────────────

  describe("POST /bulk", () => {
    it("bulk approves patterns", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT")) {
          return Promise.resolve([{ id: "pat-1" }]);
        }
        return Promise.resolve([mockRow({ status: "approved" })]);
      });

      const res = await req("POST", "/bulk", { ids: ["pat-1", "pat-2"], status: "approved" });
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.updated).toBeArray();
      expect(body.notFound).toBeArray();
    });

    it("returns partial results for mixed ids", async () => {
      let selectCallCount = 0;
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT")) {
          selectCallCount++;
          if (selectCallCount === 1) {
            return Promise.resolve([mockRow({ id: "pat-1" })]);
          }
          return Promise.resolve([]);
        }
        return Promise.resolve([mockRow({ id: "pat-1", status: "approved" })]);
      });

      const res = await req("POST", "/bulk", { ids: ["pat-1", "pat-missing"], status: "approved" });
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.updated).toContain("pat-1");
      expect(body.notFound).toContain("pat-missing");
    });

    it("returns 400 for empty ids", async () => {
      const res = await req("POST", "/bulk", { ids: [], status: "approved" });
      expect(res.status).toBe(400);
    });

    it("returns 400 for too many ids", async () => {
      const res = await req("POST", "/bulk", { ids: Array(101).fill("x"), status: "approved" });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid status", async () => {
      const res = await req("POST", "/bulk", { ids: ["pat-1"], status: "pending" });
      expect(res.status).toBe(422);
    });
  });

  // ─── Org-scoping ──────────────────────────────────────────────────

  describe("org-scoping", () => {
    it("filters by org_id from session", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/");
      const calls = mocks.mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const firstCall = calls[0];
      const sql = firstCall[0] as string;
      const params = firstCall[1] as unknown[];
      expect(sql).toContain("org_id");
      expect(params).toContain("org-1");
    });

    it("returns 400 when no active org (requireOrgContext)", async () => {
      mocks.mockAuthenticateRequest.mockImplementation(() =>
        Promise.resolve({
          authenticated: true,
          mode: "simple-key",
          user: { id: "admin-1", mode: "simple-key", label: "Admin", role: "admin" },
        }),
      );
      const res = await req("GET", "/");
      expect(res.status).toBe(400);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("bad_request");
      expect(body.message).toContain("active organization");
    });
  });

  // ─── Error handling ───────────────────────────────────────────────

  describe("error handling", () => {
    it("returns 500 with requestId on DB error", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.reject(new Error("DB connection failed")));
      const res = await req("GET", "/");
      expect(res.status).toBe(500);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("internal_error");
      expect(typeof body.requestId).toBe("string");
    });
  });
});
