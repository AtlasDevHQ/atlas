/**
 * `atlas-operator export` — learned-pattern projection (#4569, audit M9).
 *
 * The export leg of the amendment-identity round-trip: this pins that the
 * bundle's `learnedPatterns` carry `type`, `amendment_payload`,
 * `connection_group_id`, reviewer + review time, and repetition count for a
 * `semantic_amendment` row — so an amendment survives workspace migration as an
 * amendment instead of round-tripping as an orphaned query pattern. The import
 * leg is pinned separately in `admin-migrate.test.ts`.
 *
 * The internal DB pool and `fs.writeFileSync` are mocked (Bun requires
 * `mock.module()` before the import under test) so the projection is exercised
 * without a real Postgres or disk write.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "fs";
import type { ExportBundle } from "@useatlas/types";

// Rows the fake pool returns for the learned_patterns SELECT — set per test.
let learnedRows: Record<string, unknown>[] = [];

const fakePool = {
  query: async (sql: string) => {
    if (sql.includes("FROM learned_patterns")) return { rows: learnedRows };
    // conversations / messages / semantic_entities / settings — empty.
    return { rows: [] };
  },
};

void mock.module("@atlas/api/lib/db/internal", () => ({
  getInternalDB: () => fakePool,
  closeInternalDB: async () => {},
}));

import { handleExport } from "../commands/operator/export";

/** Run the export with fs.writeFileSync stubbed; return the parsed bundle. */
async function runExport(): Promise<ExportBundle> {
  let captured = "";
  const writeSpy = spyOn(fs, "writeFileSync").mockImplementation((_path, data) => {
    captured = String(data);
  });
  try {
    await handleExport(["--output", "/tmp/atlas-export-test.json"]);
  } finally {
    writeSpy.mockRestore();
  }
  return JSON.parse(captured) as ExportBundle;
}

describe("atlas-operator export — learned-pattern projection (#4569)", () => {
  let origDbUrl: string | undefined;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    origDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://test/internal";
    learnedRows = [];
    // Record an unexpected process.exit rather than killing the runner.
    exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    if (origDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = origDbUrl;
    exitSpy.mockRestore();
  });

  it("round-trips amendment identity for a semantic_amendment row", async () => {
    const payload = {
      entityName: "orders",
      amendmentType: "add_dimension",
      amendment: { name: "region", sql: "region", type: "string" },
      rationale: "geo breakdowns",
    };
    learnedRows = [
      {
        pattern_sql: "amendment:orders:add_dimension:region",
        description: "Add region dimension",
        source_entity: "orders",
        confidence: 0.9,
        status: "approved",
        type: "semantic_amendment",
        // node-pg returns jsonb already parsed to an object.
        amendment_payload: payload,
        connection_group_id: "g_prod_us",
        reviewed_by: "admin-1",
        reviewed_at: "2026-07-10T12:00:00Z",
        repetition_count: 3,
        auto_promoted: false,
      },
    ];

    const bundle = await runExport();
    expect(bundle.learnedPatterns).toHaveLength(1);
    const p = bundle.learnedPatterns[0];
    expect(p.type).toBe("semantic_amendment");
    expect(p.amendmentPayload).toEqual(payload);
    expect(p.connectionGroupId).toBe("g_prod_us");
    expect(p.reviewedBy).toBe("admin-1");
    expect(p.reviewedAt).toBe("2026-07-10T12:00:00Z");
    expect(p.repetitionCount).toBe(3);
    // Human-approved provenance carried so the eligibility bypass survives (#4571).
    expect(p.autoPromoted).toBe(false);
  });

  it("carries the machine-promoted flag (#4571) so a migrated pattern stays confidence-gated", async () => {
    learnedRows = [
      {
        pattern_sql: "SELECT COUNT(*) FROM orders",
        description: "Order count",
        source_entity: "orders",
        confidence: 0.9,
        status: "approved",
        type: "query_pattern",
        amendment_payload: null,
        connection_group_id: null,
        reviewed_by: "atlas-auto-promote",
        reviewed_at: "2026-07-10T12:00:00Z",
        repetition_count: 6,
        auto_promoted: true,
      },
    ];

    const bundle = await runExport();
    expect(bundle.learnedPatterns[0].autoPromoted).toBe(true);
  });

  it("defaults a legacy row (null type / null payload) to a query pattern", async () => {
    learnedRows = [
      {
        pattern_sql: "SELECT COUNT(*) FROM orders",
        description: "Order count",
        source_entity: "orders",
        confidence: 0.8,
        status: "pending",
        type: null,
        amendment_payload: null,
        connection_group_id: null,
        reviewed_by: null,
        reviewed_at: null,
        repetition_count: null,
      },
    ];

    const bundle = await runExport();
    const p = bundle.learnedPatterns[0];
    expect(p.type).toBe("query_pattern");
    expect(p.amendmentPayload).toBeNull();
    expect(p.connectionGroupId).toBeNull();
    expect(p.reviewedBy).toBeNull();
    expect(p.reviewedAt).toBeNull();
    expect(p.repetitionCount).toBe(1);
  });
});
