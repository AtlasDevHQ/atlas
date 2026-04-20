/**
 * Unit tests for `getPopularSuggestions` — asserts the SQL contract that
 * only approval_status='approved' rows surface in the popular tier.
 *
 * Regression guard: before slice #1477, this function had no approval
 * filter, so hidden or pending suggestions could leak into the empty
 * state. The filter is the single source of truth that gates visibility
 * from backend to UI.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/atlas_test";

import {
  getPopularSuggestions,
  _resetPool,
  _resetCircuitBreaker,
} from "../internal";

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
  _resetPool(null, null);
  _resetCircuitBreaker();
  mock.restore();
});

describe("getPopularSuggestions — approval filter", () => {
  it("filters to approval_status = 'approved'", async () => {
    await getPopularSuggestions("org-1", 10);

    expect(captured).toHaveLength(1);
    const sql = captured[0]!.sql;
    // The popular tier is admin-moderated; only approved rows may surface
    // to the chat empty state. A regression dropping this filter would
    // leak pending/hidden suggestions into user-facing UI.
    expect(sql).toContain("approval_status = 'approved'");
  });

  it("scopes by org_id when orgId is provided", async () => {
    await getPopularSuggestions("org-1", 10);
    const sql = captured[0]!.sql;
    expect(sql).toContain("org_id = $1");
    expect(captured[0]!.params).toEqual(["org-1", 10]);
  });

  it("scopes to org_id IS NULL when orgId is null (single-tenant / unscoped)", async () => {
    await getPopularSuggestions(null, 10);
    const sql = captured[0]!.sql;
    expect(sql).toContain("org_id IS NULL");
    expect(captured[0]!.params).toEqual([10]);
  });

  it("orders by score DESC with LIMIT applied as a param", async () => {
    await getPopularSuggestions("org-1", 25);
    const sql = captured[0]!.sql;
    expect(sql).toContain("ORDER BY score DESC");
    expect(sql).toContain("LIMIT $");
    expect(captured[0]!.params).toEqual(["org-1", 25]);
  });
});

// Second gate beyond `approval_status = 'approved'`: the 1.2.0 mode axis.
// `getPopularSuggestions` now owns the `AND ${statusClause}` composition
// itself — the pre-#1531 helper returned a leading-AND string, so any
// regression that drops the clause or flips to the wrong mode would slip
// past the tests above. Assert the clause is composed in for both modes.
describe("getPopularSuggestions — mode status filter", () => {
  it("published mode (default) restricts to query_suggestions.status = 'published'", async () => {
    await getPopularSuggestions("org-1", 10);
    const sql = captured[0]!.sql;
    expect(sql).toContain("query_suggestions.status = 'published'");
    // Sanity: approval + mode gates are AND-composed, not OR
    expect(sql).toContain("approval_status = 'approved' AND");
  });

  it("developer mode overlays drafts onto published rows", async () => {
    await getPopularSuggestions("org-1", 10, "developer");
    const sql = captured[0]!.sql;
    expect(sql).toContain("query_suggestions.status IN ('published', 'draft')");
    expect(sql).not.toContain("draft_delete");
    expect(sql).not.toContain("archived");
  });

  it("published mode never surfaces draft or archived rows", async () => {
    await getPopularSuggestions("org-1", 10, "published");
    const sql = captured[0]!.sql;
    expect(sql).toContain("query_suggestions.status = 'published'");
    expect(sql).not.toContain("draft");
    expect(sql).not.toContain("archived");
  });
});
