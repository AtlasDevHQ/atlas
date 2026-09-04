/**
 * Tests for admin learned-patterns CRUD API routes.
 *
 * Tests: GET /learned-patterns, GET /learned-patterns/:id,
 *        PATCH /learned-patterns/:id, DELETE /learned-patterns/:id,
 *        POST /learned-patterns/bulk.
 *
 * TDD: these tests are written before the routes exist.
 * They should fail until the routes are implemented (Task 5).
 *
 * Also hosts the route's regression suites that share this harness (same
 * `createApiTestMocks` shape, disjoint extra module mocks):
 *   - org-scope clause threading (#4580)
 *   - amendment fold-out / query_pattern-only scope (#4569)
 *   - governance audit rows (#4580)
 *   - approved-pattern cache invalidation (#3612)
 * The fail-closed WITHHOLD arm (#4580) needs a different `internal` override
 * and stays in `admin-learned-patterns-fail-closed.test.ts`.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
  type Mock,
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

// The decide seam must never be reached from this route (#4569). Spy on it so a
// regression that re-introduces an amendment decision path here is caught.
const decideAmendment: Mock<(params: unknown) => Promise<unknown>> = mock(async () => ({
  kind: "approved",
  id: "x",
}));

void mock.module("@atlas/api/lib/semantic/expert/decide", () => ({
  decideAmendment,
}));

// Audit capture (#4580 governance parity). Test pattern modeled on
// `admin-prompts-audit.test.ts` (F-35).
interface AuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  scope?: "platform" | "workspace";
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

const mockLogAdminAction: Mock<(entry: AuditEntry) => void> = mock(() => {});

void mock.module("@atlas/api/lib/audit", async () => {
  // Mock every barrel export (docs/development/testing.md "Mock all exports"):
  // spread the real `ADMIN_ACTIONS` + error-scrub helpers so a transitive
  // `import { errorMessage }` never SyntaxErrors at app-load time; only the two
  // write functions are spied.
  const actions = await import("@atlas/api/lib/audit/actions");
  const scrub = await import("@atlas/api/lib/audit/error-scrub");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actions.ADMIN_ACTIONS,
    errorMessage: scrub.errorMessage,
    causeToError: scrub.causeToError,
  };
});

// Override the pattern-cache mock with a spy on invalidatePatternCache so we
// can assert the route wiring (#3612). Registered before importing the app so
// the route picks up the spy (later mock.module wins). All named exports mocked.
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
  if (body !== undefined) {
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

/** Every SQL string the route issued this request. */
function issuedSql(): string[] {
  return mocks.mockInternalQuery.mock.calls.map((c) => c[0] as string);
}

function auditCalls(actionType?: string): AuditEntry[] {
  const all = mockLogAdminAction.mock.calls.map((c) => c[0]!);
  return actionType ? all.filter((e) => e.actionType === actionType) : all;
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
  mockLogAdminAction.mockClear();
  invalidatePatternCache.mockClear();
  decideAmendment.mockReset();
  decideAmendment.mockImplementation(async () => ({ kind: "approved", id: "x" }));
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
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
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
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
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
        // First row carries the INJECTION_COUNT_SELECT subquery result; second
        // omits it, so the fallback-to-0 mapping is exercised too (#4573).
        return Promise.resolve([mockRow({ injection_count: 3 }), mockRow({ id: "pat-2" })]);
      });

      const res = await req("GET", "/");
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
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
        // Per-pattern injection count (#4573): mapped from injection_count, and
        // a row without the subquery reads 0 (never null) — the wire type is a
        // non-negative count.
        expect(body.patterns[0].injectionCount).toBe(3);
        expect(body.patterns[1].injectionCount).toBe(0);
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

    it("selects the per-pattern injection-count subquery (#4573)", async () => {
      // Guards against silently dropping INJECTION_COUNT_SELECT from the SELECT
      // (which would make every cockpit count read 0 with no other failing test).
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/");
      const calls = mocks.mockInternalQuery.mock.calls;
      const selectSql = calls[calls.length - 1][0] as string;
      expect(selectSql).toContain("injection_count");
      expect(selectSql).toContain("learned_pattern_injections");
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

    it("rejects an inverted confidence range (min > max) with 400", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      const res = await req("GET", "/?min_confidence=0.9&max_confidence=0.5");
      expect(res.status).toBe(400);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("bad_request");
    });

    it("applies combined filters", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/?status=pending&source_entity=orders&min_confidence=0.5");
      const calls = mocks.mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const firstCall = calls[0];
      const sql = firstCall[0] as string;
      const params = firstCall[1] as unknown[];
      // Every status (pending included) is a bound param now: the route is
      // query_pattern-only (#4569), so the amendment-only `applying` claim
      // state can never appear here and the pending special-case is gone.
      expect(sql).toContain("status = $");
      expect(sql).toContain("type = 'query_pattern'");
      expect(sql).toContain("source_entity");
      expect(sql).toContain("confidence");
      expect(params).toContain("pending");
      expect(params).toContain("orders");
      expect(params).toContain(0.5);
    });

    // ─── Seen-once tier (#4581) ─────────────────────────────────────

    it("hides seen-once (repetition_count = 1) patterns from the default queue (#4581)", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/");
      const calls = mocks.mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      // Both the COUNT and the SELECT carry the seen-once floor, so `total`
      // reconciles with the rows shown.
      for (const call of calls) {
        expect(call[0] as string).toContain("repetition_count >= 2");
      }
    });

    it("reveals seen-once patterns when include_seen_once=true (#4581)", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/?include_seen_once=true");
      const calls = mocks.mockInternalQuery.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      for (const call of calls) {
        expect(call[0] as string).not.toContain("repetition_count >= 2");
      }
    });

    it("a repeated pattern (repetition_count >= 2) surfaces with its accumulated stats (#4581)", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        // Match the top-level count query specifically — the row SELECT now also
        // contains a `COUNT(*)` in the injection-count subquery (#4573), so a bare
        // `includes("COUNT(*)")` would misroute the SELECT to the count result.
        if (sql.includes("COUNT(*) as count")) return Promise.resolve([{ count: "1" }]);
        return Promise.resolve([mockRow({ id: "repeated", repetition_count: 4, confidence: 0.6 })]);
      });
      const res = await req("GET", "/");
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.total).toBe(1);
      expect(body.patterns[0].id).toBe("repeated");
      expect(body.patterns[0].repetitionCount).toBe(4);
    });

    // ─── Sort (whitelisted) ─────────────────────────────────────────

    it("defaults to newest-first with a deterministic tiebreaker when no sort param", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/");
      const calls = mocks.mockInternalQuery.mock.calls;
      // The SELECT (last call) carries the ORDER BY; the COUNT does not. Assert
      // the FULL clause — the `NULLS LAST` and `id DESC` tiebreaker are
      // load-bearing (deterministic pagination), so a loose substring wouldn't
      // catch their removal.
      const selectSql = calls[calls.length - 1][0] as string;
      expect(selectSql).toContain("ORDER BY created_at DESC NULLS LAST, id DESC");
    });

    it("sorts by a whitelisted field + direction, keeping the tiebreaker", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/?sort=confidence&dir=asc");
      const calls = mocks.mockInternalQuery.mock.calls;
      const selectSql = calls[calls.length - 1][0] as string;
      expect(selectSql).toContain("ORDER BY confidence ASC NULLS LAST, id DESC");
    });

    it("maps each whitelisted sort key to its real column", async () => {
      const cases: Array<[string, string]> = [
        ["repetition", "repetition_count"],
        ["latency", "avg_duration_ms"],
        ["created", "created_at"],
      ];
      for (const [key, column] of cases) {
        mocks.mockInternalQuery.mockReset();
        mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
        await req("GET", `/?sort=${key}&dir=desc`);
        const calls = mocks.mockInternalQuery.mock.calls;
        const selectSql = calls[calls.length - 1][0] as string;
        expect(selectSql).toContain(`ORDER BY ${column} DESC NULLS LAST, id DESC`);
      }
    });

    it("rejects a non-whitelisted sort field with 400 (never interpolated)", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      const res = await req("GET", "/?sort=pattern_sql");
      expect(res.status).toBe(400);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("bad_request");
      // The raw value must not appear in any executed SQL.
      for (const call of mocks.mockInternalQuery.mock.calls) {
        expect(call[0] as string).not.toContain("pattern_sql DESC");
        expect(call[0] as string).not.toContain("pattern_sql ASC");
      }
    });

    it("rejects a SQL-injection sort payload with 400", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      const res = await req("GET", `/?sort=${encodeURIComponent("created; DROP TABLE learned_patterns")}`);
      expect(res.status).toBe(400);
    });

    it("rejects a prototype key as sort (Map.get is pollution-safe)", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      const res = await req("GET", "/?sort=constructor");
      expect(res.status).toBe(400);
    });

    it("rejects a non-whitelisted sort direction with 400", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      const res = await req("GET", "/?sort=confidence&dir=sideways");
      expect(res.status).toBe(400);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("bad_request");
    });
  });

  // ─── GET /:id ─────────────────────────────────────────────────────

  describe("GET /:id", () => {
    it("returns single pattern", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([mockRow({ injection_count: 4 })]));
      const res = await req("GET", "/pat-1");
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.id).toBe("pat-1");
      expect(body.patternSql).toBe("SELECT COUNT(*) FROM orders");
      expect(body.description).toBe("Order count");
      expect(body.sourceEntity).toBe("orders");
      expect(body.confidence).toBe(0.8);
      expect(body.status).toBe("pending");
      // Detail sheet reads injectionCount from this row (#4573).
      expect(body.injectionCount).toBe(4);
      // The single-pattern SELECT includes the injection-count subquery.
      const sql = mocks.mockInternalQuery.mock.calls[0][0] as string;
      expect(sql).toContain("injection_count");
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
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
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
      // RETURNING carries the injection count so the detail sheet's count
      // survives an approve/reject in place, rather than resetting to 0 (#4573).
      expect(sql).toContain("injection_count");
    });

    it("approving a pattern never writes confidence — approval is an eligibility grant, not a confidence write (#4571)", async () => {
      let callCount = 0;
      mocks.mockInternalQuery.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve([mockRow()]);
        return Promise.resolve([mockRow({ status: "approved", reviewed_by: "admin-1" })]);
      });

      const res = await req("PATCH", "/pat-1", { status: "approved" });
      expect(res.status).toBe(200);
      const calls = mocks.mockInternalQuery.mock.calls;
      const updateSql = calls[1][0] as string;
      // The approve UPDATE touches status/reviewer/auto_promoted (plus
      // timestamps) — never confidence. Confidence is the machine's evidence
      // meter and no human action may mutate it (CONTEXT.md § Learned query patterns).
      expect(updateSql).toContain("SET ");
      expect(updateSql).toContain("auto_promoted = false");
      expect(updateSql).not.toContain("confidence");
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
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.updated).toBeArray();
      expect(body.notFound).toBeArray();
    });

    it("bulk approve never writes confidence — the second human-action path is also confidence-safe (#4571)", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("SELECT")) return Promise.resolve([{ id: "pat-1" }]);
        return Promise.resolve([mockRow({ status: "approved" })]);
      });

      const res = await req("POST", "/bulk", { ids: ["pat-1"], status: "approved" });
      expect(res.status).toBe(200);
      // The bulk UPDATE is a second human-action write path — assert it, like the
      // single PATCH, touches auto_promoted but never confidence (AC: "No code
      // path lets a human action mutate confidence").
      const updateSql = mocks.mockInternalQuery.mock.calls
        .map((c) => c[0] as string)
        .find((sql) => sql.includes("UPDATE learned_patterns"));
      expect(updateSql).toBeDefined();
      expect(updateSql).toContain("auto_promoted = false");
      expect(updateSql).not.toContain("confidence");
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
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
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

  // ─── GET /summary ─────────────────────────────────────────────────

  describe("GET /summary", () => {
    it("returns query-pattern stats, the entity list, and the multi-group flag (#4578)", async () => {
      // Static /summary must win the match over /{id} — if it were captured as
      // an id, none of these GROUP BY / DISTINCT queries would run and the
      // assertions below would fail.
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("GROUP BY status")) {
          return Promise.resolve([
            { status: "pending", count: "2" },
            { status: "approved", count: "1" },
          ]);
        }
        if (sql.includes("DISTINCT source_entity")) {
          return Promise.resolve([{ source_entity: "customers" }, { source_entity: "orders" }]);
        }
        if (sql.includes("DISTINCT connection_group_id")) {
          return Promise.resolve([{ count: "2" }]);
        }
        return Promise.resolve([]);
      });

      const res = await req("GET", "/summary");
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      // total is the sum of the status buckets — reconciles with the table.
      expect(body.stats).toEqual({ total: 3, pending: 2, approved: 1, rejected: 0 });
      expect(body.entities).toEqual(["customers", "orders"]);
      expect(body.multiGroup).toBe(true);

      // Every summary count is query-pattern-scoped so amendment rows can never
      // inflate a number the table doesn't list (#4569/#4578).
      const sqls = mocks.mockInternalQuery.mock.calls.map((c) => c[0] as string);
      expect(sqls.every((s) => s.includes("type = 'query_pattern'"))).toBe(true);
    });

    it("reports multiGroup false when patterns share a single group bucket", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("GROUP BY status")) return Promise.resolve([{ status: "pending", count: "1" }]);
        if (sql.includes("DISTINCT source_entity")) return Promise.resolve([{ source_entity: "orders" }]);
        if (sql.includes("DISTINCT connection_group_id")) return Promise.resolve([{ count: "1" }]);
        return Promise.resolve([]);
      });
      const res = await req("GET", "/summary");
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.multiGroup).toBe(false);
    });
  });

  // ─── GET /pending-count ───────────────────────────────────────────

  describe("GET /pending-count", () => {
    it("returns the reviewable (pending, query_pattern) count for the nav badge (#4578)", async () => {
      mocks.mockInternalQuery.mockImplementation((sql: string) => {
        if (sql.includes("status = 'pending'")) return Promise.resolve([{ count: "5" }]);
        return Promise.resolve([]);
      });
      const res = await req("GET", "/pending-count");
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.count).toBe(5);
      const sql = mocks.mockInternalQuery.mock.calls[0][0] as string;
      expect(sql).toContain("type = 'query_pattern'");
      expect(sql).toContain("status = 'pending'");
    });

    it("excludes seen-once captures from the badge count (#4581)", async () => {
      mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
      await req("GET", "/pending-count");
      const sql = mocks.mockInternalQuery.mock.calls[0][0] as string;
      // The badge counts reviewable == pending + repeated, never a single capture.
      expect(sql).toContain("status = 'pending'");
      expect(sql).toContain("repetition_count >= 2");
    });
  });

  // ─── Reviewer identity + connection group (#4578) ─────────────────

  describe("reviewer identity + connection group", () => {
    it("resolves the reviewer to a name/email label and carries the connection group", async () => {
      let callCount = 0;
      mocks.mockInternalQuery.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve([{ count: "2" }]);
        return Promise.resolve([
          mockRow({ id: "p1", reviewed_by: "user-9", reviewer_label: "Ada Lovelace", connection_group_id: "prod", status: "approved" }),
          mockRow({ id: "p2" }), // no reviewer_label / connection_group_id in the row
        ]);
      });

      const res = await req("GET", "/");
      expect(res.status).toBe(200);
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.patterns[0].reviewedByLabel).toBe("Ada Lovelace");
      expect(body.patterns[0].connectionGroupId).toBe("prod");
      // Unresolved / unreviewed rows carry nulls, never a raw UUID.
      expect(body.patterns[1].reviewedByLabel).toBeNull();
      expect(body.patterns[1].connectionGroupId).toBeNull();

      // The SELECT resolves the label via a correlated subquery over the user table.
      const selectSql = mocks.mockInternalQuery.mock.calls[1][0] as string;
      expect(selectSql).toContain("reviewer_label");
      expect(selectSql).toContain('FROM "user"');
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
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
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
      // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
      const body = (await res.json()) as any;
      expect(body.error).toBe("internal_error");
      expect(typeof body.requestId).toBe("string");
    });
  });
});

// ===========================================================================
/**
 * Org-scope governance for `admin-learned-patterns.ts` — #4580 (PRD #4570).
 *
 * #4580 converges the route's org filter onto the shared helper
 * `amendmentOrgScope` (the SaaS-vs-self-hosted `org_id` conditional). This has
 * two effects: (1) on the org-LESS SaaS arm it fails CLOSED (WITHHOLD) instead of
 * the old fall-open `org_id IS NULL`; (2) on the self-hosted + org arm — the
 * operative path here, since `requireOrgContext` guarantees an org — it WIDENS
 * from the old `org_id = $N` to `(org_id = $N OR org_id IS NULL)`, matching the
 * agent-injection surface so admins can review the NULL-org "global" patterns the
 * agent already uses. These tests assert, at the route seam, that EVERY scoped
 * read/write threads the helper's clause and binds the active org at the right
 * positional slot.
 *
 * Scope: this harness pins self-hosted (`isSaasModeForGuard: () => false`), so
 * the clause here is the self-hosted arm `(org_id = $N OR org_id IS NULL)`. Three
 * things are pinned elsewhere so they aren't re-driven here:
 *   - the SaaS narrowing (drop the NULL arm) is pinned against the REAL helper in
 *     `db/__tests__/semantic-amendment-saas-scoping.test.ts`;
 *   - the org-less WITHHOLD handling (empty page / 404 / notFound, no query) is
 *     pinned in `admin-learned-patterns-fail-closed.test.ts`;
 *   - the structural proof that the route routes through the helper and inlines
 *     no fail-open clause lives in the saas-scoping reader-enumeration block.
 * The org-less path is unreachable through the route anyway: `requireOrgContext`
 * 400s it before any handler (covered in `admin-learned-patterns.test.ts`).
 */

describe("learned-patterns org scope threads the shared helper's clause (#4580)", () => {
  beforeEach(() => {
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
  });

  it("LIST scopes with the shared-helper clause AND binds the active org param", async () => {
    const res = await req("GET", "/");
    expect(res.status).toBe(200);
    const sqls = issuedSql();
    expect(sqls.length).toBeGreaterThanOrEqual(1);
    // Both the COUNT and the SELECT carry the helper's clause — no handler
    // hand-rolls an org predicate.
    expect(sqls.every((s) => s.includes("(org_id = $1 OR org_id IS NULL)"))).toBe(true);
    const params = mocks.mockInternalQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain("org-1");
  });

  it("GET /:id threads the clause after the id param (id = $1, org = $2)", async () => {
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const res = await req("GET", "/pat-1");
    expect(res.status).toBe(404);
    const sqls = issuedSql();
    expect(sqls.some((s) => s.includes("WHERE id = $1") && s.includes("(org_id = $2 OR org_id IS NULL)"))).toBe(true);
    const params = mocks.mockInternalQuery.mock.calls[0][1] as unknown[];
    expect(params).toEqual(["pat-1", "org-1"]);
  });

  it("PATCH scopes BOTH the existence check and the UPDATE through the helper", async () => {
    let call = 0;
    mocks.mockInternalQuery.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve([{ id: "pat-1" }]); // existence
      return Promise.resolve([
        { id: "pat-1", org_id: "org-1", pattern_sql: "SELECT 1", status: "approved", confidence: 0.5, repetition_count: 1, type: "query_pattern", amendment_payload: null, created_at: "2026-07-10T00:00:00Z", updated_at: "2026-07-10T00:00:00Z" },
      ]);
    });
    const res = await req("PATCH", "/pat-1", { status: "approved" });
    expect(res.status).toBe(200);
    const sqls = issuedSql();
    const selectSql = sqls.find((s) => s.startsWith("SELECT id FROM learned_patterns"));
    const updateSql = sqls.find((s) => s.includes("UPDATE learned_patterns"));
    expect(selectSql).toContain("(org_id = $2 OR org_id IS NULL)");
    expect(updateSql).toContain("org_id = $");
    expect(updateSql).toContain("OR org_id IS NULL");
    // The org param is bound on the UPDATE too (last positional slot).
    const updateCall = mocks.mockInternalQuery.mock.calls.find((c) => (c[0] as string).includes("UPDATE"))!;
    expect(updateCall[1] as unknown[]).toContain("org-1");
  });

  it("DELETE scopes both the existence check and the DELETE through the helper", async () => {
    let call = 0;
    mocks.mockInternalQuery.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve([{ id: "pat-1" }]);
      return Promise.resolve([]);
    });
    const res = await req("DELETE", "/pat-1");
    expect(res.status).toBe(200);
    const sqls = issuedSql();
    expect(sqls.some((s) => s.includes("DELETE FROM learned_patterns") && s.includes("OR org_id IS NULL"))).toBe(true);
  });

  it("bulk scopes each existence check + UPDATE through the helper and binds the org", async () => {
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) return Promise.resolve([{ id: "pat-1", type: "query_pattern" }]);
      return Promise.resolve([]);
    });
    const res = await req("POST", "/bulk", { ids: ["pat-1"], status: "approved" });
    expect(res.status).toBe(200);
    const sqls = issuedSql();
    expect(sqls.some((s) => s.includes("UPDATE learned_patterns") && s.includes("OR org_id IS NULL"))).toBe(true);
    const updateCall = mocks.mockInternalQuery.mock.calls.find((c) => (c[0] as string).includes("UPDATE"))!;
    expect(updateCall[1] as unknown[]).toContain("org-1");
  });
});

// ===========================================================================
/**
 * Tests that `semantic_amendment` rows are folded OUT of the learned-patterns
 * route (#4569).
 *
 * The learned-patterns route is now strictly `type = 'query_pattern'`: an
 * amendment row is invisible (absent from list/counts) and untouchable
 * (`GET`/`PATCH`/`DELETE` on its id → 404, `POST /bulk` → notFound), and no
 * call path can stamp an amendment's status. The improve surface's decide seam
 * (`lib/semantic/expert/decide.ts`) is the ONLY door for amendment decisions —
 * this route must never reach it. That makes #4506's invariant ("the seam is
 * the only writer of `approved`") true for amendment rows by construction.
 *
 * The guarantee is structural: every handler scopes its reads and writes with
 * `type = 'query_pattern'`. These tests assert both the structural scope (the
 * SQL carries the predicate on every path) and the behavior an amendment id
 * sees when the scoped query filters it out (404 / notFound), and that the
 * decide seam is never invoked.
 */


describe("learned-patterns route is query_pattern-only — amendments are folded out (#4569)", () => {
  it("GET / scopes list + count to type = 'query_pattern'", async () => {
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
    const res = await req("GET", "/");
    expect(res.status).toBe(200);
    const sqls = issuedSql();
    // Both the COUNT and the SELECT carry the type scope — amendments never
    // appear in the list or the stat counts the page derives from it.
    expect(sqls.length).toBeGreaterThanOrEqual(2);
    expect(sqls.every((s) => s.includes("type = 'query_pattern'"))).toBe(true);
  });

  it("GET / no longer accepts a ?type filter param — the scope is fixed", async () => {
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
    // A caller asking for amendments gets query patterns anyway: there is no
    // second bound `type = $n` clause, only the fixed literal scope.
    const res = await req("GET", "/?type=semantic_amendment");
    expect(res.status).toBe(200);
    const sqls = issuedSql();
    expect(sqls.every((s) => s.includes("type = 'query_pattern'"))).toBe(true);
    expect(sqls.some((s) => /type = \$\d/.test(s))).toBe(false);
    // The amendment type value never reaches the DB as a bound param.
    for (const call of mocks.mockInternalQuery.mock.calls) {
      expect((call[1] as unknown[]) ?? []).not.toContain("semantic_amendment");
    }
  });

  it("GET /:id on an amendment id → 404, and the SELECT is type-scoped", async () => {
    // The scoped SELECT finds nothing for an amendment id (real DB filters it
    // out); the mock returns [] to model that.
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const res = await req("GET", "/amendment-id");
    expect(res.status).toBe(404);
    expect(issuedSql().every((s) => s.includes("type = 'query_pattern'"))).toBe(true);
  });

  it("PATCH /:id on an amendment id → 404: no write, no status change, seam never reached", async () => {
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const res = await req("PATCH", "/amendment-id", { status: "approved" });
    expect(res.status).toBe(404);
    const sqls = issuedSql();
    // The only query is the type-scoped existence check; no UPDATE ran.
    expect(sqls.every((s) => s.includes("type = 'query_pattern'"))).toBe(true);
    expect(sqls.some((s) => s.includes("UPDATE"))).toBe(false);
    expect(decideAmendment).not.toHaveBeenCalled();
  });

  it("PATCH /:id UPDATE re-asserts type = 'query_pattern' so it can never stamp an amendment", async () => {
    let call = 0;
    mocks.mockInternalQuery.mockImplementation(() => {
      call++;
      // 1st: existence check (query pattern found). 2nd: UPDATE … RETURNING *.
      if (call === 1) return Promise.resolve([{ id: "pat-1" }]);
      return Promise.resolve([
        {
          id: "pat-1",
          org_id: "org-1",
          pattern_sql: "SELECT 1",
          status: "approved",
          confidence: 0.5,
          repetition_count: 1,
          type: "query_pattern",
          amendment_payload: null,
          created_at: "2026-07-10T00:00:00Z",
          updated_at: "2026-07-10T00:00:00Z",
        },
      ]);
    });
    const res = await req("PATCH", "/pat-1", { status: "approved" });
    expect(res.status).toBe(200);
    const updateSql = issuedSql().find((s) => s.includes("UPDATE"));
    expect(updateSql).toBeDefined();
    expect(updateSql).toContain("type = 'query_pattern'");
    expect(decideAmendment).not.toHaveBeenCalled();
  });

  it("DELETE /:id on an amendment id → 404: no delete, both queries type-scoped", async () => {
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const res = await req("DELETE", "/amendment-id");
    expect(res.status).toBe(404);
    const sqls = issuedSql();
    expect(sqls.every((s) => s.includes("type = 'query_pattern'"))).toBe(true);
    expect(sqls.some((s) => s.includes("DELETE"))).toBe(false);
  });

  it("POST /bulk treats an amendment id as notFound and never reaches the seam", async () => {
    // Scoped existence check returns nothing for the amendment id.
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const res = await req("POST", "/bulk", { ids: ["amendment-id"], status: "approved" });
    expect(res.status).toBe(200);
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience
    const body = (await res.json()) as any;
    expect(body.notFound).toContain("amendment-id");
    expect(body.updated).not.toContain("amendment-id");
    const sqls = issuedSql();
    expect(sqls.some((s) => s.includes("SELECT") && s.includes("type = 'query_pattern'"))).toBe(true);
    expect(sqls.some((s) => s.includes("UPDATE"))).toBe(false);
    expect(decideAmendment).not.toHaveBeenCalled();
  });

  it("POST /bulk UPDATE re-asserts type = 'query_pattern' on the write path", async () => {
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) return Promise.resolve([{ id: "pat-1" }]);
      return Promise.resolve([]);
    });
    const res = await req("POST", "/bulk", { ids: ["pat-1"], status: "approved" });
    expect(res.status).toBe(200);
    const updateSql = issuedSql().find((s) => s.includes("UPDATE"));
    expect(updateSql).toBeDefined();
    expect(updateSql).toContain("type = 'query_pattern'");
    expect(decideAmendment).not.toHaveBeenCalled();
  });
});

// ===========================================================================
/**
 * Governance-parity audit suite for `admin-learned-patterns.ts` — #4580
 * (PRD #4570).
 *
 * Pins every write route to the canonical `ADMIN_ACTIONS.pattern.*` vocabulary
 * and the metadata shape forensic queries expect. The two governance gaps this
 * PRD closes:
 *   1. Bulk decisions were forensically SILENT — a bulk approve/reject of up to
 *      100 patterns wrote no audit rows. They now write ONE row per decided
 *      pattern using the SAME `pattern.approve` / `pattern.reject` vocabulary as
 *      the single-decision PATCH path (one vocabulary per concept now that
 *      amendments are folded out of this route, #4569).
 *   2. Description-only edits changed the human-facing text other reviewers
 *      trust with no trace. They now write a `pattern.update_description` row.
 *
 * Test pattern modeled on `admin-prompts-audit.test.ts` (F-35).
 */


// ---------------------------------------------------------------------------
// PATCH /:id — description-only edit audit (#4580 AC: description edit audited)
// ---------------------------------------------------------------------------

describe("PATCH /:id — description edit audit (#4580)", () => {
  function mockExistThenUpdate(updatedOverrides: Record<string, unknown>) {
    let call = 0;
    mocks.mockInternalQuery.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve([mockRow()]); // existence SELECT
      return Promise.resolve([mockRow(updatedOverrides)]); // UPDATE RETURNING *
    });
  }

  it("emits pattern.update_description on a description-only edit", async () => {
    mockExistThenUpdate({ description: "Updated" });
    const res = await req("PATCH", "/pat-1", { description: "Updated" });
    expect(res.status).toBe(200);

    const desc = auditCalls("pattern.update_description");
    expect(desc).toHaveLength(1);
    expect(desc[0].targetType).toBe("pattern");
    expect(desc[0].targetId).toBe("pat-1");
    expect(desc[0].metadata).toMatchObject({ patternId: "pat-1" });
    // A description-only edit is not a decision — no approve/reject row.
    expect(auditCalls("pattern.approve")).toHaveLength(0);
    expect(auditCalls("pattern.reject")).toHaveLength(0);
  });

  it("does NOT emit update_description when only status changes", async () => {
    mockExistThenUpdate({ status: "approved", reviewed_by: "admin-1", reviewed_at: "2026-03-18T00:00:00Z" });
    const res = await req("PATCH", "/pat-1", { status: "approved" });
    expect(res.status).toBe(200);

    expect(auditCalls("pattern.update_description")).toHaveLength(0);
    expect(auditCalls("pattern.approve")).toHaveLength(1);
  });

  it("emits BOTH rows when a PATCH changes description AND status (two governance events)", async () => {
    mockExistThenUpdate({ description: "Updated", status: "approved", reviewed_by: "admin-1" });
    const res = await req("PATCH", "/pat-1", { description: "Updated", status: "approved" });
    expect(res.status).toBe(200);

    expect(auditCalls("pattern.update_description")).toHaveLength(1);
    expect(auditCalls("pattern.approve")).toHaveLength(1);
    expect(auditCalls("pattern.reject")).toHaveLength(0);
  });

  it("emits pattern.approve / pattern.reject with patternId metadata on a status decision", async () => {
    mockExistThenUpdate({ status: "rejected", reviewed_by: "admin-1" });
    const res = await req("PATCH", "/pat-1", { status: "rejected" });
    expect(res.status).toBe(200);
    const reject = auditCalls("pattern.reject");
    expect(reject).toHaveLength(1);
    expect(reject[0].targetType).toBe("pattern");
    expect(reject[0].targetId).toBe("pat-1");
    expect(reject[0].metadata).toMatchObject({ patternId: "pat-1" });
  });

  it("writes NO audit row when the pattern does not exist (404)", async () => {
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const res = await req("PATCH", "/missing", { description: "Updated" });
    expect(res.status).toBe(404);
    expect(auditCalls()).toHaveLength(0);
  });

  it("emits ONLY update_description when a PATCH edits description AND un-approves to pending", async () => {
    // An un-approve (approved → pending) is not an approve/reject decision, so
    // description + pending emits the description row and NO decision row.
    mockExistThenUpdate({ description: "Updated", status: "pending", reviewed_by: "admin-1" });
    const res = await req("PATCH", "/pat-1", { description: "Updated", status: "pending" });
    expect(res.status).toBe(200);
    expect(auditCalls("pattern.update_description")).toHaveLength(1);
    expect(auditCalls("pattern.approve")).toHaveLength(0);
    expect(auditCalls("pattern.reject")).toHaveLength(0);
  });

  it("writes NO audit row when the row is deleted before the update lands (404)", async () => {
    // Existence check passes, but the UPDATE ... RETURNING * comes back empty
    // (a concurrent delete). Audit fires only after a confirmed mutation.
    let call = 0;
    mocks.mockInternalQuery.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve([mockRow()]); // existence
      return Promise.resolve([]); // UPDATE returns nothing
    });
    const res = await req("PATCH", "/pat-1", { description: "Updated" });
    expect(res.status).toBe(404);
    expect(auditCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id — audit (existing behavior, pinned for completeness)
// ---------------------------------------------------------------------------

describe("DELETE /:id — audit", () => {
  it("emits pattern.delete with patternId metadata", async () => {
    let call = 0;
    mocks.mockInternalQuery.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve([mockRow()]);
      return Promise.resolve([]);
    });
    const res = await req("DELETE", "/pat-1");
    expect(res.status).toBe(200);
    const del = auditCalls("pattern.delete");
    expect(del).toHaveLength(1);
    expect(del[0].targetId).toBe("pat-1");
    expect(del[0].metadata).toMatchObject({ patternId: "pat-1" });
  });
});

// ---------------------------------------------------------------------------
// POST /bulk — one audit row per decided pattern (#4580 AC: bulk audit rows)
// ---------------------------------------------------------------------------

describe("POST /bulk — audit rows (#4580)", () => {
  it("writes ONE pattern.approve row per updated pattern, with matching targetIds", async () => {
    // Every existence SELECT finds the row; every UPDATE succeeds.
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) return Promise.resolve([{ id: "x", type: "query_pattern" }]);
      return Promise.resolve([]);
    });

    const res = await req("POST", "/bulk", { ids: ["pat-1", "pat-2", "pat-3"], status: "approved" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: string[] };
    expect(body.updated).toEqual(["pat-1", "pat-2", "pat-3"]);

    const approve = auditCalls("pattern.approve");
    expect(approve).toHaveLength(3);
    expect(approve.map((e) => e.targetId).sort()).toEqual(["pat-1", "pat-2", "pat-3"]);
    for (const e of approve) {
      expect(e.targetType).toBe("pattern");
      expect(e.metadata).toMatchObject({ patternId: e.targetId });
    }
    // Bulk uses the SAME vocabulary as single decisions — never a distinct
    // "bulk" action type.
    expect(auditCalls("pattern.reject")).toHaveLength(0);
  });

  it("uses pattern.reject vocabulary for a bulk reject", async () => {
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) return Promise.resolve([{ id: "x", type: "query_pattern" }]);
      return Promise.resolve([]);
    });
    const res = await req("POST", "/bulk", { ids: ["pat-1", "pat-2"], status: "rejected" });
    expect(res.status).toBe(200);
    expect(auditCalls("pattern.reject")).toHaveLength(2);
    expect(auditCalls("pattern.approve")).toHaveLength(0);
  });

  it("audits ONLY the ids that changed — notFound ids leave no row", async () => {
    let selectCall = 0;
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) {
        selectCall++;
        // First id exists, second is missing.
        return Promise.resolve(selectCall === 1 ? [{ id: "pat-1", type: "query_pattern" }] : []);
      }
      return Promise.resolve([]);
    });

    const res = await req("POST", "/bulk", { ids: ["pat-1", "pat-missing"], status: "approved" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: string[]; notFound: string[] };
    expect(body.updated).toEqual(["pat-1"]);
    expect(body.notFound).toEqual(["pat-missing"]);

    const approve = auditCalls("pattern.approve");
    expect(approve).toHaveLength(1);
    expect(approve[0].targetId).toBe("pat-1");
  });

  it("writes NO audit rows when nothing was updated", async () => {
    // Every SELECT is empty → all notFound, zero updated.
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    const res = await req("POST", "/bulk", { ids: ["a", "b"], status: "approved" });
    expect(res.status).toBe(200);
    expect(auditCalls()).toHaveLength(0);
  });

  it("audits only the succeeding id when a sibling's UPDATE throws mid-bulk", async () => {
    // Both ids pass the existence check; the UPDATE for "pat-err" throws. The
    // erroring id lands in `errors` with NO audit row; its sibling succeeds and
    // gets exactly one.
    mocks.mockInternalQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT")) return Promise.resolve([{ id: "x", type: "query_pattern" }]);
      // UPDATE — params are [status, reviewerId, id].
      if ((params as unknown[])[2] === "pat-err") return Promise.reject(new Error("update boom"));
      return Promise.resolve([]);
    });

    const res = await req("POST", "/bulk", { ids: ["pat-ok", "pat-err"], status: "approved" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: string[]; errors?: Array<{ id: string }> };
    expect(body.updated).toEqual(["pat-ok"]);
    expect(body.errors?.map((e) => e.id)).toEqual(["pat-err"]);

    const approve = auditCalls("pattern.approve");
    expect(approve).toHaveLength(1);
    expect(approve[0].targetId).toBe("pat-ok");
  });
});

// ===========================================================================
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
