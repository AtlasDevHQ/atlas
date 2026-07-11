/**
 * `loadAuditPatterns` — the audit-pattern context loader (#1269) with the
 * #4516 org-scope param.
 *
 * `audit_log` is a shared, multi-tenant table. The SaaS per-workspace scheduler
 * passes an `orgId` so the scan is scoped to one tenant; without it, one
 * workspace's query patterns would surface in another workspace's proposals — a
 * cross-tenant leak. Self-hosted / CLI omit it (global NULL-org scan). This file
 * pins that the tenant filter is present exactly when an orgId is passed and
 * absent otherwise, so a regression that drops or hard-codes the filter ships red.
 */

import { describe, it, expect, mock } from "bun:test";

let capturedSql = "";
let capturedParams: unknown[] = [];

// context-loader dynamically imports internal ONLY inside loadAuditPatterns, and
// uses just these two exports — a partial mock is complete for this file.
void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: async (sql: string, params: unknown[]) => {
    capturedSql = sql;
    capturedParams = params;
    return [
      { sql: "SELECT 1", count: "5", last_seen: "2026-01-01", tables_accessed: ["orders"] },
    ];
  },
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { loadAuditPatterns } = await import("../context-loader");

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
