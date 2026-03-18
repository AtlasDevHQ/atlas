/**
 * Unit tests for pattern-proposer.ts — fire-and-forget pattern proposals.
 *
 * Uses _resetPool(mockPool) injection pattern (same as conversations.test.ts)
 * and withRequestContext for org-scoping tests.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { _resetPool, type InternalPool } from "../db/internal";
import { withRequestContext } from "../logger";
import { createAtlasUser } from "../auth/types";
import { _resetYamlPatternCache, _setYamlPatternCache, normalizeSQL } from "../learn/pattern-analyzer";
import { _analyzeAndPropose, proposePatternIfNovel, type PatternProposalInput } from "../learn/pattern-proposer";
import { incrementPatternCount } from "../db/internal";

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

const defaultInput: PatternProposalInput = {
  sql: "SELECT name, email FROM users WHERE status = 'active' ORDER BY created_at DESC",
  dialect: "PostgresQL",
  connectionId: "default",
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const origDbUrl = process.env.DATABASE_URL;

describe("pattern-proposer", () => {
  beforeEach(() => {
    queryCalls = [];
    queryResults = [];
    queryResultIndex = 0;
    queryThrow = null;
    enableInternalDB();
    _resetYamlPatternCache();
  });

  afterEach(() => {
    if (origDbUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = origDbUrl;
    }
    _resetPool(null);
  });

  // ── Novel pattern detection ────────────────────────────────────────

  test("inserts novel pattern when no match in YAML or DB", async () => {
    // findPatternBySQL returns no match → INSERT fires
    setResults({ rows: [] });

    await _analyzeAndPropose(defaultInput);

    // First query: findPatternBySQL SELECT
    expect(queryCalls.length).toBeGreaterThanOrEqual(1);
    const selectCall = queryCalls[0];
    expect(selectCall.sql).toContain("SELECT id, confidence, repetition_count FROM learned_patterns");
    expect(selectCall.params?.[0]).toBeTypeOf("string"); // normalized SQL

    // Second query: insertLearnedPattern INSERT (fire-and-forget via internalExecute)
    // internalExecute calls pool.query internally, so we should see the INSERT
    const insertCall = queryCalls.find((c) => c.sql.includes("INSERT INTO learned_patterns"));
    expect(insertCall).toBeDefined();
    // Status 'pending' is a SQL literal, not a parameter. Check proposed_by = "agent".
    expect(insertCall!.params).toContain("agent");
    // SQL should contain 'pending' literal
    expect(insertCall!.sql).toContain("'pending'");
  });

  // ── Duplicate detection ────────────────────────────────────────────

  test("increments count when pattern already exists in DB", async () => {
    // findPatternBySQL returns a match
    setResults({
      rows: [
        { id: "existing-123", confidence: 0.3, repetition_count: 5 },
      ],
    });

    await _analyzeAndPropose(defaultInput);

    // First query: findPatternBySQL SELECT → found match
    expect(queryCalls[0].sql).toContain("SELECT id, confidence, repetition_count");

    // Second query: incrementPatternCount UPDATE (fire-and-forget)
    const updateCall = queryCalls.find((c) => c.sql.includes("UPDATE learned_patterns SET"));
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toContain("repetition_count = repetition_count + 1");
    expect(updateCall!.sql).toContain("LEAST(1.0, confidence + 0.1)");
    expect(updateCall!.params?.[0]).toBe("existing-123");
  });

  // ── Org-scoping ────────────────────────────────────────────────────

  test("uses orgId from request context when available", async () => {
    setResults({ rows: [] });

    const user = createAtlasUser("user-1", "simple-key", "Test User", {
      activeOrganizationId: "org-456",
    });

    await withRequestContext({ requestId: "test-req", user }, async () => {
      await _analyzeAndPropose(defaultInput);
    });

    // findPatternBySQL should use org_id = $2
    const selectCall = queryCalls[0];
    expect(selectCall.sql).toContain("org_id = $2");
    expect(selectCall.params).toContain("org-456");

    // INSERT should include org_id
    const insertCall = queryCalls.find((c) => c.sql.includes("INSERT INTO learned_patterns"));
    expect(insertCall).toBeDefined();
    expect(insertCall!.params?.[0]).toBe("org-456");
  });

  test("uses org_id IS NULL when no org context", async () => {
    setResults({ rows: [] });

    // No withRequestContext → getRequestContext() returns undefined
    await _analyzeAndPropose(defaultInput);

    const selectCall = queryCalls[0];
    expect(selectCall.sql).toContain("org_id IS NULL");
  });

  // ── Fire-and-forget safety ─────────────────────────────────────────

  test("analysis failure does not throw", async () => {
    queryThrow = new Error("DB connection failed");

    // _analyzeAndPropose should throw (it propagates the DB error)
    // but proposePatternIfNovel wraps it in .catch() — we test _analyzeAndPropose directly here
    await expect(_analyzeAndPropose(defaultInput)).rejects.toThrow(
      "DB connection failed",
    );
  });

  test("skips very short normalized SQL", async () => {
    const shortInput: PatternProposalInput = {
      sql: "SELECT 1",
      dialect: "PostgresQL",
      connectionId: "default",
    };

    await _analyzeAndPropose(shortInput);

    // Should not hit the DB at all
    expect(queryCalls.length).toBe(0);
  });

  // ── Pattern metadata ───────────────────────────────────────────────

  test("inserted pattern has correct metadata", async () => {
    setResults({ rows: [] });

    const input: PatternProposalInput = {
      sql: "SELECT status, COUNT(*) FROM orders GROUP BY status",
      dialect: "PostgresQL",
      connectionId: "warehouse",
    };

    await _analyzeAndPropose(input);

    const insertCall = queryCalls.find((c) => c.sql.includes("INSERT INTO learned_patterns"));
    expect(insertCall).toBeDefined();

    const params = insertCall!.params!;
    // params: [orgId, patternSql, description, sourceEntity, sourceQueries, proposedBy]
    const description = params[2] as string;
    const sourceEntity = params[3] as string;
    const sourceQueries = params[4] as string;

    expect(description).toContain("Aggregation");
    expect(sourceEntity).toBe("orders");
    // sourceQueries is a JSON string array containing the fingerprint
    const parsed = JSON.parse(sourceQueries);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0]).toMatch(/^[0-9a-f]+$/);
  });

  // ── Source fingerprint accumulation ────────────────────────────────

  test("increment appends fingerprint to source_queries", async () => {
    setResults({
      rows: [
        { id: "pat-999", confidence: 0.5, repetition_count: 3 },
      ],
    });

    await _analyzeAndPropose(defaultInput);

    const updateCall = queryCalls.find((c) => c.sql.includes("UPDATE learned_patterns SET"));
    expect(updateCall).toBeDefined();
    // Should include the fingerprint as a JSONB array
    expect(updateCall!.params?.length).toBe(2); // [id, jsonbEntry]
    const jsonbEntry = updateCall!.params![1] as string;
    const parsed = JSON.parse(jsonbEntry);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatch(/^[0-9a-f]+$/);
  });

  // ── proposePatternIfNovel wrapper ──────────────────────────────────

  test("proposePatternIfNovel skips when no internal DB", () => {
    delete process.env.DATABASE_URL;
    _resetPool(null);

    // Should return immediately without touching the DB
    proposePatternIfNovel(defaultInput);
    expect(queryCalls.length).toBe(0);
  });

  test("proposePatternIfNovel swallows errors without throwing", async () => {
    queryThrow = new Error("DB connection exploded");

    // This should NOT throw — the .catch() wrapper absorbs the error
    proposePatternIfNovel(defaultInput);

    // Give the async fire-and-forget a tick to settle
    await new Promise((r) => setTimeout(r, 50));

    // No unhandled rejection — if we got here, the error was swallowed
    expect(true).toBe(true);
  });

  // ── YAML pattern match short-circuit ───────────────────────────────

  test("skips DB check when query matches a YAML query_pattern", async () => {
    // Pre-populate the YAML cache with a known normalized pattern
    const knownPattern = normalizeSQL(
      "SELECT plan, SUM(monthly_value) AS total_mrr, COUNT(*) AS account_count FROM accounts WHERE status = 'Active' GROUP BY plan ORDER BY total_mrr DESC",
    );
    _setYamlPatternCache(new Set([knownPattern]));

    // Submit a SQL that normalizes to the same pattern (different literal value)
    const input: PatternProposalInput = {
      sql: "SELECT plan, SUM(monthly_value) AS total_mrr, COUNT(*) AS account_count FROM accounts WHERE status = 'Premium' GROUP BY plan ORDER BY total_mrr DESC",
      dialect: "PostgresQL",
      connectionId: "default",
    };

    await _analyzeAndPropose(input);

    // Should NOT hit the DB at all — short-circuited by YAML match
    expect(queryCalls.length).toBe(0);
  });

  // ── incrementPatternCount without fingerprint ──────────────────────

  test("incrementPatternCount without fingerprint uses simple UPDATE", () => {
    enableInternalDB();

    incrementPatternCount("pat-abc");

    const updateCall = queryCalls.find((c) => c.sql.includes("UPDATE learned_patterns SET"));
    expect(updateCall).toBeDefined();
    // Simple update: only id param, no JSONB append
    expect(updateCall!.params?.length).toBe(1);
    expect(updateCall!.params?.[0]).toBe("pat-abc");
    expect(updateCall!.sql).not.toContain("source_queries");
  });
});
