/**
 * Fail-closed org-scope handling for `admin-learned-patterns.ts` — #4580.
 *
 * The security core of #4580: when the shared org-scope helper WITHHOLDS
 * (`{ withhold: true }` — the SaaS org-less arm, where falling back to
 * `org_id IS NULL` would broaden the scan to every global-scope row), each route
 * handler must return its EMPTY value (empty page / 404 / notFound) WITHOUT
 * issuing a scoped query. The old local helper fell open there; this pins that
 * the new one never does.
 *
 * `requireOrgContext` 400s an org-less request before any handler, so this path
 * is structurally unreachable in production — it is defense-in-depth. But it is
 * the literal fail-closed guarantee, so we drive it directly by injecting a
 * withhold-always `amendmentOrgScope` via the harness's `internal` override
 * (the real branch matrix that DECIDES when to withhold is pinned against the
 * real helper in `db/__tests__/semantic-amendment-saas-scoping.test.ts`).
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "simple-key",
    label: "Admin",
    role: "admin",
    activeOrganizationId: "org-1",
  },
  // Force the fail-closed arm on every handler: the shared helper withholds.
  internal: { amendmentOrgScope: () => ({ withhold: true }) },
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

/** SQL strings issued against the learned_patterns table this request. */
function learnedPatternSql(): string[] {
  return mocks.mockInternalQuery.mock.calls
    .map((c) => c[0] as string)
    .filter((s) => s.includes("learned_patterns"));
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
  // Any scoped query that DID run would return a row — so a test that still
  // sees the empty shape proves the handler short-circuited before querying.
  mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([{ id: "pat-1", count: "5", type: "query_pattern" }]));
  mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: true }));
});

describe("learned-patterns fail-closed org scope — withhold short-circuits every handler (#4580)", () => {
  it("LIST returns an empty page and never queries learned_patterns", async () => {
    const res = await req("GET", "/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { patterns: unknown[]; total: number };
    expect(body.patterns).toEqual([]);
    expect(body.total).toBe(0);
    expect(learnedPatternSql()).toHaveLength(0);
  });

  it("GET /:id 404s without querying", async () => {
    const res = await req("GET", "/pat-1");
    expect(res.status).toBe(404);
    expect(learnedPatternSql()).toHaveLength(0);
  });

  it("PATCH 404s without querying (existence check short-circuits)", async () => {
    const res = await req("PATCH", "/pat-1", { description: "x" });
    expect(res.status).toBe(404);
    expect(learnedPatternSql()).toHaveLength(0);
  });

  it("DELETE 404s without querying", async () => {
    const res = await req("DELETE", "/pat-1");
    expect(res.status).toBe(404);
    expect(learnedPatternSql()).toHaveLength(0);
  });

  it("bulk treats every id as notFound, updates nothing, and never queries", async () => {
    const res = await req("POST", "/bulk", { ids: ["pat-1", "pat-2"], status: "approved" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: string[]; notFound: string[] };
    expect(body.updated).toEqual([]);
    expect(body.notFound).toEqual(["pat-1", "pat-2"]);
    expect(learnedPatternSql()).toHaveLength(0);
  });
});
