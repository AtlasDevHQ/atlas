/**
 * Admin connection-groups archive route — route-handler unit tests.
 *
 * Complements the SQL-level coverage in `migrate-pg.test.ts` (real
 * Postgres) and the wire-level integration test in
 * `e2e/browser/multi-env-admin.spec.ts`. This layer pins behaviours the
 * other two can't see:
 *
 *   - The pre-existence check returns 404 / 409 without ever opening a
 *     transaction (BEGIN must not appear in the captured queries).
 *   - The transaction lifecycle is precisely four UPDATEs in order
 *     (entities → tasks → approvals → group) wrapped in BEGIN/COMMIT.
 *   - `client.release(rollbackErr)` destroys a poisoned socket when
 *     ROLLBACK itself fails — the only path that prevents pool
 *     poisoning.
 *   - The audit row is emitted with `connection_group.archive`,
 *     `targetId=id`, `metadata.archivedCounts`, and uses the
 *     `await` helper so an internal-DB outage surfaces as 500.
 *   - Concurrent-archive race (the cascade's UPDATEs return 0 rows
 *     because another admin won) is mapped to 409, not a misleading
 *     200 with zero counts.
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

// ---------------------------------------------------------------------------
// Transactional client mock
// ---------------------------------------------------------------------------
// Mirrors `admin-oauth-clients.test.ts` so the pool.connect() + BEGIN /
// 4× UPDATE / COMMIT / ROLLBACK lifecycle is observable.

interface ClientQuery {
  sql: string;
  params?: unknown[];
}

interface MockClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  release: (err?: unknown) => void;
}

let clientQueries: ClientQuery[] = [];
let clientReleased = false;
let clientReleaseArg: unknown = undefined;
let queryHandler: (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }> = async () => ({ rows: [] });

function makeMockClient(): MockClient {
  return {
    query: async (sql: string, params?: unknown[]) => {
      clientQueries.push({ sql, params });
      return queryHandler(sql, params);
    },
    release: (err?: unknown) => {
      clientReleased = true;
      clientReleaseArg = err;
    },
  };
}

const mockGetInternalDB = mock(() => ({
  connect: async () => makeMockClient(),
}));

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-alpha",
  },
  authMode: "managed",
  internal: {
    getInternalDB: mockGetInternalDB,
  },
});

// ---------------------------------------------------------------------------
// Audit mock — both fire-and-forget and awaiting variants because the
// archive route uses the awaiting form (audit row is load-bearing for
// SOC2 evidence on a high-blast-radius admin op).
// ---------------------------------------------------------------------------

interface AuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

const mockLogAdminAction: Mock<(entry: AuditEntry) => void> = mock(() => {});
const mockLogAdminActionAwait: Mock<(entry: AuditEntry) => Promise<void>> = mock(
  async () => {},
);

// `mock.module` must cover every named export the route layer pulls
// from `@atlas/api/lib/audit` — a partial mock breaks the loader with
// "Export named 'errorMessage' not found" (CLAUDE.md: "Mock all
// exports — partial mocks cause SyntaxError").
mock.module("@atlas/api/lib/audit", async () => {
  const actions = await import("@atlas/api/lib/audit/actions");
  const errorScrub = await import("@atlas/api/lib/audit/error-scrub");
  return {
    ADMIN_ACTIONS: actions.ADMIN_ACTIONS,
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mockLogAdminActionAwait,
    errorMessage: errorScrub.errorMessage,
    causeToError: errorScrub.causeToError,
  };
});

const { app } = await import("../index");

afterAll(() => mocks.cleanup());

function adminRequest(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function resetTxClient(): void {
  clientQueries = [];
  clientReleased = false;
  clientReleaseArg = undefined;
  queryHandler = async () => ({ rows: [] });
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  mocks.setOrgAdmin("org-alpha");
  mocks.mockInternalQuery.mockReset();
  mocks.mockInternalQuery.mockResolvedValue([]);
  mockLogAdminAction.mockClear();
  mockLogAdminActionAwait.mockClear();
  resetTxClient();
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/connection-groups/:id/archive
// ---------------------------------------------------------------------------

describe("admin connection-groups — POST /:id/archive", () => {
  it("happy path: cascade runs in one txn, audit awaits, returns counts", async () => {
    // Pre-check SELECT returns an active group; the four cascade
    // UPDATEs report rowCount via the rows array length.
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM connection_groups")) {
        return [{ status: "active" }];
      }
      return [];
    });
    queryHandler = async (sql) => {
      if (sql.includes("UPDATE semantic_entities")) return { rows: [{ id: "e1" }, { id: "e2" }] };
      if (sql.includes("UPDATE scheduled_tasks")) return { rows: [{ id: "t1" }] };
      if (sql.includes("UPDATE approval_queue")) return { rows: [] };
      if (sql.includes("UPDATE connection_groups")) return { rows: [{ id: "g_prod" }] };
      return { rows: [] };
    };

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connection-groups/g_prod/archive"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      archivedCounts: { entities: number; tasks: number; approvals: number };
    };
    expect(body.archivedCounts).toEqual({ entities: 2, tasks: 1, approvals: 0 });
    // Note: the wire response does NOT carry a `group` field anymore —
    // 200 itself encodes "this caller flipped state"; 409 encodes the
    // race-lost case.
    expect((body as Record<string, unknown>).group).toBeUndefined();

    // Transaction lifecycle: BEGIN, then 4 UPDATEs in order, then
    // COMMIT. ROLLBACK must not appear on the happy path.
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("COMMIT")).toBe(true);
    expect(sqls.includes("ROLLBACK")).toBe(false);
    expect(clientReleased).toBe(true);
    expect(clientReleaseArg).toBeUndefined();

    const updateOrder = clientQueries
      .filter((q) => /^\s*UPDATE\s/i.test(q.sql))
      .map((q) => {
        const m = q.sql.match(/UPDATE\s+(\w+)/i);
        return m ? m[1] : null;
      });
    expect(updateOrder).toEqual([
      "semantic_entities",
      "scheduled_tasks",
      "approval_queue",
      "connection_groups",
    ]);

    // Audit emitted via the awaiting helper so an internal-DB outage
    // surfaces as 500 rather than a silent gap.
    expect(mockLogAdminActionAwait).toHaveBeenCalledTimes(1);
    expect(mockLogAdminAction).not.toHaveBeenCalled();
    const entry = mockLogAdminActionAwait.mock.calls[0]![0]!;
    expect(entry.actionType).toBe("connection_group.archive");
    expect(entry.targetType).toBe("connection_group");
    expect(entry.targetId).toBe("g_prod");
    expect(entry.metadata).toMatchObject({
      archivedCounts: { entities: 2, tasks: 1, approvals: 0 },
    });
  });

  it("404 when the group does not exist (no txn opened)", async () => {
    mocks.mockInternalQuery.mockResolvedValue([]);

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connection-groups/g_missing/archive"),
    );
    expect(res.status).toBe(404);

    // The pre-check short-circuits — no transaction must open or no
    // audit row must emit.
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("BEGIN")).toBe(false);
    expect(mockLogAdminActionAwait).not.toHaveBeenCalled();
  });

  it("409 when the group is already archived (idempotency contract)", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM connection_groups")) {
        return [{ status: "archived" }];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connection-groups/g_prod/archive"),
    );
    expect(res.status).toBe(409);

    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("BEGIN")).toBe(false);
    expect(mockLogAdminActionAwait).not.toHaveBeenCalled();
  });

  it("409 on concurrent winner: cascade UPDATE flips 0 rows, no audit emitted", async () => {
    // Pre-check sees `active`, but between pre-check and BEGIN a
    // concurrent admin's archive lands. The group UPDATE's
    // `WHERE status='active'` predicate turns the duplicate flip into
    // a 0-row no-op. The route maps that to 409 rather than 200 +
    // zero counts.
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM connection_groups")) {
        return [{ status: "active" }];
      }
      return [];
    });
    queryHandler = async () => ({ rows: [] }); // every UPDATE no-ops

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connection-groups/g_prod/archive"),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("conflict");

    // The COMMIT still ran (zero-row no-op txn is safe), and the
    // client was released cleanly — but no audit row.
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("BEGIN")).toBe(true);
    expect(sqls.includes("COMMIT")).toBe(true);
    expect(sqls.includes("ROLLBACK")).toBe(false);
    expect(mockLogAdminActionAwait).not.toHaveBeenCalled();
  });

  it("500 + ROLLBACK + clean release when a cascade UPDATE throws", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM connection_groups")) {
        return [{ status: "active" }];
      }
      return [];
    });
    queryHandler = async (sql) => {
      if (sql.includes("UPDATE scheduled_tasks")) {
        throw new Error("pool timeout");
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connection-groups/g_prod/archive"),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { requestId?: string };
    expect(body.requestId).toBeDefined();

    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("ROLLBACK")).toBe(true);
    expect(sqls.includes("COMMIT")).toBe(false);
    expect(clientReleased).toBe(true);
    expect(mockLogAdminActionAwait).not.toHaveBeenCalled();
  });

  it("ROLLBACK failure poisons the client (release called with err)", async () => {
    // If ROLLBACK itself throws (dead socket), `client.release(err)`
    // MUST be called with a truthy arg so pg destroys the socket
    // instead of returning it to the pool. A regression here is the
    // exact bug that would silently corrupt subsequent borrowers.
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM connection_groups")) {
        return [{ status: "active" }];
      }
      return [];
    });
    queryHandler = async (sql) => {
      if (sql.includes("UPDATE semantic_entities")) {
        throw new Error("original cascade failure");
      }
      if (sql === "ROLLBACK") {
        throw new Error("socket gone");
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connection-groups/g_prod/archive"),
    );
    expect(res.status).toBe(500);

    // Client was released WITH a truthy err so pg destroys it.
    expect(clientReleased).toBe(true);
    expect(clientReleaseArg).toBeTruthy();
  });

  it("500 when the audit await throws after commit (cascade is already archived; retry hits 409)", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT status FROM connection_groups")) {
        return [{ status: "active" }];
      }
      return [];
    });
    queryHandler = async (sql) => {
      if (sql.includes("UPDATE connection_groups")) return { rows: [{ id: "g_prod" }] };
      return { rows: [] };
    };
    mockLogAdminActionAwait.mockRejectedValueOnce(new Error("audit DB down"));

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connection-groups/g_prod/archive"),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string; requestId?: string };
    // Message must spell out that the state IS archived so a confused
    // operator doesn't double-archive.
    expect(body.message).toContain("archived");
    expect(body.requestId).toBeDefined();

    // COMMIT still ran — the rollback path didn't fire.
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("COMMIT")).toBe(true);
    expect(sqls.includes("ROLLBACK")).toBe(false);
  });

  it("403 for non-admin members", async () => {
    mocks.mockAuthenticateRequest.mockImplementation(() =>
      Promise.resolve({
        authenticated: true,
        mode: "managed",
        user: {
          id: "user-1",
          mode: "managed",
          label: "user@test.com",
          role: "member",
          activeOrganizationId: "org-alpha",
        },
      }),
    );

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connection-groups/g_prod/archive"),
    );
    expect(res.status).toBe(403);
    expect(mockLogAdminActionAwait).not.toHaveBeenCalled();
  });

  it("pre-check SELECT is org-scoped (B2B isolation)", async () => {
    // Pin that the orgId predicate is on the wire. A regression that
    // dropped `AND org_id = $2` from the pre-check SELECT would let
    // org-A's caller see org-B's group exist. Mock only returns rows
    // when the orgId param matches the active org.
    mocks.mockInternalQuery.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT status FROM connection_groups")) {
          expect(sql).toContain("org_id = $2");
          if (params?.[1] !== "org-alpha") return [];
          return [{ status: "active" }];
        }
        return [];
      },
    );
    // queryHandler returns rows for the group UPDATE so the route
    // doesn't 409 out as the concurrent-winner case — we want to
    // exercise the pre-check's org-scoped path, not the post-commit
    // race branch.
    queryHandler = async (sql) => {
      if (sql.includes("UPDATE connection_groups")) return { rows: [{ id: "g_prod" }] };
      return { rows: [] };
    };

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connection-groups/g_prod/archive"),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Wire-shape sibling routes — refusal of writes against archived groups
// ---------------------------------------------------------------------------

describe("admin connection-groups — archived groups refuse writes", () => {
  it("PATCH /:id (rename) returns 404 when target is archived (status='active' guard in UPDATE)", async () => {
    // The rename's UPDATE WHERE clause filters `status = 'active'`, so
    // an archived target returns RETURNING [] which the route maps to
    // 404. The route doesn't distinguish "doesn't exist" from "exists
    // but archived" via UPDATE; the existence-by-id check happens
    // implicitly via the empty RETURNING.
    mocks.mockInternalQuery.mockResolvedValue([]);
    const res = await app.fetch(
      adminRequest("PATCH", "/api/v1/admin/connection-groups/g_prod", {
        name: "new-name",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("POST /:id/members returns 409 when target is archived", async () => {
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, status FROM connection_groups")) {
        return [{ id: "g_prod", status: "archived" }];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connection-groups/g_prod/members", {
        connectionId: "us-int",
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("archived");
  });

  it("POST /merge returns 409 when target name collides with an archived group", async () => {
    // The merge pre-validate runs `SELECT id, status FROM
    // connection_groups WHERE name = $2 AND status = 'archived'`
    // before the CTE. An archived collision must short the request
    // with a 409 + clear message, never re-attach connections to a
    // tombstone.
    mocks.mockInternalQuery.mockImplementation(async (sql: string) => {
      if (
        sql.includes("SELECT id, status FROM connection_groups") &&
        sql.includes("status = 'archived'")
      ) {
        return [{ id: "g_prod_old", status: "archived" }];
      }
      // Source-validate SELECT — return rows so the pre-validate
      // succeeds before hitting the archived-target check.
      if (sql.includes("SELECT id, org_id, group_id FROM connections")) {
        return [
          { id: "us-int", org_id: "org-alpha", group_id: "g_us-int" },
          { id: "eu", org_id: "org-alpha", group_id: "g_eu" },
        ];
      }
      return [];
    });

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/connection-groups/merge", {
        targetName: "prod",
        sourceConnectionIds: ["us-int", "eu"],
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("archived");
  });
});
