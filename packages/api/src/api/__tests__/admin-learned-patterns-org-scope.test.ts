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

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
} from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "simple-key",
    label: "Admin",
    role: "admin",
    activeOrganizationId: "org-1",
  },
});

const { app } = await import("../index");

function req(method: string, urlPath: string, body?: unknown) {
  const url = `http://localhost/api/v1/admin/learned-patterns${urlPath}`;
  const init: RequestInit = { method, headers: { Authorization: "Bearer test" } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  return app.fetch(new Request(url, init));
}

/** Every SQL string the route issued this request. */
function issuedSql(): string[] {
  return mocks.mockInternalQuery.mock.calls.map((c) => c[0] as string);
}

afterAll(() => mocks.cleanup());

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
  mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ count: "0" }]));
  mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: true }));
});

describe("learned-patterns org scope threads the shared helper's clause (#4580)", () => {
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
