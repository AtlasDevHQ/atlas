/**
 * Application-level tests for the #1737 DB CHECK invariant at the
 * shareDashboard callsite.
 *
 * The DB constraint (chk_org_scoped_share, 0034) guarantees
 * share_mode='org' implies org_id IS NOT NULL. shareDashboard enforces
 * the same invariant at the application layer so the route returns a
 * structured `invalid_org_scope` reason instead of a Postgres error.
 *
 * Uses the _resetPool(mockPool) injection pattern from conversations.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { _resetPool, type InternalPool } from "../db/internal";
import { shareDashboard } from "../dashboards";

// ---------------------------------------------------------------------------
// Mock pool
// ---------------------------------------------------------------------------

let queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryResults: Array<{ rows: Record<string, unknown>[] }> = [];
let queryResultIndex = 0;
let queryThrow: Error | null = null;

const mockPool: InternalPool = {
  query: async (sql: string, params?: unknown[]) => {
    if (queryThrow) throw queryThrow;
    queryCalls.push({ sql, params });
    const result = queryResults[queryResultIndex] ?? { rows: [] };
    queryResultIndex++;
    return result;
  },
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
};

function enableInternalDB() {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  _resetPool(mockPool);
}

function setResults(...results: Array<{ rows: Record<string, unknown>[] }>) {
  queryResults = results;
  queryResultIndex = 0;
}

describe("dashboards sharing — #1737 invariant", () => {
  const origDbUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    queryResultIndex = 0;
    queryThrow = null;
    delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  afterEach(() => {
    if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
    else delete process.env.DATABASE_URL;
    _resetPool(null);
  });

  describe("shareDashboard()", () => {
    it("rejects shareMode='org' with invalid_org_scope when caller has no orgId (#1737)", async () => {
      enableInternalDB();

      const result = await shareDashboard("d1", { orgId: null }, { shareMode: "org" });
      expect(result).toEqual({ ok: false, reason: "invalid_org_scope" });
      // Short-circuited — no DB queries ran at all.
      expect(queryCalls).toHaveLength(0);
    });

    it("rejects shareMode='org' with invalid_org_scope when dashboard row has no org_id (#1737)", async () => {
      enableInternalDB();
      // First query is the preflight SELECT for the dashboard's org_id.
      setResults({ rows: [{ org_id: null }] });

      const result = await shareDashboard("d1", { orgId: "org-A" }, { shareMode: "org" });
      expect(result).toEqual({ ok: false, reason: "invalid_org_scope" });
      // Preflight ran, UPDATE did not.
      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].sql).toContain("SELECT org_id FROM dashboards");
    });

    it("returns not_found when the org-scoped share preflight finds no matching row", async () => {
      enableInternalDB();
      setResults({ rows: [] });

      const result = await shareDashboard("missing", { orgId: "org-A" }, { shareMode: "org" });
      expect(result).toEqual({ ok: false, reason: "not_found" });
      expect(queryCalls).toHaveLength(1);
    });

    it("proceeds with the UPDATE when org-scoped share is valid (dashboard has org_id)", async () => {
      enableInternalDB();
      setResults(
        { rows: [{ org_id: "org-A" }] },
        { rows: [{ share_token: "token-ok" }] },
      );

      const result = await shareDashboard("d1", { orgId: "org-A" }, { shareMode: "org" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.shareMode).toBe("org");
        expect(result.data.token).toBe("token-ok");
      }
      expect(queryCalls).toHaveLength(2);
      expect(queryCalls[0].sql).toContain("SELECT org_id FROM dashboards");
      expect(queryCalls[1].sql).toContain("UPDATE dashboards");
    });

    it("skips the preflight entirely for shareMode='public' (no extra query)", async () => {
      // Public shares don't need the org_id check — the invariant only
      // applies to share_mode='org'. Verify we don't pay the preflight
      // cost on the common path.
      enableInternalDB();
      setResults({ rows: [{ share_token: "public-tok" }] });

      const result = await shareDashboard("d1", { orgId: "org-A" }, { shareMode: "public" });
      expect(result.ok).toBe(true);
      // Exactly one query — the UPDATE.
      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].sql).toContain("UPDATE dashboards");
    });

    it("returns { ok: false, reason: 'no_db' } when no DB", async () => {
      const result = await shareDashboard("d1", { orgId: "org-A" }, { shareMode: "org" });
      expect(result).toEqual({ ok: false, reason: "no_db" });
    });

    it("returns { ok: false, reason: 'error' } when the preflight throws", async () => {
      enableInternalDB();
      queryThrow = new Error("connection lost");
      const result = await shareDashboard("d1", { orgId: "org-A" }, { shareMode: "org" });
      expect(result).toEqual({ ok: false, reason: "error" });
    });
  });
});
