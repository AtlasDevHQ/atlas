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
import { makeArchiveRestoreStubs } from "@atlas/api/testing/archive-restore";

// Controls the value `getSettingAuto("ATLAS_DEMO_INDUSTRY", orgId)` returns
// per test. `throwOnGet` simulates a transient settings cache failure so the
// route can surface 500 per issue #1470 (discriminated result).
// The `mock.module` override is registered AFTER createApiTestMocks below
// so it wins over the factory's default undefined-returning stub.
let demoIndustryFixture: string | null = null;
let throwOnGet: Error | null = null;

// ── Transactional client mock ─────────────────────────────────────────
// Each test captures the sequence of queries issued against the pool's
// checked-out client so we can assert BEGIN/COMMIT/ROLLBACK + per-step SQL.

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
// Captures the argument passed to `client.release(err?)`. node-postgres
// destroys the socket when this is truthy — asserted for issue #1471.
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

// Override the default settings mock from createApiTestMocks so tests
// can drive getSettingAuto("ATLAS_DEMO_INDUSTRY") via `demoIndustryFixture`
// and simulate a transient read failure via `throwOnGet`. Registered
// AFTER createApiTestMocks so this override wins.
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
  // Single-connection archive/restore helpers. Spread from the shared
  // factory so admin-publish.test.ts and admin-archive-restore.test.ts
  // stay in lockstep automatically.
  ...makeArchiveRestoreStubs(),
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
  clientReleaseArg = undefined;
  queryHandler = async () => ({ rows: [] });
  demoIndustryFixture = null;
  throwOnGet = null;
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
      archived: { connections: number; entities: number; prompts: number };
    };

    expect(body.promoted.entities).toBe(2);
    expect(body.promoted.connections).toBe(1);
    expect(body.promoted.prompts).toBe(1);
    // Deleted = 1 tombstoned-published row
    expect(body.deleted.entities).toBe(1);
    // No archive requested
    expect(body.archived.connections).toBe(0);
    expect(body.archived.entities).toBe(0);
    expect(body.archived.prompts).toBe(0);

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
    // Demo industry is read via getSettingAuto("ATLAS_DEMO_INDUSTRY", orgId)
    // — the canonical key (#1466). Prior code hit a lowercase SQL literal
    // which silently missed the row.
    demoIndustryFixture = "cybersecurity";

    queryHandler = async (sql) => {
      // Single-connection helper locks the row first — report "published"
      // so the cascade actually runs.
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "published" }] };
      }
      if (/UPDATE\s+connections\s+SET\s+status\s*=\s*'archived'/i.test(sql)) {
        return { rows: [{ id: "__demo__" }] };
      }
      // Cascade archives 3 entities for the archived connection
      if (
        /UPDATE\s+semantic_entities\s+SET\s+status\s*=\s*'archived'/i.test(sql)
      ) {
        return {
          rows: [
            { id: "ent-cascade-1" },
            { id: "ent-cascade-2" },
            { id: "ent-cascade-3" },
          ],
        };
      }
      // Cascade archives 2 built-in demo prompts
      if (
        /UPDATE\s+prompt_collections\s+SET\s+status\s*=\s*'archived'/i.test(sql)
      ) {
        return { rows: [{ id: "prompt-1" }, { id: "prompt-2" }] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(publishReq({ archiveConnections: ["__demo__"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      archived: { connections: number; entities: number; prompts: number };
    };
    expect(body.archived.connections).toBe(1);
    // Cascade counts reflect the UPDATE ... RETURNING rowcounts. Concrete
    // values — a bare `>= 0` would be tautological (zod already enforces
    // `z.number().int().nonnegative()` on the response schema).
    expect(body.archived.entities).toBe(3);
    expect(body.archived.prompts).toBe(2);

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
    demoIndustryFixture = "cybersecurity";

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
    const body = (await res.json()) as {
      archived: { connections: number; entities: number; prompts: number };
    };
    expect(body.archived.connections).toBe(0);
    expect(body.archived.entities).toBe(0);
    expect(body.archived.prompts).toBe(0);

    const archiveConnSql = clientQueries.find(
      (q) => /UPDATE\s+connections\s+SET\s+status\s*=\s*'archived'/i.test(q.sql),
    );
    expect(archiveConnSql).toBeUndefined();
  });

  it("loops over multiple archive ids, locking and cascading each", async () => {
    // After the #1437 refactor publish loops archiveSingleConnection per
    // id. A bug that early-returns after the first id would let the
    // second connection stay published. Verify both connections' lock +
    // UPDATE pair fire.
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "published" }] };
      }
      if (/UPDATE\s+connections\s+SET\s+status\s*=\s*'archived'/i.test(sql)) {
        return { rows: [{ id: "x" }] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      publishReq({ archiveConnections: ["warehouse", "legacy"] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      archived: { connections: number; entities: number; prompts: number };
    };
    expect(body.archived.connections).toBe(2);

    const locks = clientQueries.filter((q) =>
      /SELECT\s+status\s+FROM\s+connections[\s\S]*FOR\s+UPDATE/i.test(q.sql),
    );
    expect(locks.length).toBe(2);
    const lockedIds = locks.map((q) => (q.params as unknown[])[1]);
    expect(lockedIds).toContain("warehouse");
    expect(lockedIds).toContain("legacy");
  });

  it("rolls back atomically when a later archive id in the loop fails", async () => {
    // First id locks + archives fine, second id throws during entity
    // cascade. The whole publish transaction must ROLLBACK — no partial
    // commit from the first id survives.
    mocks.mockInternalQuery.mockImplementation(() => Promise.resolve([]));
    let lockCalls = 0;
    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        lockCalls++;
        return { rows: [{ status: "published" }] };
      }
      if (/UPDATE\s+semantic_entities\s+SET\s+status\s*=\s*'archived'/i.test(sql)) {
        if (lockCalls === 2) {
          throw new Error("cascade failure on second id");
        }
        return { rows: [] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      publishReq({ archiveConnections: ["first", "second"] }),
    );
    expect(res.status).toBe(500);

    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("ROLLBACK")).toBe(true);
    expect(sqls.includes("COMMIT")).toBe(false);
  });

  it("archive loop: already-archived id reconciles stragglers without bumping connection count", async () => {
    // An id in archiveConnections is already `archived` but still has
    // straggler entities stuck at `published` and built-in demo prompts
    // in the same state. archiveSingleConnection should NOT flip the
    // connection row (it's already archived) but SHOULD still cascade
    // and return non-zero counts. Publish must accumulate those counts
    // into archived.entities / archived.prompts while keeping
    // archived.connections at 0, and emit the "cascade reconciled" warn.
    demoIndustryFixture = "cybersecurity";

    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        // Already archived — helper will NOT run the connection UPDATE
        return { rows: [{ status: "archived" }] };
      }
      if (/UPDATE\s+semantic_entities\s+SET\s+status\s*=\s*'archived'/i.test(sql)) {
        return { rows: [{ id: "straggler-1" }, { id: "straggler-2" }] };
      }
      if (/UPDATE\s+prompt_collections\s+SET\s+status\s*=\s*'archived'/i.test(sql)) {
        return { rows: [{ id: "prompt-straggler-1" }] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(publishReq({ archiveConnections: ["__demo__"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      archived: { connections: number; entities: number; prompts: number };
    };
    // Connection row didn't flip — no bump
    expect(body.archived.connections).toBe(0);
    // But cascade reconciliation surfaces in both counts
    expect(body.archived.entities).toBe(2);
    expect(body.archived.prompts).toBe(1);

    // No connection UPDATE (the helper skips it when already archived)
    const connUpdate = clientQueries.find((q) =>
      /UPDATE\s+connections\s+SET\s+status\s*=\s*'archived'/i.test(q.sql),
    );
    expect(connUpdate).toBeUndefined();
    // Transaction still commits cleanly
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("COMMIT")).toBe(true);
    expect(sqls.includes("ROLLBACK")).toBe(false);
  });

  it("archive loop: not_found id does not abort the loop — subsequent ids still process", async () => {
    // First id is not_found; second is published and should still
    // archive. The `not_found` branch must continue, not short-circuit.
    let lockCalls = 0;
    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        lockCalls++;
        // First id: missing; second id: published
        return lockCalls === 1 ? { rows: [] } : { rows: [{ status: "published" }] };
      }
      if (/UPDATE\s+connections\s+SET\s+status\s*=\s*'archived'/i.test(sql)) {
        return { rows: [{ id: "real-id" }] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(
      publishReq({ archiveConnections: ["typo-id", "real-id"] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      archived: { connections: number; entities: number; prompts: number };
    };
    // Only the second id archived; the first was not_found and skipped
    expect(body.archived.connections).toBe(1);

    // Both ids got locked (loop didn't early-exit)
    const lockParams = clientQueries
      .filter((q) =>
        /SELECT\s+status\s+FROM\s+connections[\s\S]*FOR\s+UPDATE/i.test(q.sql),
      )
      .map((q) => (q.params as unknown[])[1]);
    expect(lockParams).toEqual(["typo-id", "real-id"]);

    // Transaction commits — publish is best-effort for the archive list
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("COMMIT")).toBe(true);
    expect(sqls.includes("ROLLBACK")).toBe(false);
  });
});

describe("POST /api/v1/admin/publish — demo industry read (#1466, #1470)", () => {
  beforeEach(() => {
    mocks.hasInternalDB = true;
    mocks.mockInternalQuery.mockReset();
    mocks.mockInternalQuery.mockResolvedValue([]);
    resetClient();
    mocks.setOrgAdmin("org-alpha");
  });

  it("reads ATLAS_DEMO_INDUSTRY (canonical key) via the settings cache — not a lowercase SQL literal (#1466)", async () => {
    // Regression guard for #1466. Prior code queried `SELECT value FROM
    // settings WHERE key = 'demo_industry'` — the lowercase key never
    // matched the canonical `ATLAS_DEMO_INDUSTRY` row, so publish silently
    // skipped archiving built-in demo prompts. Now the route must call
    // getSettingAuto("ATLAS_DEMO_INDUSTRY", orgId), pick up "cybersecurity",
    // and pass it through to the prompt-collections UPDATE.
    demoIndustryFixture = "cybersecurity";

    queryHandler = async (sql) => {
      if (/SELECT\s+status\s+FROM\s+connections/i.test(sql)) {
        return { rows: [{ status: "published" }] };
      }
      if (/UPDATE\s+connections\s+SET\s+status\s*=\s*'archived'/i.test(sql)) {
        return { rows: [{ id: "__demo__" }] };
      }
      if (/UPDATE\s+prompt_collections\s+SET\s+status\s*=\s*'archived'/i.test(sql)) {
        return { rows: [{ id: "prompt-1" }] };
      }
      return { rows: [] };
    };

    const res = await app.fetch(publishReq({ archiveConnections: ["__demo__"] }));
    expect(res.status).toBe(200);

    // The pre-transaction read must NOT hit the settings table directly.
    // Route pulls from the cache via getSettingAuto — internalQuery should
    // never see a demo_industry query.
    const calls = mocks.mockInternalQuery.mock.calls.map((c) => String(c[0] ?? ""));
    expect(calls.some((sql) => /demo_industry/i.test(sql))).toBe(false);

    // Prompt cascade fired with the industry parameter
    const archivePromptsSql = clientQueries.find((q) =>
      /UPDATE\s+prompt_collections\s+SET\s+status\s*=\s*'archived'/i.test(q.sql),
    );
    expect(archivePromptsSql).toBeDefined();
    expect((archivePromptsSql!.params as unknown[])).toContain("cybersecurity");
  });

  it("surfaces 500 when the settings read fails — does NOT open the transaction (#1470)", async () => {
    // readDemoIndustry now returns a discriminated { ok: false, err }.
    // Callers must 500 rather than silently committing with prompts: 0 —
    // that would leave demo prompts stranded at `published` after publish.
    throwOnGet = new Error("transient cache read failure");

    const res = await app.fetch(publishReq({ archiveConnections: ["__demo__"] }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.requestId).toBe("string");
    // Raw cause must not leak to the caller
    expect(String(body.message ?? "")).not.toContain("transient cache read failure");

    // Transaction must not open — the failure is pre-transaction
    const sqls = clientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqls.includes("BEGIN")).toBe(false);
    expect(sqls.includes("ROLLBACK")).toBe(false);
  });

  it("does NOT read demo industry when archiveConnections excludes __demo__", async () => {
    // Only runs the read when __demo__ is being archived — otherwise the
    // setting is irrelevant to this publish.
    throwOnGet = new Error("should not be called");

    const res = await app.fetch(publishReq({ archiveConnections: ["warehouse"] }));
    // Must 200 — the settings read was never attempted
    expect(res.status).toBe(200);
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
    const rawErrorMessage = "simulated failure: draft_delete index corrupted";
    queryHandler = async (sql) => {
      // Let BEGIN pass, fail on the first DELETE
      if (/^\s*DELETE/i.test(sql)) {
        throw new Error(rawErrorMessage);
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
    // The raw pg error message must NOT leak to the client — only generic copy
    expect(String(body.message ?? "")).not.toContain(rawErrorMessage);
    expect(String(body.message ?? "")).toContain("See server logs");
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

  it("rollback-failure poisons the pool — release(err) destroys the client (#1471)", async () => {
    // Primary mutation throws, then ROLLBACK itself throws (broken socket).
    // The handler must pass the rollback error to `client.release(err)` so
    // node-postgres destroys the socket rather than returning a dirty
    // client to the pool.
    queryHandler = async (sql) => {
      if (/^\s*DELETE/i.test(sql)) {
        throw new Error("primary mutation failure");
      }
      if (/^\s*ROLLBACK/i.test(sql)) {
        throw new Error("ROLLBACK failed — socket dirty");
      }
      return { rows: [] };
    };

    const res = await app.fetch(publishReq());
    expect(res.status).toBe(500);
    expect(clientReleased).toBe(true);
    expect(clientReleaseArg).toBeInstanceOf(Error);
    expect((clientReleaseArg as Error).message).toContain("ROLLBACK failed");
  });

  it("clean rollback (ROLLBACK succeeds) — release() called without an error arg", async () => {
    // When ROLLBACK succeeds, the client is still safe to pool. release()
    // must be called with no argument so node-postgres returns the client
    // to the pool normally.
    queryHandler = async (sql) => {
      if (/^\s*DELETE/i.test(sql)) {
        throw new Error("primary mutation failure");
      }
      return { rows: [] };
    };

    const res = await app.fetch(publishReq());
    expect(res.status).toBe(500);
    expect(clientReleased).toBe(true);
    // release() called with no arg means "return to pool" — the client is
    // clean because ROLLBACK succeeded.
    expect(clientReleaseArg).toBeUndefined();
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
