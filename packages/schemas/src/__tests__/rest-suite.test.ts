import { describe, expect, test } from "bun:test";
import { ExecuteSqlRestResponseSchema } from "../execute-sql";
import { RunMetricRestResponseSchema } from "../metric-run";
import { PublishResultSchema } from "../mode";

// These schemas validate untrusted server JSON, so fixtures cross the boundary
// as `unknown` and are checked with `.safeParse()` (how the CLI consumes them).

describe("ExecuteSqlRestResponseSchema (#4111)", () => {
  const ok = {
    columns: ["id", "name"],
    rows: [{ id: 1, name: "alice" }],
    rowCount: 1,
    truncated: false,
    executionMs: 12,
    executedAt: "2026-06-29T00:00:00Z",
  };

  test("parses a query result", () => {
    const r = ExecuteSqlRestResponseSchema.safeParse(ok);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(ok);
  });

  test("parses an empty result", () => {
    const empty = { ...ok, rows: [], rowCount: 0 };
    expect(ExecuteSqlRestResponseSchema.safeParse(empty).success).toBe(true);
  });

  test("rejects a body missing required fields", () => {
    expect(ExecuteSqlRestResponseSchema.safeParse({ columns: ["id"] }).success).toBe(false);
  });
});

describe("RunMetricRestResponseSchema (#4111)", () => {
  const scalar = {
    id: "total_gmv",
    label: "Total GMV",
    value: 1234.5,
    columns: ["total_gmv"],
    rows: [{ total_gmv: 1234.5 }],
    rowCount: 1,
    truncated: false,
    sql: "SELECT 1",
    executedAt: "2026-06-29T00:00:00Z",
  };

  test("parses a scalar metric result", () => {
    const r = RunMetricRestResponseSchema.safeParse(scalar);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(scalar);
  });

  test("parses a null label", () => {
    const r = RunMetricRestResponseSchema.safeParse({ ...scalar, label: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.label).toBeNull();
  });

  test("rejects a body missing the sql field", () => {
    const { sql: _sql, ...noSql } = scalar;
    expect(RunMetricRestResponseSchema.safeParse(noSql).success).toBe(false);
  });
});

describe("PublishResultSchema (#4156)", () => {
  const ok = {
    promoted: {
      connections: 1,
      entities: 12,
      prompts: 0,
      starterPrompts: 2,
      knowledgeDocuments: 4,
    },
    deleted: { entities: 3 },
  };

  test("parses the shared publish-result core", () => {
    const r = PublishResultSchema.safeParse(ok);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(ok);
  });

  test("defaults knowledgeDocuments to 0 for an older API's response (deploy overlap)", () => {
    const { knowledgeDocuments: _kd, ...olderPromoted } = ok.promoted;
    const r = PublishResultSchema.safeParse({ ...ok, promoted: olderPromoted });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.promoted).toEqual({ ...olderPromoted, knowledgeDocuments: 0 });
    }
  });

  test("strips REST-only extras (archived / warnings) to the shared core", () => {
    const withExtras = {
      ...ok,
      archived: { connections: 0, entities: 0, prompts: 0 },
      warnings: { incompleteLayers: [] },
    };
    const r = PublishResultSchema.safeParse(withExtras);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(ok);
  });

  test("rejects the pre-#4156 flat delete-count shapes", () => {
    // `deleted_entities` (MCP) / `deletedEntities` (lib) are the drifted shapes
    // this unification retired — the canonical field is nested `deleted.entities`.
    expect(
      PublishResultSchema.safeParse({ promoted: ok.promoted, deleted_entities: 3 }).success,
    ).toBe(false);
    expect(
      PublishResultSchema.safeParse({ promoted: ok.promoted, deletedEntities: 3 }).success,
    ).toBe(false);
  });

  test("rejects a negative count", () => {
    expect(
      PublishResultSchema.safeParse({
        promoted: { ...ok.promoted, connections: -1 },
        deleted: { entities: 0 },
      }).success,
    ).toBe(false);
  });
});
