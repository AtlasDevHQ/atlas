/**
 * Unit tests for `incrementSuggestionClick` — the CTE path that keeps
 * `distinct_user_clicks` in lockstep with the `suggestion_user_clicks`
 * dedup table.
 *
 * These assert SQL shape and parameter positions. Off-by-one on
 * `$${idIdx}` / `$${userIdx}`, dropping `ON CONFLICT DO NOTHING`, or
 * dropping the `(SELECT COUNT(*) FROM inserted)::int` addend would all
 * silently corrupt the counter in production; these tests make that
 * loud.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";

// `hasInternalDB()` reads DATABASE_URL at call time; set it before the
// module under test is imported so the increment path is exercised.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/atlas_test";

import {
  incrementSuggestionClick,
  _resetPool,
  _resetCircuitBreaker,
} from "../internal";

// Intercept every raw-pool query. `internalExecute` falls through to
// `getInternalDB().query(...)` when no SqlClient is bound — we bind a
// plain stub pool via `_resetPool` and collect each fire-and-forget call.
interface Captured {
  sql: string;
  params: unknown[];
}

let captured: Captured[] = [];

function makeStubPool() {
  return {
    query: async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      return { rows: [] };
    },
    async end() {},
    async connect() {
      return { query: async () => ({ rows: [] }), release() {} };
    },
    on() {},
  };
}

beforeEach(() => {
  captured = [];
  _resetCircuitBreaker();
  _resetPool(makeStubPool() as unknown as Parameters<typeof _resetPool>[0], null);
});

afterAll(() => {
  // Release the stub pool so later test files get a fresh state.
  _resetPool(null, null);
  _resetCircuitBreaker();
  mock.restore();
});

// Helper: incrementSuggestionClick uses fire-and-forget semantics —
// the UPDATE resolves on the microtask queue. A single microtask flush
// lets us inspect what landed.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("incrementSuggestionClick — legacy path (userId null)", () => {
  it("bumps clicked_count only, with orgId scoping", async () => {
    incrementSuggestionClick("sug-1", "org-a");
    await flush();

    expect(captured).toHaveLength(1);
    const { sql, params } = captured[0]!;
    expect(sql).toContain("UPDATE query_suggestions");
    expect(sql).toContain("clicked_count = clicked_count + 1");
    expect(sql).not.toContain("distinct_user_clicks");
    expect(sql).not.toContain("suggestion_user_clicks");
    expect(sql).toContain("org_id = $1");
    expect(sql).toContain("id = $2");
    expect(params).toEqual(["org-a", "sug-1"]);
  });

  it("handles null orgId via IS NULL clause", async () => {
    incrementSuggestionClick("sug-1", null);
    await flush();

    expect(captured).toHaveLength(1);
    const { sql, params } = captured[0]!;
    expect(sql).toContain("org_id IS NULL");
    expect(sql).toContain("id = $1");
    expect(params).toEqual(["sug-1"]);
  });
});

describe("incrementSuggestionClick — distinct-user path", () => {
  it("upserts the dedup row and bumps both counters atomically (orgId + userId)", async () => {
    incrementSuggestionClick("sug-1", "org-a", "user-42");
    await flush();

    expect(captured).toHaveLength(1);
    const { sql, params } = captured[0]!;

    // Dedup insert with idempotency
    expect(sql).toContain("INSERT INTO suggestion_user_clicks");
    expect(sql).toContain("ON CONFLICT (suggestion_id, user_id) DO NOTHING");
    expect(sql).toContain("RETURNING 1");

    // Counter bump derived from the insert's row count
    expect(sql).toContain("clicked_count = clicked_count + 1");
    expect(sql).toContain(
      "distinct_user_clicks = distinct_user_clicks + (SELECT COUNT(*) FROM inserted)::int",
    );

    // Param layout: [orgId, suggestionId, userId]
    expect(sql).toContain("org_id = $1");
    expect(params).toEqual(["org-a", "sug-1", "user-42"]);
  });

  it("handles null orgId path with correct param indexing", async () => {
    incrementSuggestionClick("sug-9", null, "user-7");
    await flush();

    expect(captured).toHaveLength(1);
    const { sql, params } = captured[0]!;

    expect(sql).toContain("org_id IS NULL");

    // With no org param, suggestionId is $1 and userId is $2 — both
    // the INSERT values and the UPDATE's WHERE clause share $1 for the id.
    expect(sql).toContain("VALUES ($1, $2)");
    expect(sql).toContain("id = $1");
    expect(params).toEqual(["sug-9", "user-7"]);
  });
});
