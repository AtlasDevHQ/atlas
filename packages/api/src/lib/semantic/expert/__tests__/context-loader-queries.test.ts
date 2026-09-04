/**
 * The two `context-loader` DB queries that back the analyzer's staleness and
 * frequency inputs. Merged from `load-rejected-keys.test.ts` (#4507) and
 * `load-audit-patterns.test.ts` (#1269 / #4516) — both pinned the same
 * `db/internal` seam with the same partial mock, so they share one file.
 *
 * `loadRejectedKeys` (#4507) — the single canonical, group-scoped rejected-key
 * loader consumed by the analyzer staleness path on every surface (scheduler +
 * CLI). Pins two things the DB-seam guard test can't (it exercises a different
 * query, `findConflictingAmendment`):
 *   - Acceptance criterion 3: rejection memory is PERMANENT — the query has NO
 *     time window. Re-introducing `reviewed_at >= now() - interval '30 days'`
 *     would silently restore expiry and pass every other gate.
 *   - Keys are reconstructed group-scoped via the shared
 *     `amendmentIdentityFromRow`, so the loader agrees with the analyzer's
 *     `stalenessFactor` and the insert-time guard.
 *
 * `loadAuditPatterns` (#1269) with the #4516 org-scope param — `audit_log` is a
 * shared, multi-tenant table. The SaaS per-workspace scheduler passes an
 * `orgId` so the scan is scoped to one tenant; without it, one workspace's
 * query patterns would surface in another workspace's proposals — a
 * cross-tenant leak. Self-hosted / CLI omit it (global NULL-org scan). This
 * pins that the tenant filter is present exactly when an orgId is passed and
 * absent otherwise, so a regression that drops or hard-codes the filter ships
 * red.
 */

import { describe, it, expect, mock } from "bun:test";

let capturedSql = "";
let capturedParams: unknown[] = [];

const REJECTED_ROWS = [
  {
    source_entity: "orders",
    connection_group_id: "eu",
    amendment_payload: { amendmentType: "add_dimension", amendment: { name: "region" } },
  },
  {
    source_entity: "orders",
    connection_group_id: null,
    amendment_payload: JSON.stringify({ amendmentType: "add_measure", amendment: { name: "total_amount" } }),
  },
];

const AUDIT_ROWS = [
  { sql: "SELECT 1", count: "5", last_seen: "2026-01-01", tables_accessed: ["orders"] },
];

// context-loader dynamically imports internal ONLY inside these loaders, and
// uses just these two exports — a partial mock is complete for this file. The
// row set is chosen by the query the loader issued, so the two suites below
// each see the shape their own loader parses.
void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: async (sql: string, params: unknown[]) => {
    capturedSql = sql;
    capturedParams = params;
    return sql.includes("'rejected'") ? REJECTED_ROWS : AUDIT_ROWS;
  },
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { loadRejectedKeys, loadAuditPatterns } = await import("../context-loader");

describe("loadRejectedKeys (#4507)", () => {
  it("queries rejected rows with NO time window — rejection memory is permanent", async () => {
    await loadRejectedKeys();

    expect(capturedSql).toContain("status = 'rejected'");
    // Acceptance criterion 3 — no time-based expiry anywhere.
    expect(capturedSql).not.toContain("interval");
    expect(capturedSql).not.toContain("reviewed_at");
  });

  it("reconstructs group-scoped identity keys via the shared canonical builder", async () => {
    const keys = await loadRejectedKeys();

    // NULL group → "default"; a real group is preserved. Object and
    // JSON-string payloads both reconstruct.
    expect(keys.has("eu:orders:add_dimension:region")).toBe(true);
    expect(keys.has("default:orders:add_measure:total_amount")).toBe(true);
    expect(keys.size).toBe(2);
  });

  // #4516 — the SaaS per-workspace scheduler passes an orgId so the pre-filter
  // is scoped to one tenant; without it the union of every tenant's rejections
  // would over-suppress. Self-hosted / CLI omit it (global NULL-org scan).
  it("scopes the scan to one workspace when an orgId is passed", async () => {
    await loadRejectedKeys("org-42");

    expect(capturedSql).toContain("org_id = $1");
    expect(capturedParams).toEqual(["org-42"]);
  });

  it("does not filter by org when no orgId is passed (self-hosted / CLI)", async () => {
    await loadRejectedKeys();

    expect(capturedSql).not.toContain("org_id = $1");
    expect(capturedParams).toEqual([]);
  });
});

describe("loadAuditPatterns org-scope (#4516)", () => {
  it("scopes the scan to one workspace when an orgId is passed", async () => {
    await loadAuditPatterns("org-42");

    expect(capturedSql).toContain("org_id = $1");
    expect(capturedParams).toEqual(["org-42"]);
  });

  it("does not filter by org when no orgId is passed (self-hosted / CLI)", async () => {
    await loadAuditPatterns();

    expect(capturedSql).not.toContain("org_id = $1");
    expect(capturedParams).toEqual([]);
  });

  it("still parses the pattern rows regardless of scoping", async () => {
    const patterns = await loadAuditPatterns("org-42");

    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toMatchObject({ sql: "SELECT 1", count: 5, tables: ["orders"] });
  });
});
