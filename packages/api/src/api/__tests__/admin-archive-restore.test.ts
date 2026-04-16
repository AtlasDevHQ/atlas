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

// ── Transactional client mock ─────────────────────────────────────────

interface ClientQuery {
  sql: string;
  params?: unknown[];
}

interface MockClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  release: () => void;
}

let clientQueries: ClientQuery[] = [];
let clientReleased = false;
let queryHandler: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> = async () => ({ rows: [] });

function makeMockClient(): MockClient {
  return {
    query: async (sql: string, params?: unknown[]) => {
      clientQueries.push({ sql, params });
      return queryHandler(sql, params);
    },
    release: () => {
      clientReleased = true;
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

// Full-fidelity stubs for the archive/restore helpers — mirrors the real
// implementation in packages/api/src/lib/semantic/entities.ts and is kept
// in sync with the signature there. We want the endpoint to issue actual
// SQL against our mock client so we can assert BEGIN/COMMIT/ROLLBACK and
// cascade ordering.
mock.module("@atlas/api/lib/semantic/entities", () => {
  const DEMO_CONNECTION_ID = "__demo__";

  return {
    // Default no-ops for non-publish helpers
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
    DEMO_CONNECTION_ID,

    applyTombstones: mock(() => Promise.resolve(0)),
    promoteDraftEntities: mock(() => Promise.resolve(0)),
    archiveConnectionsAndEntities: mock(() =>
      Promise.resolve({ connections: 0, entities: 0 }),
    ),

    archiveSingleConnection: async (
      client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
      orgId: string,
      connectionId: string,
      opts?: { demoIndustry?: string | null },
    ) => {
      const current = await client.query(
        `SELECT status FROM connections WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, connectionId],
      );
      if (current.rows.length === 0) return { status: "not_found" as const };
      const row = current.rows[0] as { status: string };
      if (row.status === "archived") {
        return { status: "already_archived" as const };
      }
      await client.query(
        `UPDATE connections SET status = 'archived', updated_at = now()
         WHERE org_id = $1 AND id = $2`,
        [orgId, connectionId],
      );
      const archivedEntities = await client.query(
        `UPDATE semantic_entities SET status = 'archived', updated_at = now()
         WHERE org_id = $1 AND connection_id = $2 AND status = 'published'
         RETURNING id`,
        [orgId, connectionId],
      );
      let prompts = 0;
      if (connectionId === DEMO_CONNECTION_ID && opts?.demoIndustry) {
        const archivedPrompts = await client.query(
          `UPDATE prompt_collections SET status = 'archived', updated_at = now()
           WHERE org_id = $1 AND is_builtin = true AND status = 'published' AND industry = $2
           RETURNING id`,
          [orgId, opts.demoIndustry],
        );
        prompts = archivedPrompts.rows.length;
      }
      return {
        status: "archived" as const,
        entities: archivedEntities.rows.length,
        prompts,
      };
    },

    restoreSingleConnection: async (
      client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
      orgId: string,
      connectionId: string,
      opts?: { demoIndustry?: string | null },
    ) => {
      const current = await client.query(
        `SELECT status FROM connections WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, connectionId],
      );
      if (current.rows.length === 0) return { status: "not_found" as const };
      const row = current.rows[0] as { status: string };
      if (row.status !== "archived") {
        return { status: "not_archived" as const };
      }
      await client.query(
        `UPDATE connections SET status = 'published', updated_at = now()
         WHERE org_id = $1 AND id = $2 AND status = 'archived'`,
        [orgId, connectionId],
      );
      const restoredEntities = await client.query(
        `UPDATE semantic_entities SET status = 'published', updated_at = now()
         WHERE org_id = $1 AND connection_id = $2 AND status = 'archived'
         RETURNING id`,
        [orgId, connectionId],
      );
      let prompts = 0;
      if (connectionId === DEMO_CONNECTION_ID && opts?.demoIndustry) {
        const restoredPrompts = await client.query(
          `UPDATE prompt_collections SET status = 'published', updated_at = now()
           WHERE org_id = $1 AND is_builtin = true AND status = 'archived' AND industry = $2
           RETURNING id`,
          [orgId, opts.demoIndustry],
        );
        prompts = restoredPrompts.rows.length;
      }
      return {
        status: "restored" as const,
        entities: restoredEntities.rows.length,
        prompts,
      };
    },
  };
});

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
  queryHandler = async () => ({ rows: [] });
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
    // Pre-transaction read of demo_industry
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("demo_industry")) {
        return Promise.resolve([{ value: "cybersecurity" }]);
      }
      return Promise.resolve([]);
    });

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

    // Still committed (no mutations happened, but transaction closed cleanly)
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("COMMIT") || sqls.includes("ROLLBACK")).toBe(true);
    expect(clientReleased).toBe(true);
  });

  it("is idempotent (200 with zeroed cascade) when already archived", async () => {
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

    // No cascading UPDATE should fire
    const mutating = clientQueries.filter((q) => /^\s*UPDATE/i.test(q.sql));
    expect(mutating.length).toBe(0);
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
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("demo_industry")) {
        return Promise.resolve([{ value: "cybersecurity" }]);
      }
      return Promise.resolve([]);
    });

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
    expect(String(body.message ?? "")).not.toContain(rawErrorMessage);
  });

  it("returns 404 when the internal DB is not configured", async () => {
    mocks.hasInternalDB = false;
    const res = await app.fetch(
      makeReq("restore-connection", { connectionId: "warehouse" }),
    );
    expect(res.status).toBe(404);
    mocks.hasInternalDB = true;
  });
});
