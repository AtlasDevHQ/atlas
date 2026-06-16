import { describe, test, expect, mock } from "bun:test";
import type { ApprovedPatternRow } from "@atlas/api/lib/db/internal";

// pattern-cache imports settings/internal/logger at module load; stub them so
// the pure ranking helpers can be imported in isolation.
mock.module("@atlas/api/lib/db/internal", () => ({
  getApprovedPatterns: async () => [],
}));
mock.module("@atlas/api/lib/settings", () => ({
  getSetting: () => undefined,
  getSettingAuto: () => undefined,
  getSettingLive: async () => undefined,
}));
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { rankPatterns, perfWeight, DEFAULT_LATENCY_BUDGET_MS } = await import(
  "@atlas/api/lib/learn/pattern-cache"
);

function row(over: Partial<ApprovedPatternRow> & { id: string }): ApprovedPatternRow {
  return {
    org_id: null,
    connection_group_id: null,
    pattern_sql: "SELECT revenue FROM companies",
    description: "company revenue",
    source_entity: "companies",
    confidence: 0.9,
    avg_duration_ms: null,
    ...over,
  };
}

const KW = new Set(["revenue", "companies"]);

describe("perfWeight", () => {
  test("unknown / within-budget latency gets a neutral weight of 1", () => {
    expect(perfWeight(null, 1000)).toBe(1);
    expect(perfWeight(500, 1000)).toBe(1);
    expect(perfWeight(1000, 1000)).toBe(1);
  });

  test("a slow pattern is down-weighted but never to zero", () => {
    const w2x = perfWeight(2000, 1000);
    const w10x = perfWeight(10000, 1000);
    expect(w2x).toBeLessThan(1);
    expect(w2x).toBeGreaterThan(w10x);
    expect(w10x).toBeGreaterThanOrEqual(0.5);
  });

  test("a disabled / non-positive budget disables the penalty", () => {
    expect(perfWeight(99999, 0)).toBe(1);
  });
});

describe("rankPatterns — down-weight slow but keep present", () => {
  test("a fast pattern outranks an equally-relevant slow one", () => {
    const fast = row({ id: "fast", avg_duration_ms: 100 });
    const slow = row({ id: "slow", avg_duration_ms: 8000 });
    const ranked = rankPatterns([slow, fast], KW, {
      latencyBudgetMs: 1000,
      maxPatterns: 10,
    });
    expect(ranked.map((r) => r.pattern.id)).toEqual(["fast", "slow"]);
    // The slow pattern is still PRESENT — down-weighted, not excluded.
    expect(ranked).toHaveLength(2);
  });

  test("relevance still dominates: a much-more-relevant slow pattern wins", () => {
    // slow pattern matches both keywords; fast matches only one.
    const slowRelevant = row({
      id: "slow-relevant",
      avg_duration_ms: 8000,
      pattern_sql: "SELECT revenue FROM companies",
      description: "revenue companies",
    });
    const fastSparse = row({
      id: "fast-sparse",
      avg_duration_ms: 50,
      pattern_sql: "SELECT 1",
      description: "companies",
      source_entity: null,
    });
    const ranked = rankPatterns([fastSparse, slowRelevant], KW, {
      latencyBudgetMs: 1000,
      maxPatterns: 10,
    });
    expect(ranked[0].pattern.id).toBe("slow-relevant");
  });

  test("never drops a slow relevant pattern (filter is on raw keyword overlap)", () => {
    const slow = row({ id: "very-slow", avg_duration_ms: 10 ** 9 });
    const ranked = rankPatterns([slow], KW, { latencyBudgetMs: 1000, maxPatterns: 10 });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].pattern.id).toBe("very-slow");
  });

  test("drops patterns with zero keyword overlap", () => {
    const unrelated = row({
      id: "unrelated",
      pattern_sql: "SELECT widgets FROM inventory",
      description: "widget stock levels",
      source_entity: "inventory",
    });
    const ranked = rankPatterns([unrelated], KW, { latencyBudgetMs: 1000, maxPatterns: 10 });
    expect(ranked).toHaveLength(0);
  });

  test("respects maxPatterns", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ id: `p${i}`, avg_duration_ms: i * 100 }));
    const ranked = rankPatterns(rows, KW, { latencyBudgetMs: 1000, maxPatterns: 3 });
    expect(ranked).toHaveLength(3);
  });

  test("ties break toward lower latency", () => {
    const a = row({ id: "a", avg_duration_ms: 500, confidence: 0.9 });
    const b = row({ id: "b", avg_duration_ms: 100, confidence: 0.9 });
    // both within budget → equal perfWeight & score & confidence → latency breaks tie
    const ranked = rankPatterns([a, b], KW, { latencyBudgetMs: 1000, maxPatterns: 10 });
    expect(ranked.map((r) => r.pattern.id)).toEqual(["b", "a"]);
  });

  test("DEFAULT_LATENCY_BUDGET_MS is a sane positive default", () => {
    expect(DEFAULT_LATENCY_BUDGET_MS).toBeGreaterThan(0);
  });
});
