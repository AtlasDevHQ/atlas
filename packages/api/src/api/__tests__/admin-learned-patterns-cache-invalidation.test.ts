/**
 * Regression tests for learned-pattern cache invalidation (#3612).
 *
 * The in-memory approved-pattern cache (5-min TTL, `lib/learn/pattern-cache.ts`)
 * was only invalidated by the DELETE handler. The PATCH single approve/reject
 * handler and the POST /bulk approve handler changed `status` to
 * approved/rejected without invalidating, so the agent served stale patterns
 * for up to 5 minutes — approvals looked broken.
 *
 * These tests assert the route handlers call `invalidatePatternCache(orgId)`
 * after the DB write for any PATCH status flip (approve, reject, or un-approve
 * back to pending — each changes the `status = 'approved'` set) and for bulk
 * approve, while description-only PATCH and no-op bulk do not.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
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

// Override the pattern-cache mock with a spy on invalidatePatternCache so we
// can assert the route wiring. Registered before importing the app so the
// route picks up the spy (later mock.module wins). All named exports mocked.
const invalidatePatternCache = mock((_orgId: string | null) => {});
void mock.module("@atlas/api/lib/learn/pattern-cache", () => ({
  buildLearnedPatternsSection: async () => "",
  getRelevantPatterns: async () => [],
  buildRetrievalQuery: () => "",
  getRetrievalTurns: () => 3,
  getConfidenceThreshold: () => 0.7,
  invalidatePatternCache,
  extractKeywords: () => new Set(),
  _resetPatternCache: () => {},
  DEFAULT_RETRIEVAL_TURNS: 3,
}));

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
    type: "query_pattern",
    amendment_payload: null,
    connection_group_id: null,
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
  invalidatePatternCache.mockClear();
});

describe("learned-pattern cache invalidation (#3612)", () => {
  it("PATCH approve invalidates the org cache after the DB write", async () => {
    let callCount = 0;
    mocks.mockInternalQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([mockRow()]); // existence SELECT
      return Promise.resolve([mockRow({ status: "approved", reviewed_by: "admin-1", reviewed_at: "2026-03-18T00:00:00Z" })]);
    });

    const res = await req("PATCH", "/pat-1", { status: "approved" });
    expect(res.status).toBe(200);
    expect(invalidatePatternCache).toHaveBeenCalledTimes(1);
    expect(invalidatePatternCache).toHaveBeenCalledWith("org-1");
  });

  it("PATCH reject also invalidates the org cache (rejected pattern evicted from approved set)", async () => {
    let callCount = 0;
    mocks.mockInternalQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([mockRow({ status: "approved" })]);
      return Promise.resolve([mockRow({ status: "rejected", reviewed_by: "admin-1", reviewed_at: "2026-03-18T00:00:00Z" })]);
    });

    const res = await req("PATCH", "/pat-1", { status: "rejected" });
    expect(res.status).toBe(200);
    expect(invalidatePatternCache).toHaveBeenCalledTimes(1);
    expect(invalidatePatternCache).toHaveBeenCalledWith("org-1");
  });

  it("PATCH un-approve (approved → pending) also invalidates (pattern leaves approved set)", async () => {
    let callCount = 0;
    mocks.mockInternalQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([mockRow({ status: "approved" })]);
      return Promise.resolve([mockRow({ status: "pending", reviewed_by: "admin-1", reviewed_at: "2026-03-18T00:00:00Z" })]);
    });

    const res = await req("PATCH", "/pat-1", { status: "pending" });
    expect(res.status).toBe(200);
    expect(invalidatePatternCache).toHaveBeenCalledTimes(1);
    expect(invalidatePatternCache).toHaveBeenCalledWith("org-1");
  });

  it("PATCH description-only update does NOT invalidate (no approved-set change)", async () => {
    let callCount = 0;
    mocks.mockInternalQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([mockRow()]);
      return Promise.resolve([mockRow({ description: "Updated" })]);
    });

    const res = await req("PATCH", "/pat-1", { description: "Updated" });
    expect(res.status).toBe(200);
    expect(invalidatePatternCache).not.toHaveBeenCalled();
  });

  it("bulk approve invalidates the org cache after the DB write", async () => {
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) return Promise.resolve([{ id: "pat-1", type: "query_pattern" }]);
      return Promise.resolve([mockRow({ status: "approved" })]);
    });

    const res = await req("POST", "/bulk", { ids: ["pat-1", "pat-2"], status: "approved" });
    expect(res.status).toBe(200);
    expect(invalidatePatternCache).toHaveBeenCalledWith("org-1");
  });

  it("bulk does NOT invalidate when no rows were updated", async () => {
    // Every SELECT returns empty → all ids not found, nothing updated.
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));

    const res = await req("POST", "/bulk", { ids: ["missing-1", "missing-2"], status: "approved" });
    expect(res.status).toBe(200);
    expect(invalidatePatternCache).not.toHaveBeenCalled();
  });
});
