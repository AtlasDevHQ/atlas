/**
 * Parse-once seam regression tests (#4349).
 *
 * `validateSQL` used to feed the same query string to node-sql-parser up to
 * five times: `astify` for the statement-shape guard, then a `tableList` each
 * for the ONLY-guard, the whitelist, and the classifier (which also ran
 * `columnList`), plus a fifth `tableList` in RLS injection. The whitelist
 * bucket and the classifier's table set matched only because two re-parses of
 * the same string can't disagree — an undocumented invariant, not a structural
 * guarantee. That mattered because the classifier's `tablesAccessed` drives the
 * approval gate and PII masking, and it fails open to an EMPTY set.
 *
 * These tests pin the structural fix:
 *   1. One `parser.parse` per validation; the redundant `astify` / `tableList`
 *      / `columnList` calls are gone (AC1–AC3).
 *   2. The classifier and the whitelist read the SAME parse, so a query the
 *      whitelist accepts on table T is classified with T — they cannot diverge
 *      (AC4).
 *   3. The only way to reach an empty `tablesAccessed` is a genuinely
 *      table-less query; a query WITH tables can never fail-open to empty and
 *      slip past the approval gate / masking (AC5).
 */

import { describe, expect, it, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { Parser } from "node-sql-parser";
import { createConnectionMock } from "@atlas/api/testing/connection";

// Whitelist pinned to a handful of names. Qualified variants mirror atlas-init
// output where non-default-schema entities add both `table` and `schema.table`.
const whitelist = new Set([
  "companies",
  "people",
  "orders",
  "public.companies",
]);

// Mirror every value export of the `@atlas/api/lib/semantic` barrel
// (lib/semantic/index.ts) — mock-all-exports so no consumer silently reads an
// undefined. The `_resetOrg*` helpers live in whitelist.ts, not the barrel.
void mock.module("@atlas/api/lib/semantic", () => ({
  getWhitelistedTables: () => whitelist,
  getWhitelistedTablesStrict: () => whitelist,
  SemanticLayerScanError: class SemanticLayerScanError extends Error {},
  getCrossSourceJoins: () => [],
  registerPluginEntities: () => {},
  _resetWhitelists: () => {},
  loadOrgWhitelist: async () => new Map(),
  getOrgWhitelistedTables: () => whitelist,
  invalidateOrgWhitelist: () => {},
  invalidateOrgSemanticIndex: () => {},
  getOrgSemanticIndex: async () => "",
}));

// Mutable so the MySQL case can flip the resolved dialect for one test.
let dbTypeForTest = "postgres";

void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: { getDBType: () => dbTypeForTest },
    detectDBType: () => dbTypeForTest,
  }),
);

const { validateSQL, extractClassification } = await import("@atlas/api/lib/tools/sql");

process.env.ATLAS_DATASOURCE_URL ??= "postgresql://test:test@localhost:5432/test";

describe("parse-once seam (#4349)", () => {
  // Spy on every node-sql-parser entry point. `parse()` does not delegate to
  // the instance `astify` / `tableList` / `columnList` methods, so a call to
  // any of the latter three during validation would be a redundant re-parse.
  let parseSpy: ReturnType<typeof spyOn>;
  let astifySpy: ReturnType<typeof spyOn>;
  let tableListSpy: ReturnType<typeof spyOn>;
  let columnListSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    dbTypeForTest = "postgres";
    parseSpy = spyOn(Parser.prototype, "parse");
    astifySpy = spyOn(Parser.prototype, "astify");
    tableListSpy = spyOn(Parser.prototype, "tableList");
    columnListSpy = spyOn(Parser.prototype, "columnList");
  });

  afterEach(() => {
    parseSpy.mockRestore();
    astifySpy.mockRestore();
    tableListSpy.mockRestore();
    columnListSpy.mockRestore();
  });

  it("parses the query exactly once — no redundant astify / tableList / columnList (AC1–AC3)", async () => {
    const result = await validateSQL("SELECT id, name FROM companies WHERE name = 'Acme'");
    expect(result.valid).toBe(true);

    // The whole point of the refactor: one parse feeds every consumer.
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(astifySpy).not.toHaveBeenCalled();
    expect(tableListSpy).not.toHaveBeenCalled();
    expect(columnListSpy).not.toHaveBeenCalled();
  });

  it("classifier and whitelist share one table set — a whitelisted table is classified, single-source (AC4)", async () => {
    // `companies` and `people` are both whitelisted; the query is accepted AND
    // the classification reports exactly those tables. Because both the
    // whitelist check and the classifier read the one `parse()` result (proven
    // by the call count), they cannot report different table sets.
    const result = await validateSQL(
      "SELECT c.name, p.email FROM companies c JOIN people p ON c.id = p.company_id",
    );
    expect(result.valid).toBe(true);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    if (result.valid) {
      expect(new Set(result.classification.tablesAccessed)).toEqual(
        new Set(["companies", "people"]),
      );
    }
  });

  it("a query WITH tables never classifies to an empty set — no divergent fail-open (AC5)", async () => {
    // The security-relevant half of AC5: an accepted query that references a
    // real table can never yield an empty `tablesAccessed` (which would let the
    // approval gate / PII masking find no rule and un-gate the query). With the
    // shared parse there is no independent classifier re-parse that could fail
    // and fall open to [].
    const result = await validateSQL("SELECT id FROM companies");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.classification.tablesAccessed).toEqual(["companies"]);
      expect(result.classification.tablesAccessed.length).toBeGreaterThan(0);
    }
  });

  it("the empty-classification path is directly reachable for a table-less query (AC5)", async () => {
    // The legitimately-reachable empty path: a genuinely table-less query. This
    // is now the ONLY route to an empty table set — asserted directly rather
    // than masked behind an impossible re-parse divergence.
    const result = await validateSQL("SELECT 1");
    expect(result.valid).toBe(true);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    if (result.valid) {
      expect(result.classification.tablesAccessed).toEqual([]);
      // Columns are still extracted from the same parse (best-effort telemetry).
      expect(result.classification.columnsAccessed).toEqual([]);
    }
  });

  it("CTE names are excluded from the classifier's table set, from the shared parse", async () => {
    const result = await validateSQL(
      "WITH top AS (SELECT id, name FROM companies LIMIT 10) SELECT * FROM top",
    );
    expect(result.valid).toBe(true);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    if (result.valid) {
      expect(result.classification.tablesAccessed).toEqual(["companies"]);
      expect(result.classification.tablesAccessed).not.toContain("top");
    }
  });

  it("threads the shared parse out for RLS reuse (parsed.sql matches the normalized query)", async () => {
    // The `parsed` artifact is what lets RLS injection reuse this parse instead
    // of the old fifth re-parse. It carries the exact normalized string parsed.
    const result = await validateSQL("SELECT id FROM companies;");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.parsed.sql).toBe("SELECT id FROM companies");
      expect(result.parsed.tables).toEqual(["select::null::companies"]);
    }
  });

  it("schema-qualified query: whitelist reads raw refs, classifier reads table names, one parse (AC4)", async () => {
    // `public.companies` is whitelisted (qualified). The whitelist matches on
    // the raw `select::public::companies` ref while the classifier reduces to
    // `companies` via tableNameFromRef — the one spot the two derivations
    // transform differently, yet both read the SAME single parse.
    const result = await validateSQL("SELECT id FROM public.companies");
    expect(result.valid).toBe(true);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    if (result.valid) {
      expect(result.classification.tablesAccessed).toEqual(["companies"]);
    }
  });

  it("classifies an accepted MySQL query through the shared parse (dialect flows into parseOnce)", async () => {
    dbTypeForTest = "mysql";
    const result = await validateSQL(
      "SELECT c.name, p.email FROM companies c JOIN people p ON c.id = p.company_id",
    );
    expect(result.valid).toBe(true);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(tableListSpy).not.toHaveBeenCalled();
    if (result.valid) {
      expect(new Set(result.classification.tablesAccessed)).toEqual(
        new Set(["companies", "people"]),
      );
    }
  });

  // ── standalone extractClassification (the retained re-parsing entry point) ──
  it("extractClassification fails open to empty arrays on unparseable SQL", () => {
    // The standalone export still parses, so its best-effort catch is live and
    // asserted directly against the REAL function (not a mirror). In the
    // pipeline this fail-open is unreachable — parseAndGuardShape rejects
    // unparseable SQL first — so the empty set can't silently un-gate a query.
    const result = extractClassification("THIS IS NOT SQL", "PostgresQL", new Set());
    expect(result.tablesAccessed).toEqual([]);
    expect(result.columnsAccessed).toEqual([]);
  });

  it("extractClassification derives tables/columns for parseable SQL", () => {
    const result = extractClassification("SELECT id, name FROM companies", "PostgresQL", new Set());
    expect(result.tablesAccessed).toEqual(["companies"]);
    expect(new Set(result.columnsAccessed)).toEqual(new Set(["id", "name"]));
  });
});
