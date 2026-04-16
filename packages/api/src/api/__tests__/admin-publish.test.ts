/**
 * Tests for POST /api/v1/admin/publish — atomic promotion endpoint (#1429).
 *
 * Verifies:
 * 1. A mixed state (drafts + tombstones + published) publishes cleanly
 * 2. archiveConnections archives connections and cascades to their entities
 *    and demo prompt collections
 * 3. A mid-transaction failure triggers ROLLBACK (no partial commit)
 * 4. Non-admin users get 403
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// ── Transactional client mock ─────────────────────────────────────────
// Each test captures the sequence of queries issued against the pool's
// checked-out client so we can assert BEGIN/COMMIT/ROLLBACK + per-step SQL.

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

// ── Mocks ──────────────────────────────────────────────────────────────

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

// Override the semantic/entities mock with full-fidelity stubs matching
// the real helper signatures. The factory mocks semantic/entities with
// no-ops — we want the publish helpers to actually issue SQL against
// our transactional client so we can assert the BEGIN → work → COMMIT
// sequence via `clientQueries`. These stubs mirror the real helpers in
// packages/api/src/lib/semantic/entities.ts — update together.
mock.module("@atlas/api/lib/semantic/entities", () => ({
  // existing mocks still need to be present (mock.module replaces all exports)
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
  // Publish helpers — real logic, executed against the caller's client
  applyTombstones: async (
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    orgId: string,
  ): Promise<number> => {
    const res = await client.query(
      `DELETE FROM semantic_entities p
       USING semantic_entities d
       WHERE p.org_id = $1 AND p.status = 'published'
         AND d.org_id = p.org_id
         AND d.name = p.name
         AND COALESCE(d.connection_id, '__default__') = COALESCE(p.connection_id, '__default__')
         AND d.status = 'draft_delete'
       RETURNING p.id`,
      [orgId],
    );
    await client.query(
      `DELETE FROM semantic_entities WHERE org_id = $1 AND status = 'draft_delete'`,
      [orgId],
    );
    return res.rows.length;
  },
  promoteDraftEntities: async (
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    orgId: string,
  ): Promise<number> => {
    await client.query(
      `DELETE FROM semantic_entities p
       USING semantic_entities d
       WHERE p.org_id = $1 AND p.status = 'published'
         AND d.org_id = p.org_id
         AND d.name = p.name
         AND COALESCE(d.connection_id, '__default__') = COALESCE(p.connection_id, '__default__')
         AND d.status = 'draft'`,
      [orgId],
    );
    const res = await client.query(
      `UPDATE semantic_entities SET status = 'published', updated_at = now()
       WHERE org_id = $1 AND status = 'draft'
       RETURNING id`,
      [orgId],
    );
    return res.rows.length;
  },
  archiveConnectionsAndEntities: async (
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    orgId: string,
    ids: readonly string[],
  ): Promise<number> => {
    if (ids.length === 0) return 0;
    const res = await client.query(
      `UPDATE connections SET status = 'archived', updated_at = now()
       WHERE org_id = $1 AND id = ANY($2::text[])
       RETURNING id`,
      [orgId, ids],
    );
    await client.query(
      `UPDATE semantic_entities SET status = 'archived', updated_at = now()
       WHERE org_id = $1 AND connection_id = ANY($2::text[]) AND status = 'published'`,
      [orgId, ids],
    );
    return res.rows.length;
  },
}));

// ── Import app AFTER mocks ────────────────────────────────────────────

const { app } = await import("../index");

// ── Helpers ────────────────────────────────────────────────────────────

function publishReq(body?: unknown, cookie?: string): Request {
  const headers: Record<string, string> = {
    Authorization: "Bearer test-key",
    "Content-Type": "application/json",
  };
  if (cookie) headers.Cookie = cookie;
  return new Request("http://localhost/api/v1/admin/publish", {
    method: "POST",
    headers,
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

// ── Tests ──────────────────────────────────────────────────────────────

describe("POST /api/v1/admin/publish — auth", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    resetClient();
  });

  it("returns 403 when user is a member, not admin", async () => {
    mocks.setMember("org-alpha");
    const res = await app.fetch(publishReq());
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
    const res = await app.fetch(publishReq());
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/admin/publish — atomic promotion", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    resetClient();
    mocks.setOrgAdmin("org-alpha");
  });

  it("applies tombstones, promotes drafts, and returns a summary", async () => {
    // Track how many rows each step affects via rowCount responses
    queryHandler = async (sql) => {
      // Step 1a: DELETE published rows targeted by tombstones
      if (/DELETE\s+FROM\s+semantic_entities[\s\S]*draft_delete/i.test(sql) && sql.includes("USING")) {
        // 1 tombstone hides 1 published row
        return { rows: [{ id: "ent-published-deleted-1" }] };
      }
      // Step 1b: DELETE the tombstones themselves
      if (/DELETE\s+FROM\s+semantic_entities[\s\S]*status\s*=\s*'draft_delete'/i.test(sql) && !sql.includes("USING")) {
        return { rows: [{ id: "ent-tombstone-1" }] };
      }
      // Step 2: DELETE published rows superseded by drafts
      if (/DELETE\s+FROM\s+semantic_entities[\s\S]*status\s*=\s*'draft'/i.test(sql) && sql.includes("USING")) {
        // 1 draft supersedes 1 published row
        return { rows: [{ id: "ent-published-superseded-1" }] };
      }
      // Step 3a: UPDATE draft entities -> published
      if (/UPDATE\s+semantic_entities\s+SET\s+status\s*=\s*'published'/i.test(sql)) {
        // 2 drafts promoted
        return { rows: [{ id: "ent-draft-1" }, { id: "ent-draft-2" }] };
      }
      // Step 3b: UPDATE connections draft -> published
      if (/UPDATE\s+connections\s+SET\s+status\s*=\s*'published'/i.test(sql)) {
        return { rows: [{ id: "conn-draft-1" }] };
      }
      // Step 3c: UPDATE prompt_collections draft -> published
      if (/UPDATE\s+prompt_collections\s+SET\s+status\s*=\s*'published'/i.test(sql)) {
        return { rows: [{ id: "prompt-draft-1" }] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(publishReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      promoted: { connections: number; entities: number; prompts: number };
      deleted: { entities: number };
      archived: { connections: number };
    };

    expect(body.promoted.entities).toBe(2);
    expect(body.promoted.connections).toBe(1);
    expect(body.promoted.prompts).toBe(1);
    // Deleted = 1 tombstoned-published row
    expect(body.deleted.entities).toBe(1);
    // No archive requested
    expect(body.archived.connections).toBe(0);

    // Transaction lifecycle
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("COMMIT")).toBe(true);
    expect(sqls.includes("ROLLBACK")).toBe(false);
    expect(clientReleased).toBe(true);
  });

  it("every mutating statement is scoped by org_id", async () => {
    await app.fetch(publishReq());

    // Every DELETE/UPDATE on a content table must include $1 = orgId
    const mutatingCalls = clientQueries.filter((q) => {
      const s = q.sql.toUpperCase();
      return (
        (s.includes("DELETE") || s.includes("UPDATE")) &&
        (s.includes("SEMANTIC_ENTITIES") || s.includes("CONNECTIONS") || s.includes("PROMPT_COLLECTIONS"))
      );
    });
    expect(mutatingCalls.length).toBeGreaterThan(0);
    for (const call of mutatingCalls) {
      // orgId should be the first param
      expect((call.params as unknown[] | undefined)?.[0]).toBe("org-alpha");
    }
  });

  it("calls BEGIN then 4 phases of work then COMMIT", async () => {
    await app.fetch(publishReq());
    const sqls = clientQueries.map((q) => q.sql.trim());
    expect(sqls[0].toUpperCase()).toBe("BEGIN");
    expect(sqls[sqls.length - 1].toUpperCase()).toBe("COMMIT");
  });

  it("rejects invalid archiveConnections shape with 422 (e.g. non-array)", async () => {
    const res = await app.fetch(publishReq({ archiveConnections: "not-an-array" }));
    expect(res.status).toBe(422);
    // No transaction should have been opened
    expect(clientQueries.length).toBe(0);
  });

  it("rejects archiveConnections with non-string entries with 422", async () => {
    const res = await app.fetch(publishReq({ archiveConnections: [123, null] }));
    expect(res.status).toBe(422);
    expect(clientQueries.length).toBe(0);
  });
});

describe("POST /api/v1/admin/publish — archiveConnections", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    resetClient();
    mocks.setOrgAdmin("org-alpha");
  });

  it("archives listed connections, cascades entities, and archives demo prompts", async () => {
    // Mock internalQuery used to read demo_industry setting (outside txn)
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("demo_industry")) {
        return Promise.resolve([{ value: "cybersecurity" }]);
      }
      return Promise.resolve([]);
    });

    queryHandler = async (sql) => {
      if (/UPDATE\s+connections\s+SET\s+status\s*=\s*'archived'/i.test(sql)) {
        return { rows: [{ id: "__demo__" }] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(publishReq({ archiveConnections: ["__demo__"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      archived: { connections: number };
    };
    expect(body.archived.connections).toBe(1);

    // Assert three archive statements fired in the transaction
    const archiveConnSql = clientQueries.find(
      (q) => /UPDATE\s+connections\s+SET\s+status\s*=\s*'archived'/i.test(q.sql),
    );
    expect(archiveConnSql).toBeDefined();
    expect((archiveConnSql!.params as unknown[])).toContain("org-alpha");

    const archiveEntitiesSql = clientQueries.find(
      (q) => /UPDATE\s+semantic_entities\s+SET\s+status\s*=\s*'archived'/i.test(q.sql),
    );
    expect(archiveEntitiesSql).toBeDefined();

    // When demo_industry is set, builtin demo prompts for that industry are archived
    const archivePromptsSql = clientQueries.find(
      (q) => /UPDATE\s+prompt_collections\s+SET\s+status\s*=\s*'archived'/i.test(q.sql),
    );
    expect(archivePromptsSql).toBeDefined();
    // Industry passed as a parameter
    const params = (archivePromptsSql!.params as unknown[]) ?? [];
    expect(params).toContain("cybersecurity");
  });

  it("skips prompt-archival step when the __demo__ connection is NOT in archiveConnections", async () => {
    mocks.mockInternalQuery.mockImplementation((sql: string) => {
      if (sql.includes("demo_industry")) {
        return Promise.resolve([{ value: "cybersecurity" }]);
      }
      return Promise.resolve([]);
    });

    const res = await app.fetch(publishReq({ archiveConnections: ["warehouse"] }));
    expect(res.status).toBe(200);

    const archivePromptsSql = clientQueries.find(
      (q) => /UPDATE\s+prompt_collections\s+SET\s+status\s*=\s*'archived'/i.test(q.sql),
    );
    expect(archivePromptsSql).toBeUndefined();
  });

  it("accepts an empty archiveConnections array as a no-op", async () => {
    const res = await app.fetch(publishReq({ archiveConnections: [] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { archived: { connections: number } };
    expect(body.archived.connections).toBe(0);

    const archiveConnSql = clientQueries.find(
      (q) => /UPDATE\s+connections\s+SET\s+status\s*=\s*'archived'/i.test(q.sql),
    );
    expect(archiveConnSql).toBeUndefined();
  });
});

describe("POST /api/v1/admin/publish — atomicity", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    resetClient();
    mocks.setOrgAdmin("org-alpha");
  });

  it("issues ROLLBACK and returns 500 when a mid-transaction statement fails", async () => {
    queryHandler = async (sql) => {
      // Let BEGIN pass, fail on the first DELETE
      if (/^\s*DELETE/i.test(sql)) {
        throw new Error("simulated failure: draft_delete index corrupted");
      }
      return { rows: [] };
    };

    const res = await app.fetch(publishReq());
    expect(res.status).toBe(500);

    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.includes("ROLLBACK")).toBe(true);
    expect(sqls.includes("COMMIT")).toBe(false);
    // Client must still be released even on failure
    expect(clientReleased).toBe(true);

    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.requestId).toBe("string");
  });

  it("includes requestId in the 500 response body", async () => {
    queryHandler = async (sql) => {
      if (/^\s*UPDATE/i.test(sql)) {
        throw new Error("simulated UPDATE failure");
      }
      return { rows: [] };
    };
    const res = await app.fetch(publishReq());
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.requestId).toBeDefined();
    expect(typeof body.requestId).toBe("string");
  });
});

describe("POST /api/v1/admin/publish — internal DB unavailable", () => {
  beforeEach(() => {
    resetClient();
    mocks.setOrgAdmin("org-alpha");
  });

  it("returns 404 when the internal DB is not configured", async () => {
    mocks.hasInternalDB = false;
    const res = await app.fetch(publishReq());
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_available");
    mocks.hasInternalDB = true;
  });
});
