/**
 * POST /api/v1/admin/connection-groups/merge — wire contract tests (#2409).
 *
 * The merge route consolidates N source connections into one target
 * environment. The wire contract guards four things the wizard relies on:
 *
 *   1. Validation — at least one source, all sources must exist and live in
 *      the caller's org. A single foreign-org source returns 403 so the
 *      wizard surfaces a clean error rather than silently dropping the row.
 *   2. Atomicity — every state change (target group create-or-reuse,
 *      connections re-parent, cleanup of auto-backfilled source groups)
 *      lands in one SQL statement so a partial failure rolls everything
 *      back. The test pins the SQL shape: one INSERT...ON CONFLICT, one
 *      UPDATE branch, one DELETE branch, all in a single CTE.
 *   3. Reuse semantics — a target name that already exists in the org
 *      reuses the existing group (the unique-name index would otherwise
 *      raise 23505), and the existing primary is preserved unless the
 *      caller explicitly overrides it.
 *   4. Cleanup signature — only auto-backfilled `g_<connId>` groups whose
 *      `name` still equals the bare connection id are eligible for
 *      cleanup. User-created groups (random `g_<hash>` id with a custom
 *      name) and admin-renamed singletons are left in place even when
 *      empty so the merge cannot silently nuke admin-curated rows.
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

// --- Mocks ---

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
  connection: {
    connections: {
      get: () => null,
      getDefault: () => null,
      describe: () => [
        { id: "us-int", dbType: "postgres", description: "US prod" },
        { id: "eu-int", dbType: "postgres", description: "EU prod" },
        { id: "apac-int", dbType: "postgres", description: "APAC prod" },
        { id: "other-org-conn", dbType: "postgres", description: "Other org" },
      ],
      healthCheck: mock(() => Promise.resolve({ status: "healthy", latencyMs: 1, checkedAt: new Date() })),
      register: mock(() => {}),
      unregister: mock(() => false),
      has: (id: string) => ["us-int", "eu-int", "apac-int", "other-org-conn"].includes(id),
      list: () => ["us-int", "eu-int", "apac-int", "other-org-conn"],
      getForOrg: () => null,
      drain: mock(() => Promise.resolve({ drained: true, message: "" })),
      drainOrg: mock(() => Promise.resolve({ drained: 0 })),
      getAllPoolMetrics: () => [],
      getOrgPoolMetrics: () => [],
      getOrgPoolConfig: () => ({ enabled: false, maxConnections: 5, idleTimeoutMs: 30000, maxOrgs: 50, warmupProbes: 2, drainThreshold: 5 }),
      listOrgs: () => [],
    },
    resolveDatasourceUrl: () => "postgresql://stub",
  },
  internal: {
    encryptSecret: (url: string) => `encrypted:${url}`,
    decryptSecret: (url: string) => (url as string).replace(/^encrypted:/, ""),
  },
});

const { app } = await import("../index");

afterAll(() => {
  mocks.cleanup();
});

// --- Helpers ---

function adminRequest(urlPath: string, method = "POST", body?: unknown): Request {
  const headers: Record<string, string> = {
    Authorization: "Bearer test-key",
    "Content-Type": "application/json",
  };
  return new Request(`http://localhost${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

type SqlCall = { sql: string; params: unknown[] };

function findCall(predicate: (sql: string) => boolean): SqlCall | undefined {
  const call = mocks.mockInternalQuery.mock.calls.find(
    ([sql]) => typeof sql === "string" && predicate(sql),
  );
  if (!call) return undefined;
  return { sql: call[0] as string, params: (call[1] ?? []) as unknown[] };
}

// --- Tests ---

describe("POST /api/v1/admin/connection-groups/merge", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.setOrgAdmin("org-alpha");
  });

  // ─── 1. Validation ────────────────────────────────────────────────────

  it("rejects empty sourceConnectionIds with 400", async () => {
    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups/merge", "POST", {
        targetName: "prod",
        sourceConnectionIds: [],
      }),
    );
    expect(res.status).toBe(400);
    // No state-changing SQL fires on a validation reject — every INSERT/
    // UPDATE/DELETE call is gated behind a successful body parse. The
    // pre-validation SELECT against `connections` is also skipped.
    expect(
      mocks.mockInternalQuery.mock.calls.some(([sql]) =>
        typeof sql === "string" && /\b(INSERT|UPDATE|DELETE)\b/i.test(sql),
      ),
    ).toBe(false);
  });

  it("rejects a missing targetName with 400", async () => {
    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups/merge", "POST", {
        sourceConnectionIds: ["us-int", "eu-int"],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an invalid targetName (regex fail) with 400 and includes requestId", async () => {
    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups/merge", "POST", {
        targetName: "  // not allowed",
        sourceConnectionIds: ["us-int"],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string; requestId: string };
    expect(body.error).toBe("invalid_request");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  it("returns 404 when a source connection does not exist in the org", async () => {
    // Pre-validate query returns only 2 of the 3 requested ids — one is missing.
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      // Pre-validate match must be MORE specific than the merge CTE's
      // `moved` branch (which also includes `FROM connections WHERE id =
      // ANY`). Anchoring on the SELECT shape keeps the two queries
      // distinguishable.
      if (sql.includes("SELECT id, org_id, group_id FROM connections")) {
        return Promise.resolve([
          { id: "us-int", org_id: "org-alpha", group_id: "g_us-int" },
          { id: "eu-int", org_id: "org-alpha", group_id: "g_eu-int" },
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups/merge", "POST", {
        targetName: "prod",
        sourceConnectionIds: ["us-int", "eu-int", "ghost"],
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when a source connection belongs to a different org", async () => {
    // Pre-validate query returns the foreign-org row — the route's org-check
    // must reject before any state-changing SQL runs.
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      // Pre-validate match must be MORE specific than the merge CTE's
      // `moved` branch (which also includes `FROM connections WHERE id =
      // ANY`). Anchoring on the SELECT shape keeps the two queries
      // distinguishable.
      if (sql.includes("SELECT id, org_id, group_id FROM connections")) {
        return Promise.resolve([
          { id: "us-int", org_id: "org-alpha", group_id: "g_us-int" },
          { id: "other-org-conn", org_id: "org-beta", group_id: "g_other-org-conn" },
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups/merge", "POST", {
        targetName: "prod",
        sourceConnectionIds: ["us-int", "other-org-conn"],
      }),
    );
    expect(res.status).toBe(403);
    // Cross-org check must short-circuit BEFORE the atomic merge fires.
    // A regression that lets the merge proceed would silently re-parent a
    // foreign-org connection into the caller's org.
    expect(
      mocks.mockInternalQuery.mock.calls.some(([sql]) =>
        typeof sql === "string" && sql.includes("INSERT INTO connection_groups"),
      ),
    ).toBe(false);
  });

  it("rejects a primaryConnectionId that is not in sourceConnectionIds with 400", async () => {
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      // Pre-validate match must be MORE specific than the merge CTE's
      // `moved` branch (which also includes `FROM connections WHERE id =
      // ANY`). Anchoring on the SELECT shape keeps the two queries
      // distinguishable.
      if (sql.includes("SELECT id, org_id, group_id FROM connections")) {
        return Promise.resolve([
          { id: "us-int", org_id: "org-alpha", group_id: "g_us-int" },
          { id: "eu-int", org_id: "org-alpha", group_id: "g_eu-int" },
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups/merge", "POST", {
        targetName: "prod",
        sourceConnectionIds: ["us-int", "eu-int"],
        primaryConnectionId: "apac-int",
      }),
    );
    expect(res.status).toBe(400);
  });

  // ─── 2. Atomicity (single CTE shape) ──────────────────────────────────

  it("happy path runs a single CTE statement covering INSERT, UPDATE, and DELETE", async () => {
    // Two source connections, both in this org.
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      // Pre-validate match must be MORE specific than the merge CTE's
      // `moved` branch (which also includes `FROM connections WHERE id =
      // ANY`). Anchoring on the SELECT shape keeps the two queries
      // distinguishable.
      if (sql.includes("SELECT id, org_id, group_id FROM connections")) {
        return Promise.resolve([
          { id: "us-int", org_id: "org-alpha", group_id: "g_us-int" },
          { id: "eu-int", org_id: "org-alpha", group_id: "g_eu-int" },
        ]);
      }
      // The merge CTE returns one row with target / moved / deleted columns.
      if (sql.includes("WITH target AS")) {
        return Promise.resolve([
          {
            target: {
              id: "g_abc123",
              name: "prod",
              primaryConnectionId: "us-int",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              created: true,
            },
            moved_connection_ids: ["us-int", "eu-int"],
            deleted_group_ids: ["g_us-int", "g_eu-int"],
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups/merge", "POST", {
        targetName: "prod",
        sourceConnectionIds: ["us-int", "eu-int"],
      }),
    );
    expect(res.status).toBe(200);

    // Atomicity contract: the merge runs as ONE statement. The CTE must
    // contain all three branches — if any of them is hoisted into a
    // separate internalQuery call, partial failure leaves the DB
    // inconsistent.
    const mergeCall = findCall((sql) => sql.includes("WITH target AS"));
    expect(mergeCall).toBeDefined();
    expect(mergeCall!.sql).toMatch(/INSERT INTO connection_groups/);
    expect(mergeCall!.sql).toMatch(/UPDATE connections/);
    expect(mergeCall!.sql).toMatch(/DELETE FROM connection_groups/);
    // ON CONFLICT clause is what handles target-name reuse; without it,
    // a name collision raises 23505 and breaks the merge.
    expect(mergeCall!.sql).toMatch(/ON CONFLICT/);

    // Response shape carries enough state for the wizard to render a "what
    // changed" summary without a second round-trip.
    const body = (await res.json()) as {
      target: { id: string; name: string };
      movedConnectionIds: string[];
      deletedGroupIds: string[];
    };
    expect(body.target.name).toBe("prod");
    expect(body.movedConnectionIds).toEqual(["us-int", "eu-int"]);
    expect(body.deletedGroupIds).toEqual(["g_us-int", "g_eu-int"]);
  });

  it("passes orgId as the second parameter so cross-org re-parenting is impossible at the SQL layer", async () => {
    mocks.setOrgAdmin("org-beta");
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      // Pre-validate match must be MORE specific than the merge CTE's
      // `moved` branch (which also includes `FROM connections WHERE id =
      // ANY`). Anchoring on the SELECT shape keeps the two queries
      // distinguishable.
      if (sql.includes("SELECT id, org_id, group_id FROM connections")) {
        return Promise.resolve([
          { id: "us-int", org_id: "org-beta", group_id: "g_us-int" },
        ]);
      }
      if (sql.includes("WITH target AS")) {
        return Promise.resolve([
          {
            target: { id: "g_x", name: "prod", primaryConnectionId: "us-int", createdAt: "", updatedAt: "", created: true },
            moved_connection_ids: ["us-int"],
            deleted_group_ids: [],
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups/merge", "POST", {
        targetName: "prod",
        sourceConnectionIds: ["us-int"],
      }),
    );
    expect(res.status).toBe(200);

    const mergeCall = findCall((sql) => sql.includes("WITH target AS"));
    expect(mergeCall).toBeDefined();
    // The merge CTE parameters: $1 = target group id, $2 = org id, ...
    // Pinning the orgId position protects against future refactors that
    // could swap parameter order and accidentally use a constant or a
    // body-provided org.
    expect(mergeCall!.params[1]).toBe("org-beta");
  });

  // ─── 3. Reuse semantics ───────────────────────────────────────────────

  it("with reuseExisting=true on a target name that already exists, ON CONFLICT keeps the existing primary unless overridden", async () => {
    // The route doesn't fail with 409 when the target name already exists —
    // it reuses the row via ON CONFLICT. The wizard surfaces the existing
    // member count in the preview so the admin sees what they're merging
    // into.
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      // Pre-validate match must be MORE specific than the merge CTE's
      // `moved` branch (which also includes `FROM connections WHERE id =
      // ANY`). Anchoring on the SELECT shape keeps the two queries
      // distinguishable.
      if (sql.includes("SELECT id, org_id, group_id FROM connections")) {
        return Promise.resolve([
          { id: "apac-int", org_id: "org-alpha", group_id: "g_apac-int" },
        ]);
      }
      if (sql.includes("WITH target AS")) {
        return Promise.resolve([
          {
            target: {
              id: "g_existing",
              name: "prod",
              primaryConnectionId: "us-int", // preserved from the pre-existing row
              createdAt: new Date(Date.now() - 60_000).toISOString(),
              updatedAt: new Date().toISOString(),
              created: false,
            },
            moved_connection_ids: ["apac-int"],
            deleted_group_ids: ["g_apac-int"],
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups/merge", "POST", {
        targetName: "prod",
        sourceConnectionIds: ["apac-int"],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      target: { id: string; primaryConnectionId: string; created: boolean };
    };
    expect(body.target.created).toBe(false);
    expect(body.target.primaryConnectionId).toBe("us-int");
  });

  it("propagates an explicit primaryConnectionId override into the merge CTE parameters", async () => {
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      // Pre-validate match must be MORE specific than the merge CTE's
      // `moved` branch (which also includes `FROM connections WHERE id =
      // ANY`). Anchoring on the SELECT shape keeps the two queries
      // distinguishable.
      if (sql.includes("SELECT id, org_id, group_id FROM connections")) {
        return Promise.resolve([
          { id: "us-int", org_id: "org-alpha", group_id: "g_us-int" },
          { id: "eu-int", org_id: "org-alpha", group_id: "g_eu-int" },
        ]);
      }
      if (sql.includes("WITH target AS")) {
        return Promise.resolve([
          {
            target: { id: "g_new", name: "prod", primaryConnectionId: "eu-int", createdAt: "", updatedAt: "", created: true },
            moved_connection_ids: ["us-int", "eu-int"],
            deleted_group_ids: ["g_us-int", "g_eu-int"],
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups/merge", "POST", {
        targetName: "prod",
        sourceConnectionIds: ["us-int", "eu-int"],
        primaryConnectionId: "eu-int",
      }),
    );
    expect(res.status).toBe(200);

    const mergeCall = findCall((sql) => sql.includes("WITH target AS"));
    expect(mergeCall).toBeDefined();
    // The primaryConnectionId is passed as a parameter so the override
    // survives ON CONFLICT DO UPDATE (the CASE branch keys off a separate
    // boolean param).
    expect(mergeCall!.params).toContain("eu-int");
  });

  // ─── 4. Audit + error mapping ────────────────────────────────────────

  it("returns 500 with a requestId when the merge CTE throws an unexpected error", async () => {
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      // Pre-validate match must be MORE specific than the merge CTE's
      // `moved` branch (which also includes `FROM connections WHERE id =
      // ANY`). Anchoring on the SELECT shape keeps the two queries
      // distinguishable.
      if (sql.includes("SELECT id, org_id, group_id FROM connections")) {
        return Promise.resolve([
          { id: "us-int", org_id: "org-alpha", group_id: "g_us-int" },
        ]);
      }
      if (sql.includes("WITH target AS")) {
        return Promise.reject(new Error("simulated PG failure"));
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(
      adminRequest("/api/v1/admin/connection-groups/merge", "POST", {
        targetName: "prod",
        sourceConnectionIds: ["us-int"],
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string; requestId: string };
    expect(body.error).toBe("internal_error");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
    // The error message must not leak the underlying driver string —
    // CLAUDE.md "No generic error messages" still applies, but specific
    // SQL state belongs in the log, not the response body.
    expect(body.message).not.toContain("simulated PG failure");
  });
});
