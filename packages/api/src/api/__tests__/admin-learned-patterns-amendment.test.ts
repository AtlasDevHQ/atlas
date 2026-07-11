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

import { describe, it, expect, beforeEach, afterAll, mock, type Mock } from "bun:test";
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

/** Collect every SQL string the route issued this request. */
function issuedSql(): string[] {
  return mocks.mockInternalQuery.mock.calls.map((c) => c[0] as string);
}

// --- Cleanup ---

afterAll(() => {
  mocks.cleanup();
});

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
  mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: true }));
  decideAmendment.mockReset();
  decideAmendment.mockImplementation(async () => ({ kind: "approved", id: "x" }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
