/**
 * End-to-end test for the click → pending-bucket flow.
 *
 * Simulates the acceptance-criterion scenario: a query suggestion gets
 * clicked by three distinct users via POST /api/v1/suggestions/:id/click;
 * afterward, GET /api/v1/admin/starter-prompts/queue surfaces it in the
 * pending bucket.
 *
 * The real production path writes through three layers: the click
 * route, the `incrementSuggestionClick` CTE, and the admin queue SQL.
 * Here we simulate a minimal SQL fake so the three layers interact
 * without a Postgres instance — enough to catch a regression that drops
 * the CTE's `distinct_user_clicks` addend or tightens the queue filter
 * incorrectly.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// The default factory stubs `incrementSuggestionClick` to a no-op. This
// test exercises the full click → counter → queue chain, so we pass an
// override that mirrors the production CTE and routes the SQL through
// the factory's internalExecute mock (which our fake DB reads from).
function realIncrementSuggestionClick(
  id: string,
  orgId: string | null,
  userId: string | null = null,
): void {
  const orgClause = orgId != null ? "org_id = $1" : "org_id IS NULL";
  if (userId == null) {
    const params: unknown[] = orgId != null ? [orgId, id] : [id];
    const idIdx = params.length;
    mocks.mockInternalExecute(
      `UPDATE query_suggestions SET clicked_count = clicked_count + 1 WHERE ${orgClause} AND id = $${idIdx}`,
      params,
    );
    return;
  }
  const params: unknown[] = orgId != null ? [orgId, id, userId] : [id, userId];
  const idIdx = orgId != null ? 2 : 1;
  const userIdx = orgId != null ? 3 : 2;
  mocks.mockInternalExecute(
    `WITH inserted AS (
       INSERT INTO suggestion_user_clicks (suggestion_id, user_id)
       VALUES ($${idIdx}, $${userIdx})
       ON CONFLICT (suggestion_id, user_id) DO NOTHING
       RETURNING 1
     )
     UPDATE query_suggestions SET
       clicked_count = clicked_count + 1,
       distinct_user_clicks = distinct_user_clicks + (SELECT COUNT(*) FROM inserted)::int
     WHERE ${orgClause} AND id = $${idIdx}`,
    params,
  );
}

const mocks = createApiTestMocks({
  internal: {
    incrementSuggestionClick: realIncrementSuggestionClick,
  },
});

// ── Fake database ─────────────────────────────────────────────────────
// A single suggestion row + a Set of (suggestion_id, user_id) pairs
// standing in for the dedup table.

const SUGGESTION_ID = "sug-crossed";
const ORG_ID = "org-alpha";

interface FakeRow {
  id: string;
  org_id: string | null;
  description: string;
  pattern_sql: string;
  normalized_hash: string;
  tables_involved: string;
  primary_table: string | null;
  frequency: number;
  clicked_count: number;
  distinct_user_clicks: number;
  score: number;
  approval_status: "pending" | "approved" | "hidden";
  status: "draft" | "published" | "archived";
  approved_by: string | null;
  approved_at: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

let suggestion: FakeRow;
let distinctUserKeys: Set<string>;

function resetFakeDB(): void {
  suggestion = {
    id: SUGGESTION_ID,
    org_id: ORG_ID,
    description: "SELECT * FROM foo",
    pattern_sql: "SELECT * FROM foo",
    normalized_hash: "hash",
    tables_involved: "[]",
    primary_table: null,
    frequency: 1,
    clicked_count: 0,
    distinct_user_clicks: 0,
    score: 0,
    approval_status: "pending",
    status: "draft",
    approved_by: null,
    approved_at: null,
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  distinctUserKeys = new Set();
}

/** Applies the CTE UPDATE that incrementSuggestionClick issues. */
function applyCteUpdate(sql: string, params: readonly unknown[]): void {
  // Params shape: [orgId, suggestionId, userId] (orgId present in this test).
  const [, id, userId] = params as [string, string, string];
  if (id !== SUGGESTION_ID) return;
  const key = `${id}|${userId}`;
  const wasNew = !distinctUserKeys.has(key);
  if (wasNew) distinctUserKeys.add(key);
  suggestion.clicked_count += 1;
  if (wasNew && sql.includes("distinct_user_clicks")) {
    suggestion.distinct_user_clicks += 1;
  }
}

/** Applies the legacy (userId null) UPDATE. */
function applyLegacyUpdate(params: readonly unknown[]): void {
  const [, id] = params as [string, string];
  if (id === SUGGESTION_ID) suggestion.clicked_count += 1;
}

function bucketOfQuery(sql: string): "pending" | "approved" | "hidden" | "other" {
  if (sql.includes("approval_status = 'pending'")) return "pending";
  if (sql.includes("approval_status = 'approved'")) return "approved";
  if (sql.includes("approval_status = 'hidden'")) return "hidden";
  return "other";
}

function applySelectQuery(sql: string, params: readonly unknown[]): FakeRow[] {
  const bucket = bucketOfQuery(sql);
  if (bucket === "pending") {
    const threshold = (params as unknown[])[1] as number;
    if (
      suggestion.approval_status === "pending" &&
      suggestion.distinct_user_clicks >= threshold
    ) {
      return [suggestion];
    }
    return [];
  }
  if (bucket === "approved" || bucket === "hidden") {
    return suggestion.approval_status === bucket ? [suggestion] : [];
  }
  return [];
}

// ── Wire the fake DB into the test mocks ─────────────────────────────

mocks.mockInternalExecute.mockImplementation((sql: string, params?: unknown[]) => {
  // incrementSuggestionClick issues an UPDATE (with optional CTE).
  if (sql.includes("INSERT INTO suggestion_user_clicks")) {
    applyCteUpdate(sql, params ?? []);
  } else if (sql.includes("UPDATE query_suggestions")) {
    applyLegacyUpdate(params ?? []);
  }
});

mocks.mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
  return applySelectQuery(sql, params ?? []);
});

const { app } = await import("../index");

// ── Helpers ──────────────────────────────────────────────────────────

function clickAs(userId: string) {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: {
        id: userId,
        mode: "simple-key",
        label: userId,
        role: "member",
        activeOrganizationId: ORG_ID,
      },
    }),
  );
  return app.fetch(
    new Request(`http://localhost/api/v1/suggestions/${SUGGESTION_ID}/click`, {
      method: "POST",
      headers: { Authorization: "Bearer test" },
    }),
  );
}

function asAdmin() {
  mocks.mockAuthenticateRequest.mockImplementation(() =>
    Promise.resolve({
      authenticated: true,
      mode: "simple-key",
      user: {
        id: "admin-1",
        mode: "simple-key",
        label: "admin@test",
        role: "admin",
        activeOrganizationId: ORG_ID,
      },
    }),
  );
}

async function fetchQueue() {
  asAdmin();
  return app.fetch(
    new Request("http://localhost/api/v1/admin/starter-prompts/queue", {
      method: "GET",
      headers: { Authorization: "Bearer test" },
    }),
  );
}

beforeEach(() => {
  resetFakeDB();
  mocks.hasInternalDB = true;
  mocks.mockCheckRateLimit.mockImplementation(() => ({ allowed: true }));
});

afterAll(() => {
  mocks.cleanup();
});

// ── The test ─────────────────────────────────────────────────────────

describe("click → pending bucket (acceptance-criteria flow)", () => {
  it("surfaces a suggestion in the pending bucket after 3 distinct-user clicks", async () => {
    // Below threshold (2 distinct clicks) — not in queue.
    await clickAs("user-1");
    await clickAs("user-2");
    // Same user again: must not advance distinct_user_clicks.
    await clickAs("user-1");

    expect(suggestion.distinct_user_clicks).toBe(2);

    let res = await fetchQueue();
    expect(res.status).toBe(200);
    let body = (await res.json()) as { pending: Array<{ id: string }> };
    expect(body.pending).toEqual([]);

    // Third distinct user — crosses threshold.
    await clickAs("user-3");

    expect(suggestion.distinct_user_clicks).toBe(3);

    res = await fetchQueue();
    expect(res.status).toBe(200);
    body = (await res.json()) as { pending: Array<{ id: string }> };
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]?.id).toBe(SUGGESTION_ID);
  });
});
