/**
 * Unit tests for the draft cache seam (#4554, ADR-0034 Decision 1).
 *
 * Uses the `_resetPool(mockPool)` idiom (same as dashboard-versioning.test.ts)
 * to avoid `mock.module()`'s async-loader deadlock under bun's full suite —
 * see feedback_bun_test_async_mock_module.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { _resetPool, type InternalPool } from "../db/internal";
import {
  loadDraftCardCache,
  saveDraftCardCache,
  seedDraftCardCacheFromPublished,
  EMPTY_DRAFT_CARD_CACHE,
} from "../dashboard-draft-cache";

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
    throw new Error("not used in these tests");
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

describe("dashboard-draft-cache", () => {
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

  describe("loadDraftCardCache", () => {
    it("returns an empty map when the DB is unavailable", async () => {
      const map = await loadDraftCardCache("u1", "dash-1");
      expect(map.size).toBe(0);
    });

    it("maps rows by card id with parsed columns/rows and ISO cachedAt", async () => {
      enableInternalDB();
      setResults({
        rows: [
          {
            card_id: "c1",
            cached_columns: ["a"],
            cached_rows: [{ a: 1 }],
            cached_at: new Date("2026-07-01T00:00:00.000Z"),
          },
          {
            // JSONB occasionally arrives as a string — parsed defensively,
            // mirroring rowToCard.
            card_id: "c2",
            cached_columns: JSON.stringify(["b"]),
            cached_rows: JSON.stringify([{ b: 2 }]),
            cached_at: "2026-07-02T00:00:00.000Z",
          },
        ],
      });
      const map = await loadDraftCardCache("u1", "dash-1");
      expect(map.size).toBe(2);
      expect(map.get("c1")).toEqual({
        cachedColumns: ["a"],
        cachedRows: [{ a: 1 }],
        cachedAt: "2026-07-01T00:00:00.000Z",
      });
      expect(map.get("c2")).toEqual({
        cachedColumns: ["b"],
        cachedRows: [{ b: 2 }],
        cachedAt: "2026-07-02T00:00:00.000Z",
      });
      expect(queryCalls[0].sql).toContain("FROM dashboard_draft_card_cache");
      expect(queryCalls[0].params).toEqual(["u1", "dash-1"]);
    });

    it("fails soft to an empty map on a DB error (logged, not thrown)", async () => {
      enableInternalDB();
      queryThrow = new Error("connection refused");
      const map = await loadDraftCardCache("u1", "dash-1");
      expect(map.size).toBe(0);
    });
  });

  describe("saveDraftCardCache", () => {
    it("returns no_db when the internal DB is not configured", async () => {
      const result = await saveDraftCardCache("u1", "dash-1", "c1", { columns: [], rows: [] });
      expect(result).toEqual({ ok: false, reason: "no_db" });
    });

    it("upserts the entry guarded on the draft row existing and returns the persisted cachedAt", async () => {
      enableInternalDB();
      setResults({ rows: [{ card_id: "c1" }] });
      const result = await saveDraftCardCache("u1", "dash-1", "c1", {
        columns: ["a"],
        rows: [{ a: 1 }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The response instant is the SAME value bound into the row, so the
        // HTTP payload and the stored capture instant can never disagree.
        expect(result.cachedAt).toBe(String(queryCalls[0].params?.[5]));
      }
      const sql = queryCalls[0].sql;
      expect(sql).toContain("INSERT INTO dashboard_draft_card_cache");
      expect(sql).toContain("WHERE EXISTS");
      expect(sql).toContain("FROM dashboard_user_drafts");
      expect(sql).toContain("ON CONFLICT (user_id, dashboard_id, card_id)");
      // The write NEVER touches the published card cache.
      expect(sql).not.toContain("UPDATE dashboard_cards");
    });

    it("returns no_draft when no draft row exists for the caller", async () => {
      enableInternalDB();
      setResults({ rows: [] });
      const result = await saveDraftCardCache("u1", "dash-1", "c1", { columns: [], rows: [] });
      expect(result).toEqual({ ok: false, reason: "no_draft" });
    });

    it("returns error on a DB failure (logged, not thrown)", async () => {
      enableInternalDB();
      queryThrow = new Error("deadlock detected");
      const result = await saveDraftCardCache("u1", "dash-1", "c1", { columns: [], rows: [] });
      expect(result).toEqual({ ok: false, reason: "error" });
    });
  });

  describe("seedDraftCardCacheFromPublished", () => {
    it("no-ops when the DB is unavailable", async () => {
      await seedDraftCardCacheFromPublished("u1", "dash-1");
      expect(queryCalls.length).toBe(0);
    });

    it("copies published cards' cached data for the caller's draft, idempotently", async () => {
      enableInternalDB();
      setResults({ rows: [] });
      await seedDraftCardCacheFromPublished("u1", "dash-1");
      const sql = queryCalls[0].sql;
      expect(sql).toContain("INSERT INTO dashboard_draft_card_cache");
      expect(sql).toContain("JOIN dashboard_cards");
      // Only cards that actually have data get a row — "never run" stays the
      // absence of a row.
      expect(sql).toContain("cached_rows IS NOT NULL");
      // Idempotent: two tabs racing through the fork's create path converge.
      expect(sql).toContain("DO NOTHING");
      expect(queryCalls[0].params).toEqual(["u1", "dash-1"]);
    });

    it("fails soft on a DB error (fork proceeds, tiles degrade to never-run)", async () => {
      enableInternalDB();
      queryThrow = new Error("connection reset");
      await expect(seedDraftCardCacheFromPublished("u1", "dash-1")).resolves.toBeUndefined();
    });
  });

  it("EMPTY_DRAFT_CARD_CACHE is an empty map", () => {
    expect(EMPTY_DRAFT_CARD_CACHE.size).toBe(0);
  });
});
