/**
 * Tests for POST /api/v1/admin/archive-connection and
 * POST /api/v1/admin/restore-connection (issue #1437).
 *
 * Verifies the single-connection archive/restore flow used by admins to
 * take the onboarding demo offline (or bring it back for training) outside
 * the publish flow.
 *
 * Covers: cascade to entities, demo prompt cascade on `__demo__`, 404 for
 * missing connection, idempotent no-op when already-archived, 404 when
 * restoring a non-archived connection, transaction atomicity on
 * mid-flight failure, admin-only auth.
 *
 * Mirrors the transactional-client mock pattern from admin-publish.test.ts.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";
import { makeArchiveRestoreStubs } from "@atlas/api/testing/archive-restore";

// Controls `getSettingAuto("ATLAS_DEMO_INDUSTRY", orgId)` per test. Tests
// that need to drive the demo-prompt cascade mutate these before invoking
// the route. `throwOnGet` simulates a transient cache-read failure so the
// route can surface 500 (issue #1470) rather than silently swallowing it.
// Declared here; the `mock.module` override is registered AFTER
// `createApiTestMocks` below — otherwise the factory's own mock overrides
// ours.
let demoIndustryFixture: string | null = null;
let throwOnGet: Error | null = null;

// ── Transactional client mock ─────────────────────────────────────────

interface ClientQuery {
  sql: string;
  params?: unknown[];
}

interface MockClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  release: (err?: unknown) => void;
}

let clientQueries: ClientQuery[] = [];
let clientReleased = false;
// Captures the argument passed to `client.release(err?)`. When non-undefined,
// node-postgres destroys the socket instead of returning it to the pool —
// this is what we assert for issue #1471 (ROLLBACK-failure poisoning).
let clientReleaseArg: unknown = undefined;
let queryHandler: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> = async () => ({ rows: [] });

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

// ── Shared mocks ──────────────────────────────────────────────────────

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

// Override the default settings mock from createApiTestMocks so tests
// can drive getSettingAuto("ATLAS_DEMO_INDUSTRY") and simulate a transient
// read failure. Registered AFTER createApiTestMocks so it wins.
mock.module("@atlas/api/lib/settings", () => ({
  getSettingsForAdmin: () => [],
  getSettingsRegistry: () => [],
  getSettingDefinition: () => undefined,
  setSetting: async () => {},
  deleteSetting: async () => {},
  getSetting: () => undefined,
  getSettingAuto: (key: string) => {
    if (throwOnGet) throw throwOnGet;
    return key === "ATLAS_DEMO_INDUSTRY" ? (demoIndustryFixture ?? undefined) : undefined;
  },
  getSettingLive: async () => undefined,
  loadSettings: async () => 0,
  getAllSettingOverrides: async () => [],
  _resetSettingsCache: () => {},
}));

// Replace the default no-op semantic/entities mock with full-fidelity
// archive/restore stubs that issue real SQL against our transactional
// client. That lets the tests assert BEGIN / lock-before-mutate /
// cascade-ordering / COMMIT. Other entity helpers stay as no-ops because
// this test file doesn't exercise them.
mock.module("@atlas/api/lib/semantic/entities", () => ({
  listEntities: mock(() => Promise.resolve([])),
  getEntity: mock(() => Promise.resolve(null)),
  upsertEntity: mock(() => Promise.resolve()),
  deleteEntity: mock(() => Promise.resolve(false)),
  countEntities: mock(() => Promise.resolve(0)),
  bulkUpsertEntities: mock(() => Promise.resolve(0)),
  upsertDraftEntity: mock(() => Promise.resolve()),
  upsertTombstone: mock(() => Promise.resolve()),
  deleteDraftEntity: mock(() => Promise.resolve(false)),
  createVersion: mock(() => Promise.resolve("v1")),
  listVersions: mock(() => Promise.resolve({ versions: [], total: 0 })),
  getVersion: mock(() => Promise.resolve(null)),
  generateChangeSummary: mock(() => Promise.resolve("")),
  listEntitiesWithOverlay: mock(() => Promise.resolve([])),
  SEMANTIC_ENTITY_STATUSES: ["published", "draft", "draft_delete", "archived"],
  applyTombstones: mock(() => Promise.resolve(0)),
  promoteDraftEntities: mock(() => Promise.resolve(0)),
  ...makeArchiveRestoreStubs(),
}));

// Import app AFTER mocks are declared
const { app } = await import("../index");

// ── Helpers ───────────────────────────────────────────────────────────

function makeReq(path: "archive-connection" | "restore-connection", body?: unknown): Request {
  return new Request(`http://localhost/api/v1/admin/${path}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
}

function resetClient(): void {
  clientQueries = [];
  clientReleased = false;
  clientReleaseArg = undefined;
  queryHandler = async () => ({ rows: [] });
  demoIndustryFixture = null;
  throwOnGet = null;
}

afterAll(() => {
  mocks.cleanup();
});

// ── Auth tests ────────────────────────────────────────────────────────

describe("POST /api/v1/admin/archive-connection — auth", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    resetClient();
  });

  it("returns 403 when user is a member, not admin", async () => {
    mocks.setMember("org-alpha");
    const res = await app.fetch(makeReq("archive-connection", { connectionId: "warehouse" }));
    expect(res.status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    mocks.mockAuthenticateRequest.mockImplementationOnce(() =>
      Promise.resolve({
        authenticated: false,
        mode: "managed",
        status: 401,
        error: "Invalid API key",
      }),
    );
    const res = await app.fetch(makeReq("archive-connection", { connectionId: "warehouse" }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/admin/restore-connection — auth", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    resetClient();
  });

  it("returns 403 when user is a member, not admin", async () => {
    mocks.setMember("org-alpha");
    const res = await app.fetch(makeReq("restore-connection", { connectionId: "warehouse" }));
    expect(res.status).toBe(403);
  });
});

// ── Validation ────────────────────────────────────────────────────────

describe("POST /api/v1/admin/archive-connection — validation", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    resetClient();
    mocks.setOrgAdmin("org-alpha");
  });

  it("returns 422 when connectionId is missing", async () => {
    const res = await app.fetch(makeReq("archive-connection", {}));
    expect(res.status).toBe(422);
    expect(clientQueries.length).toBe(0);
  });

  it("returns 422 when connectionId is an empty string", async () => {
    const res = await app.fetch(makeReq("archive-connection", { connectionId: "" }));
    expect(res.status).toBe(422);
    expect(clientQueries.length).toBe(0);
  });

  it("returns 422 when connectionId is not a string", async () => {
    const res = await app.fetch(makeReq("archive-connection", { connectionId: 123 }));
    expect(res.status).toBe(422);
    expect(clientQueries.length).toBe(0);
  });
});

// ── Archive — cascade behaviour ───────────────────────────────────────

describe("POST /api/v1/admin/archive-connection — cascade", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    resetClient();
    mocks.setOrgAdmin("org-alpha");
  });

  it("archives __demo__ and cascades to entities + demo builtin prompts", async () => {
    // Pre-transaction read of ATLAS_DEMO_INDUSTRY via getSettingAuto cache
    demoIndustryFixture = "cybersecurity";

    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "published" }] };
      }
      if (/UPDATE\s+semantic_entities\s+SET\s+status\s*=\s*'archived'/i.test(sql)) {
        return {
          rows: [
            { id: "ent-cascade-1" },
            { id: "ent-cascade-2" },
            { id: "ent-cascade-3" },
          ],
        };
      }
      if (/UPDATE\s+prompt_collections\s+SET\s+status\s*=\s*'archived'/i.test(sql)) {
        return { rows: [{ id: "prompt-1" }, { id: "prompt-2" }] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      makeReq("archive-connection", { connectionId: "__demo__" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      archived: { connection: boolean; entities: number; prompts: number };
    };
    expect(body.archived.connection).toBe(true);
    expect(body.archived.entities).toBe(3);
    expect(body.archived.prompts).toBe(2);

    // Transaction lifecycle
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("COMMIT")).toBe(true);
    expect(sqls.includes("ROLLBACK")).toBe(false);
    expect(clientReleased).toBe(true);

    // Prompt cascade carries demo_industry param
    const promptUpdate = clientQueries.find((q) =>
      /UPDATE\s+prompt_collections\s+SET\s+status\s*=\s*'archived'/i.test(q.sql),
    );
    expect(promptUpdate).toBeDefined();
    expect((promptUpdate!.params as unknown[])).toContain("cybersecurity");
  });

  it("archives a non-demo connection + entities without touching prompts", async () => {
    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "published" }] };
      }
      if (/UPDATE\s+semantic_entities\s+SET\s+status\s*=\s*'archived'/i.test(sql)) {
        return { rows: [{ id: "ent-1" }, { id: "ent-2" }] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      makeReq("archive-connection", { connectionId: "warehouse" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      archived: { connection: boolean; entities: number; prompts: number };
    };
    expect(body.archived.connection).toBe(true);
    expect(body.archived.entities).toBe(2);
    expect(body.archived.prompts).toBe(0);

    // No prompt_collections UPDATE issued
    const promptUpdate = clientQueries.find((q) =>
      /UPDATE\s+prompt_collections/i.test(q.sql),
    );
    expect(promptUpdate).toBeUndefined();
  });

  it("every mutating statement is scoped by org_id", async () => {
    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "published" }] };
      }
      return { rows: [] };
    };
    await app.fetch(makeReq("archive-connection", { connectionId: "warehouse" }));

    const mutating = clientQueries.filter((q) => {
      const s = q.sql.toUpperCase();
      return (
        (s.includes("UPDATE") || s.includes("DELETE")) &&
        (s.includes("CONNECTIONS") ||
          s.includes("SEMANTIC_ENTITIES") ||
          s.includes("PROMPT_COLLECTIONS"))
      );
    });
    expect(mutating.length).toBeGreaterThan(0);
    for (const call of mutating) {
      expect((call.params as unknown[] | undefined)?.[0]).toBe("org-alpha");
    }
  });

  it("locks the connection row with SELECT ... FOR UPDATE before mutating", async () => {
    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "published" }] };
      }
      return { rows: [] };
    };
    await app.fetch(makeReq("archive-connection", { connectionId: "warehouse" }));
    const selectIdx = clientQueries.findIndex((q) =>
      /SELECT\s+status\s+FROM\s+connections[\s\S]*FOR\s+UPDATE/i.test(q.sql),
    );
    const firstUpdateIdx = clientQueries.findIndex((q) =>
      /UPDATE\s+(connections|semantic_entities|prompt_collections)/i.test(q.sql),
    );
    expect(selectIdx).toBeGreaterThan(-1);
    expect(firstUpdateIdx).toBeGreaterThan(selectIdx);
  });
});

// ── Archive — error paths ─────────────────────────────────────────────

describe("POST /api/v1/admin/archive-connection — errors", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    resetClient();
    mocks.setOrgAdmin("org-alpha");
  });

  it("returns 404 when the connection does not exist for the org", async () => {
    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    };
    const res = await app.fetch(
      makeReq("archive-connection", { connectionId: "nope" }),
    );
    expect(res.status).toBe(404);

    // The read-only transaction commits cleanly — a 404 is not a failure
    // (no work to undo), so pin COMMIT rather than accept either COMMIT
    // or ROLLBACK. A future refactor that silently ROLLBACKs on missing
    // rows would mask debugging signal.
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("COMMIT")).toBe(true);
    expect(sqls.includes("ROLLBACK")).toBe(false);
    expect(clientReleased).toBe(true);
  });

  it("is idempotent when already archived — cascades still run to reconcile stragglers", async () => {
    // Simulate a broken-invariant state: connection is already archived,
    // but one straggler entity is still 'published'. The helper should
    // report `connection: false` (the connection row didn't flip) AND
    // surface the reconciled cascade count.
    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "archived" }] };
      }
      if (/UPDATE\s+semantic_entities\s+SET\s+status\s*=\s*'archived'/i.test(sql)) {
        return { rows: [{ id: "straggler-1" }] };
      }
      return { rows: [] };
    };
    const res = await app.fetch(
      makeReq("archive-connection", { connectionId: "warehouse" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      archived: { connection: boolean; entities: number; prompts: number };
    };
    expect(body.archived.connection).toBe(false);
    expect(body.archived.entities).toBe(1);
    expect(body.archived.prompts).toBe(0);

    // No connection-row UPDATE (already archived)
    const connUpdate = clientQueries.find((q) =>
      /UPDATE\s+connections\s+SET\s+status\s*=\s*'archived'/i.test(q.sql),
    );
    expect(connUpdate).toBeUndefined();
    // But the entity cascade UPDATE did fire
    const entityUpdate = clientQueries.find((q) =>
      /UPDATE\s+semantic_entities\s+SET\s+status\s*=\s*'archived'/i.test(q.sql),
    );
    expect(entityUpdate).toBeDefined();
  });

  it("idempotent no-op when already archived and nothing to reconcile", async () => {
    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "archived" }] };
      }
      return { rows: [] };
    };
    const res = await app.fetch(
      makeReq("archive-connection", { connectionId: "warehouse" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      archived: { connection: boolean; entities: number; prompts: number };
    };
    expect(body.archived.connection).toBe(false);
    expect(body.archived.entities).toBe(0);
    expect(body.archived.prompts).toBe(0);
  });

  it("issues ROLLBACK and returns 500 when a mid-transaction statement fails", async () => {
    const rawErrorMessage = "simulated failure: connection pool exhausted";
    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "published" }] };
      }
      if (/^\s*UPDATE/i.test(sql)) {
        throw new Error(rawErrorMessage);
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      makeReq("archive-connection", { connectionId: "warehouse" }),
    );
    expect(res.status).toBe(500);

    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("ROLLBACK")).toBe(true);
    expect(sqls.includes("COMMIT")).toBe(false);
    expect(clientReleased).toBe(true);

    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.requestId).toBe("string");
    // Raw error must not leak
    expect(String(body.message ?? "")).not.toContain(rawErrorMessage);
    expect(String(body.message ?? "")).toContain("server logs");
  });

  it("returns 404 when the internal DB is not configured", async () => {
    mocks.hasInternalDB = false;
    const res = await app.fetch(
      makeReq("archive-connection", { connectionId: "warehouse" }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_available");
    mocks.hasInternalDB = true;
  });

  it("archive __demo__ with no demo_industry setting — skips prompt cascade, still returns 200", async () => {
    // readDemoIndustry returns { ok: true, value: null } when the setting
    // is unset. The endpoint proceeds without touching prompt_collections
    // (no UPDATE fires) and reports prompts: 0.
    demoIndustryFixture = null;

    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "published" }] };
      }
      if (/UPDATE\s+semantic_entities\s+SET\s+status\s*=\s*'archived'/i.test(sql)) {
        return { rows: [{ id: "ent-1" }] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      makeReq("archive-connection", { connectionId: "__demo__" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      archived: { connection: boolean; entities: number; prompts: number };
    };
    expect(body.archived.connection).toBe(true);
    expect(body.archived.entities).toBe(1);
    expect(body.archived.prompts).toBe(0);

    const promptUpdate = clientQueries.find((q) =>
      /UPDATE\s+prompt_collections/i.test(q.sql),
    );
    expect(promptUpdate).toBeUndefined();
  });

  it("archive __demo__ when demo_industry read throws — surfaces 500 (#1470), does NOT open the transaction", async () => {
    // readDemoIndustry now returns { ok: false, err } on a transient
    // settings read failure. The handler must 500 with a requestId rather
    // than silently committing with prompts: 0, which would leave demo
    // prompts stuck at `published` after an archive. No transaction must
    // be opened — the pre-transaction read is what failed.
    throwOnGet = new Error("transient settings read failure");

    const res = await app.fetch(
      makeReq("archive-connection", { connectionId: "__demo__" }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.requestId).toBe("string");
    // Raw cause must not leak
    expect(String(body.message ?? "")).not.toContain("transient settings");

    // No BEGIN — the failure happened before the transaction started
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("BEGIN")).toBe(false);
    expect(sqls.includes("ROLLBACK")).toBe(false);
    expect(sqls.includes("COMMIT")).toBe(false);
  });

  it("clean rollback — release() called with no argument (client safe to pool)", async () => {
    // Primary UPDATE fails, but ROLLBACK succeeds. Client is clean, so
    // release() must be called without an error arg.
    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "published" }] };
      }
      if (/^\s*UPDATE/i.test(sql)) {
        throw new Error("primary mutation failure");
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      makeReq("archive-connection", { connectionId: "warehouse" }),
    );
    expect(res.status).toBe(500);
    expect(clientReleased).toBe(true);
    expect(clientReleaseArg).toBeUndefined();
  });

  it("rollback-failure poisons the pool — release(err) destroys instead of returns (#1471)", async () => {
    // ROLLBACK itself throws after the primary mutation fails. The dirty
    // client must be passed to `release(err)` so node-postgres destroys
    // the socket rather than returning it to the pool (which would poison
    // the next borrower).
    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "published" }] };
      }
      if (/^\s*UPDATE/i.test(sql)) {
        throw new Error("primary mutation failure");
      }
      if (/^\s*ROLLBACK/i.test(sql)) {
        throw new Error("ROLLBACK failed — socket dirty");
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      makeReq("archive-connection", { connectionId: "warehouse" }),
    );
    expect(res.status).toBe(500);
    expect(clientReleased).toBe(true);
    // The argument to release() must be a Error instance — node-postgres
    // treats any truthy value as "destroy me".
    expect(clientReleaseArg).toBeInstanceOf(Error);
    expect((clientReleaseArg as Error).message).toContain("ROLLBACK failed");
  });
});

// ── Restore — cascade behaviour ───────────────────────────────────────

describe("POST /api/v1/admin/restore-connection — cascade", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    resetClient();
    mocks.setOrgAdmin("org-alpha");
  });

  it("restores __demo__ and brings entities + demo prompts back to published", async () => {
    demoIndustryFixture = "cybersecurity";

    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "archived" }] };
      }
      if (
        /UPDATE\s+semantic_entities\s+SET\s+status\s*=\s*'published'[\s\S]*status\s*=\s*'archived'/i.test(sql)
      ) {
        return {
          rows: [{ id: "ent-1" }, { id: "ent-2" }, { id: "ent-3" }],
        };
      }
      if (
        /UPDATE\s+prompt_collections\s+SET\s+status\s*=\s*'published'[\s\S]*status\s*=\s*'archived'/i.test(sql)
      ) {
        return { rows: [{ id: "prompt-1" }] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      makeReq("restore-connection", { connectionId: "__demo__" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      restored: { connection: boolean; entities: number; prompts: number };
    };
    expect(body.restored.connection).toBe(true);
    expect(body.restored.entities).toBe(3);
    expect(body.restored.prompts).toBe(1);

    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("COMMIT")).toBe(true);
    expect(clientReleased).toBe(true);
  });

  it("restores a non-demo connection + entities without touching prompts", async () => {
    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "archived" }] };
      }
      if (
        /UPDATE\s+semantic_entities\s+SET\s+status\s*=\s*'published'/i.test(sql)
      ) {
        return { rows: [{ id: "ent-1" }] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      makeReq("restore-connection", { connectionId: "warehouse" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      restored: { connection: boolean; entities: number; prompts: number };
    };
    expect(body.restored.connection).toBe(true);
    expect(body.restored.entities).toBe(1);
    expect(body.restored.prompts).toBe(0);

    // No prompt_collections UPDATE
    const promptUpdate = clientQueries.find((q) =>
      /UPDATE\s+prompt_collections/i.test(q.sql),
    );
    expect(promptUpdate).toBeUndefined();
  });
});

// ── Restore — error paths ─────────────────────────────────────────────

describe("POST /api/v1/admin/restore-connection — errors", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    resetClient();
    mocks.setOrgAdmin("org-alpha");
  });

  it("returns 404 when the connection does not exist", async () => {
    queryHandler = async () => ({ rows: [] });
    const res = await app.fetch(
      makeReq("restore-connection", { connectionId: "nope" }),
    );
    expect(res.status).toBe(404);

    // Read-only transaction commits cleanly even on a 404 (the SELECT
    // ran but found nothing). Pin COMMIT so a future silent-ROLLBACK
    // refactor gets caught.
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("COMMIT")).toBe(true);
    expect(sqls.includes("ROLLBACK")).toBe(false);
    expect(clientReleased).toBe(true);
  });

  it("returns 404 when the connection is not currently archived", async () => {
    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "published" }] };
      }
      return { rows: [] };
    };
    const res = await app.fetch(
      makeReq("restore-connection", { connectionId: "warehouse" }),
    );
    expect(res.status).toBe(404);

    // No restoration UPDATEs should fire
    const restoreUpdates = clientQueries.filter(
      (q) => /UPDATE\s+(connections|semantic_entities|prompt_collections)\s+SET\s+status\s*=\s*'published'/i.test(q.sql),
    );
    expect(restoreUpdates.length).toBe(0);

    // Transaction closes cleanly + client released
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("COMMIT")).toBe(true);
    expect(sqls.includes("ROLLBACK")).toBe(false);
    expect(clientReleased).toBe(true);
  });

  it("issues ROLLBACK and returns 500 when a mid-transaction statement fails", async () => {
    const rawErrorMessage = "simulated failure: entity cascade broken";
    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "archived" }] };
      }
      if (/UPDATE\s+semantic_entities/i.test(sql)) {
        throw new Error(rawErrorMessage);
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      makeReq("restore-connection", { connectionId: "warehouse" }),
    );
    expect(res.status).toBe(500);
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("ROLLBACK")).toBe(true);
    expect(sqls.includes("COMMIT")).toBe(false);
    expect(clientReleased).toBe(true);

    const body = (await res.json()) as Record<string, unknown>;
    // requestId is surfaced for log correlation
    expect(typeof body.requestId).toBe("string");
    expect(String(body.message ?? "")).not.toContain(rawErrorMessage);
    expect(String(body.message ?? "")).toContain("server logs");
  });

  it("returns 404 when the internal DB is not configured", async () => {
    mocks.hasInternalDB = false;
    const res = await app.fetch(
      makeReq("restore-connection", { connectionId: "warehouse" }),
    );
    expect(res.status).toBe(404);
    mocks.hasInternalDB = true;
  });

  it("restore __demo__ when demo_industry read throws — surfaces 500 (#1470)", async () => {
    throwOnGet = new Error("transient settings read failure");

    const res = await app.fetch(
      makeReq("restore-connection", { connectionId: "__demo__" }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.requestId).toBe("string");

    // No transaction opened
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("BEGIN")).toBe(false);
  });

  it("rollback-failure poisons the pool — release(err) destroys (#1471)", async () => {
    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "archived" }] };
      }
      if (/^\s*UPDATE/i.test(sql)) {
        throw new Error("primary mutation failure");
      }
      if (/^\s*ROLLBACK/i.test(sql)) {
        throw new Error("ROLLBACK failed — socket dirty");
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      makeReq("restore-connection", { connectionId: "warehouse" }),
    );
    expect(res.status).toBe(500);
    expect(clientReleased).toBe(true);
    expect(clientReleaseArg).toBeInstanceOf(Error);
    expect((clientReleaseArg as Error).message).toContain("ROLLBACK failed");
  });
});
