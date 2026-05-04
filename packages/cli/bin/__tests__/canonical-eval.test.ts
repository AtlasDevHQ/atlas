/**
 * Tests for the canonical-question eval runner core.
 *
 * The runner is split so the loader, the per-mode comparators, the formatter,
 * and the resolveQuestion dispatcher are all pure (DB-free) and testable.
 * The CLI driver in `canonical-eval-run.ts` provides the real DB / semantic
 * wiring; these tests inject stubs.
 */

import { describe, expect, test } from "bun:test";
import * as path from "path";
import {
  loadQuestions,
  compareMetricResult,
  compareGlossaryResult,
  compareVirtualResult,
  comparePatternResult,
  formatSummary,
  resolveQuestion,
  runHarness,
  type Question,
  type ExecutedQuery,
  type RunHarnessOptions,
  type GlossaryMatch,
} from "../canonical-eval";

const QUESTIONS_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "eval",
  "canonical-questions",
  "questions.yml",
);

describe("loadQuestions", () => {
  test("loads the curated set without throwing", () => {
    const questions = loadQuestions(QUESTIONS_PATH);
    expect(questions.length).toBeGreaterThanOrEqual(20);
  });

  test("every question has a unique id", () => {
    const questions = loadQuestions(QUESTIONS_PATH);
    const ids = new Set(questions.map((q) => q.id));
    expect(ids.size).toBe(questions.length);
  });

  test("ids follow the cq-NNN convention", () => {
    const questions = loadQuestions(QUESTIONS_PATH);
    for (const q of questions) {
      expect(q.id).toMatch(/^cq-\d{3}$/);
    }
  });

  test("every metric/pattern/virtual question carries the fields its mode needs", () => {
    const questions = loadQuestions(QUESTIONS_PATH);
    for (const q of questions) {
      switch (q.mode) {
        case "metric":
          expect(q.metric_id).toBeTruthy();
          break;
        case "pattern":
          expect(q.entity).toBeTruthy();
          expect(q.pattern).toBeTruthy();
          break;
        case "virtual":
          expect(q.entity).toBeTruthy();
          expect(q.dimension).toBeTruthy();
          expect(q.sql).toBeTruthy();
          break;
        case "glossary":
          expect(q.term).toBeTruthy();
          break;
      }
    }
  });

  test("covers every required category from the issue", () => {
    const questions = loadQuestions(QUESTIONS_PATH);
    const categories: Set<string> = new Set(questions.map((q) => q.category));
    for (const required of [
      "simple_metric",
      "segmentation",
      "join",
      "timeseries",
      "virtual_dimension",
      "glossary",
      "filtered_pattern",
    ]) {
      expect(categories.has(required)).toBe(true);
    }
  });

  test("rejects a duplicate id", async () => {
    // Use a temporary file with a forced duplicate.
    const fs = await import("fs");
    const os = await import("os");
    const tmp = path.join(os.tmpdir(), `dup-${Date.now()}.yml`);
    fs.writeFileSync(
      tmp,
      "version: '1.0'\nquestions:\n" +
        "  - id: cq-001\n    category: simple_metric\n    question: a\n    mode: metric\n    metric_id: x\n    expect: {}\n" +
        "  - id: cq-001\n    category: simple_metric\n    question: b\n    mode: metric\n    metric_id: y\n    expect: {}\n",
    );
    expect(() => loadQuestions(tmp)).toThrow(/Duplicate/);
    fs.unlinkSync(tmp);
  });
});

// ── compareMetricResult ──────────────────────────────────────────────────

describe("compareMetricResult", () => {
  const baseQuestion: Question = {
    id: "cq-001",
    category: "simple_metric",
    question: "Test",
    mode: "metric",
    metric_id: "total_gmv",
    expect: {
      sql_pattern: ["SUM(total_cents)", "FROM orders"],
      non_zero: true,
    },
  };

  test("passes when SQL contains every required substring and value is non-zero", () => {
    const executed: ExecutedQuery = {
      sql: "SELECT SUM(total_cents) / 100.0 AS total_gmv FROM orders WHERE status != 'cancelled'",
      columns: ["total_gmv"],
      rows: [{ total_gmv: 12345.67 }],
    };
    expect(compareMetricResult(baseQuestion, executed).status).toBe("pass");
  });

  test("fails when an expected SQL substring is missing", () => {
    const executed: ExecutedQuery = {
      sql: "SELECT 42 AS total_gmv",
      columns: ["total_gmv"],
      rows: [{ total_gmv: 42 }],
    };
    const result = compareMetricResult(baseQuestion, executed);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/SUM\(total_cents\)/);
  });

  test("fails when non_zero is required and result is 0", () => {
    const executed: ExecutedQuery = {
      sql: "SELECT SUM(total_cents) / 100.0 AS total_gmv FROM orders",
      columns: ["total_gmv"],
      rows: [{ total_gmv: 0 }],
    };
    const result = compareMetricResult(baseQuestion, executed);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/non-zero/);
  });

  test("warns when SQL pattern matches but row count violates a soft bound", () => {
    const segQ: Question = {
      ...baseQuestion,
      id: "cq-005",
      expect: {
        sql_pattern: ["GROUP BY"],
        min_rows: 2,
      },
    };
    const executed: ExecutedQuery = {
      sql: "SELECT a, COUNT(*) FROM t GROUP BY a",
      columns: ["a", "count"],
      rows: [{ a: "x", count: 1 }],
    };
    const result = compareMetricResult(segQ, executed);
    expect(result.status).toBe("warn");
    expect(result.detail).toMatch(/min_rows/);
  });

  test("checks expected column is present", () => {
    const q: Question = {
      ...baseQuestion,
      expect: { sql_pattern: ["SELECT"], column: "total_gmv" },
    };
    const ok: ExecutedQuery = {
      sql: "SELECT 1 AS total_gmv",
      columns: ["total_gmv"],
      rows: [{ total_gmv: 1 }],
    };
    expect(compareMetricResult(q, ok).status).toBe("pass");

    const bad: ExecutedQuery = {
      sql: "SELECT 1 AS revenue",
      columns: ["revenue"],
      rows: [{ revenue: 1 }],
    };
    expect(compareMetricResult(q, bad).status).toBe("fail");
  });

  // ── non_zero edge cases ────────────────────────────────────────────────
  // The non_zero check coerces via Number(), so null / numeric strings
  // need to behave the way the canonical questions expect.

  test("non_zero with empty rows fails", () => {
    const q: Question = {
      ...baseQuestion,
      expect: { sql_pattern: [], non_zero: true },
    };
    const executed: ExecutedQuery = {
      sql: "SELECT SUM(total_cents) AS v FROM orders",
      columns: ["v"],
      rows: [],
    };
    const result = compareMetricResult(q, executed);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/empty/);
  });

  test("non_zero with a null first cell fails", () => {
    const q: Question = {
      ...baseQuestion,
      expect: { sql_pattern: [], non_zero: true },
    };
    const executed: ExecutedQuery = {
      sql: "SELECT SUM(total_cents) AS v FROM orders",
      columns: ["v"],
      rows: [{ v: null }],
    };
    const result = compareMetricResult(q, executed);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/non-zero/);
  });

  test('non_zero with the string "0" fails (numeric coercion)', () => {
    const q: Question = {
      ...baseQuestion,
      expect: { sql_pattern: [], non_zero: true },
    };
    const executed: ExecutedQuery = {
      sql: "SELECT SUM(total_cents) AS v FROM orders",
      columns: ["v"],
      rows: [{ v: "0" }],
    };
    const result = compareMetricResult(q, executed);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/non-zero/);
  });

  test('non_zero with the string "42" passes (numeric coercion)', () => {
    const q: Question = {
      ...baseQuestion,
      expect: { sql_pattern: [], non_zero: true },
    };
    const executed: ExecutedQuery = {
      sql: "SELECT SUM(total_cents) AS v FROM orders",
      columns: ["v"],
      rows: [{ v: "42" }],
    };
    expect(compareMetricResult(q, executed).status).toBe("pass");
  });

  // ── min_rows / max_rows boundaries ─────────────────────────────────────

  test("max_rows boundary: rowCount === max_rows passes", () => {
    const q: Question = {
      ...baseQuestion,
      expect: { sql_pattern: [], max_rows: 2 },
    };
    const executed: ExecutedQuery = {
      sql: "SELECT 1",
      columns: ["v"],
      rows: [{ v: 1 }, { v: 2 }],
    };
    expect(compareMetricResult(q, executed).status).toBe("pass");
  });

  test("max_rows boundary: rowCount > max_rows warns", () => {
    const q: Question = {
      ...baseQuestion,
      expect: { sql_pattern: [], max_rows: 2 },
    };
    const executed: ExecutedQuery = {
      sql: "SELECT 1",
      columns: ["v"],
      rows: [{ v: 1 }, { v: 2 }, { v: 3 }],
    };
    const result = compareMetricResult(q, executed);
    expect(result.status).toBe("warn");
    expect(result.detail).toMatch(/max_rows=2/);
  });

  test("min_rows: 0 with rowCount === 0 passes", () => {
    const q: Question = {
      ...baseQuestion,
      expect: { sql_pattern: [], min_rows: 0 },
    };
    const executed: ExecutedQuery = {
      sql: "SELECT 1 WHERE FALSE",
      columns: ["v"],
      rows: [],
    };
    expect(compareMetricResult(q, executed).status).toBe("pass");
  });
});

// ── compareGlossaryResult ────────────────────────────────────────────────

describe("compareGlossaryResult", () => {
  test("passes when ambiguous status with enough mappings", () => {
    const q: Question = {
      id: "cq-013",
      category: "glossary",
      question: "x",
      mode: "glossary",
      term: "revenue",
      expect: { status: "ambiguous", mappings_min: 2 },
    };
    const result = compareGlossaryResult(q, [
      {
        term: "revenue",
        status: "ambiguous",
        possible_mappings: ["a", "b", "c"],
      },
    ]);
    expect(result.status).toBe("pass");
  });

  test("fails when expected ambiguous but term is defined", () => {
    const q: Question = {
      id: "cq-013",
      category: "glossary",
      question: "x",
      mode: "glossary",
      term: "revenue",
      expect: { status: "ambiguous" },
    };
    const result = compareGlossaryResult(q, [
      { term: "revenue", status: "defined", possible_mappings: [] },
    ]);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/expected.*ambiguous/i);
  });

  test("fails when no glossary term matches", () => {
    const q: Question = {
      id: "cq-013",
      category: "glossary",
      question: "x",
      mode: "glossary",
      term: "totally_unknown_term",
      expect: { status: "ambiguous" },
    };
    const result = compareGlossaryResult(q, []);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/no glossary match/i);
  });

  test("fails when ambiguous but mappings count is too low", () => {
    const q: Question = {
      id: "cq-013",
      category: "glossary",
      question: "x",
      mode: "glossary",
      term: "revenue",
      expect: { status: "ambiguous", mappings_min: 3 },
    };
    const result = compareGlossaryResult(q, [
      { term: "revenue", status: "ambiguous", possible_mappings: ["a", "b"] },
    ]);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/mapping/i);
  });

  test("passes when expected status is `defined` and the match is `defined`", () => {
    const q: Question = {
      id: "cq-100",
      category: "glossary",
      question: "x",
      mode: "glossary",
      term: "customer",
      expect: { status: "defined" },
    };
    const result = compareGlossaryResult(q, [
      { term: "customer", status: "defined", possible_mappings: [] },
    ]);
    expect(result.status).toBe("pass");
    expect(result.detail).toBe("defined");
  });

  test("passes when no expected status is set and any match is returned", () => {
    const q: Question = {
      id: "cq-101",
      category: "glossary",
      question: "x",
      mode: "glossary",
      term: "revenue",
      expect: {},
    };
    const result = compareGlossaryResult(q, [
      { term: "revenue", status: "ambiguous", possible_mappings: ["a"] },
    ]);
    expect(result.status).toBe("pass");
    expect(result.detail).toMatch(/match/);
  });
});

// ── compareVirtualResult / comparePatternResult ──────────────────────────

describe("compareVirtualResult / comparePatternResult", () => {
  test("virtual mode passes when SQL executes and column is present", () => {
    const q: Question = {
      id: "cq-011",
      category: "virtual_dimension",
      question: "x",
      mode: "virtual",
      entity: "Orders",
      dimension: "order_size_bucket",
      sql: "SELECT 'Small' AS order_size_bucket, 10 AS c",
      expect: { min_rows: 1, column: "order_size_bucket" },
    };
    const executed: ExecutedQuery = {
      sql: "SELECT 'Small' AS order_size_bucket, 10 AS c",
      columns: ["order_size_bucket", "c"],
      rows: [{ order_size_bucket: "Small", c: 10 }],
    };
    expect(compareVirtualResult(q, executed).status).toBe("pass");
  });

  test("pattern mode requires every sql_pattern substring", () => {
    const q: Question = {
      id: "cq-016",
      category: "filtered_pattern",
      question: "x",
      mode: "pattern",
      entity: "Orders",
      pattern: "orders_with_promotions",
      expect: {
        sql_pattern: ["WHERE status != 'cancelled'", "promotion_id IS NOT NULL"],
      },
    };
    const ok: ExecutedQuery = {
      sql: "SELECT promotion_id IS NOT NULL FROM orders WHERE status != 'cancelled'",
      columns: ["promo_status"],
      rows: [{ promo_status: "Promoted" }],
    };
    expect(comparePatternResult(q, ok).status).toBe("pass");
    const missing: ExecutedQuery = {
      sql: "SELECT 1 FROM orders",
      columns: [],
      rows: [],
    };
    expect(comparePatternResult(q, missing).status).toBe("fail");
  });
});

// ── formatSummary ────────────────────────────────────────────────────────

describe("formatSummary", () => {
  test("renders X/N passing with category breakdown", () => {
    const out = formatSummary([
      {
        question: { id: "cq-001", category: "simple_metric", mode: "metric" } as Question,
        status: "pass",
        detail: "ok",
        sql: "SELECT 1",
      },
      {
        question: { id: "cq-002", category: "simple_metric", mode: "metric" } as Question,
        status: "fail",
        detail: "boom",
        sql: null,
      },
      {
        question: { id: "cq-013", category: "glossary", mode: "glossary" } as Question,
        status: "warn",
        detail: "soft",
        sql: null,
      },
    ]);
    expect(out).toMatch(/1\/3 passing/);
    expect(out).toMatch(/cq-001/);
    expect(out).toMatch(/cq-002/);
    expect(out).toMatch(/cq-013/);
  });
});

// ── resolveQuestion / runHarness ─────────────────────────────────────────

describe("resolveQuestion", () => {
  function makeOpts(overrides: Partial<RunHarnessOptions>): RunHarnessOptions {
    return {
      findMetricSql: () => null,
      findPatternSql: () => null,
      searchGlossary: () => [],
      executeSql: async () => ({ columns: [], rows: [] }),
      ...overrides,
    };
  }

  test("metric mode returns fail when metric is unknown", async () => {
    const q: Question = {
      id: "cq-099",
      category: "simple_metric",
      question: "x",
      mode: "metric",
      metric_id: "missing",
      expect: { sql_pattern: ["FROM orders"] },
    };
    const r = await resolveQuestion(q, makeOpts({ findMetricSql: () => null }));
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/unknown metric/);
  });

  test("metric mode dispatches sql + asserts patterns + non-zero", async () => {
    const q: Question = {
      id: "cq-001",
      category: "simple_metric",
      question: "x",
      mode: "metric",
      metric_id: "total_gmv",
      expect: { sql_pattern: ["FROM orders"], non_zero: true, column: "v" },
    };
    const r = await resolveQuestion(
      q,
      makeOpts({
        findMetricSql: () => "SELECT 42 AS v FROM orders",
        executeSql: async () => ({ columns: ["v"], rows: [{ v: 42 }] }),
      }),
    );
    expect(r.status).toBe("pass");
    expect(r.sql).toContain("FROM orders");
  });

  test("pattern mode fails when entity/pattern unknown", async () => {
    const q: Question = {
      id: "cq-016",
      category: "filtered_pattern",
      question: "x",
      mode: "pattern",
      entity: "Orders",
      pattern: "missing",
      expect: { sql_pattern: [] },
    };
    const r = await resolveQuestion(q, makeOpts({ findPatternSql: () => null }));
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/unknown query_pattern/);
  });

  test("virtual mode runs the inline SQL straight from the question", async () => {
    const q: Question = {
      id: "cq-011",
      category: "virtual_dimension",
      question: "x",
      mode: "virtual",
      entity: "Orders",
      dimension: "order_size_bucket",
      sql: "SELECT 'Small' AS order_size_bucket",
      expect: { column: "order_size_bucket" },
    };
    const r = await resolveQuestion(
      q,
      makeOpts({
        executeSql: async () => ({
          columns: ["order_size_bucket"],
          rows: [{ order_size_bucket: "Small" }],
        }),
      }),
    );
    expect(r.status).toBe("pass");
  });

  test("glossary mode hits the disambiguation contract", async () => {
    const q: Question = {
      id: "cq-013",
      category: "glossary",
      question: "x",
      mode: "glossary",
      term: "revenue",
      expect: { status: "ambiguous", mappings_min: 2 },
    };
    const matches: GlossaryMatch[] = [
      { term: "revenue", status: "ambiguous", possible_mappings: ["a", "b"] },
    ];
    const r = await resolveQuestion(q, makeOpts({ searchGlossary: () => matches }));
    expect(r.status).toBe("pass");
  });

  test("execute errors are surfaced as fail (not thrown)", async () => {
    const q: Question = {
      id: "cq-001",
      category: "simple_metric",
      question: "x",
      mode: "metric",
      metric_id: "total_gmv",
      expect: { sql_pattern: [] },
    };
    const r = await resolveQuestion(
      q,
      makeOpts({
        findMetricSql: () => "SELECT 1",
        executeSql: async () => {
          throw new Error("connection refused");
        },
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/connection refused/);
  });
});

describe("runHarness", () => {
  // Build SQL that satisfies every metric question's `sql_pattern` substrings
  // by id, sourced directly from the curated questions. This makes the test
  // a real regression gate — if a comparator stops matching, the count of
  // passes drops and the assertion below catches it.
  const metricSqlForId: Record<string, string> = {
    total_gmv: "SELECT SUM(total_cents) AS v FROM orders",
    total_customers: "SELECT COUNT(DISTINCT id) AS v FROM customers",
    aov: "SELECT AVG(total_cents) AS v FROM orders",
    revenue_by_category:
      "SELECT 1 AS v FROM order_items JOIN categories GROUP BY 1",
    customers_by_acquisition_source:
      "SELECT LOWER(acquisition_source) AS channel, 1 FROM customers GROUP BY 1",
    inventory_health:
      "SELECT 'Adequate' AS stock_status, 1 AS v FROM inventory_levels GROUP BY 1",
    revenue_dtc_vs_marketplace:
      "SELECT 'DTC' AS channel, 1 AS v FROM orders JOIN products ON p WHERE seller_id IS NULL GROUP BY 1",
    top_customers_by_spend: "SELECT 1 AS v FROM customers JOIN orders ON o",
    monthly_gmv_trend:
      "SELECT TO_CHAR(created_at, 'YYYY-MM') AS month, 1 AS v FROM orders GROUP BY 1",
    new_customers_by_month:
      "SELECT TO_CHAR(created_at, 'YYYY-MM') AS month, 1 AS v FROM customers GROUP BY 1",
    refund_rate:
      "SELECT 1.0 AS refund_rate FROM payments WHERE COUNT(*) FILTER (WHERE status = 'refunded') > 0",
    return_rate: "SELECT 1.0 AS return_rate FROM orders LEFT JOIN returns r ON r.id = id",
    carrier_performance:
      "SELECT 'UPS' AS carrier, 1 AS v FROM shipments GROUP BY carrier",
  };

  const patternSqlFor: Record<string, string> = {
    "Orders/orders_with_promotions":
      "SELECT 'Promoted' AS promo_status FROM orders WHERE status != 'cancelled' AND promotion_id IS NOT NULL",
    "Products/dtc_vs_marketplace":
      "SELECT 'DTC' AS channel FROM products WHERE status = 'active' AND seller_id IS NULL",
  };

  test("runs every question through resolveQuestion with the same opts", async () => {
    let calls = 0;
    const results = await runHarness({
      findMetricSql: (id) => {
        calls++;
        return metricSqlForId[id] ?? "SELECT 1 AS v";
      },
      findPatternSql: (entity, pattern) =>
        patternSqlFor[`${entity}/${pattern}`] ?? null,
      // All three glossary questions assert `status: "ambiguous"` with
      // `mappings_min: 2`, so this stub satisfies them.
      searchGlossary: (term) => [
        { term, status: "ambiguous", possible_mappings: ["a.b", "c.d"] },
      ],
      // Synthetic executor — returns shape sufficient for every column /
      // row-bounds check on the curated set.
      executeSql: async (sql) => {
        const lower = sql.toLowerCase();
        if (lower.includes("from inventory_levels")) {
          return {
            columns: ["stock_status"],
            rows: [{ stock_status: "Adequate" }],
          };
        }
        if (lower.includes("seller_id is null") && lower.includes("products")) {
          return { columns: ["channel"], rows: [{ channel: "DTC" }] };
        }
        if (lower.includes("promotion_id is not null")) {
          return {
            columns: ["promo_status"],
            rows: [{ promo_status: "Promoted" }],
          };
        }
        return {
          columns: [
            "v",
            "month",
            "channel",
            "carrier",
            "promo_status",
            "refund_rate",
            "return_rate",
            "order_size_bucket",
            "price_tier",
            "stock_status",
          ],
          rows: [
            {
              v: 42,
              month: "2024-01",
              channel: "DTC",
              carrier: "UPS",
              promo_status: "Promoted",
              refund_rate: 1,
              return_rate: 1,
              order_size_bucket: "Small",
              price_tier: "Budget",
              stock_status: "Adequate",
            },
          ],
        };
      },
    });

    // Assert specific counts so the test is a real regression gate. If a
    // comparator silently stops matching, the pass count drops and the
    // assertion fires.
    const passCount = results.filter((r) => r.status === "pass").length;
    const failCount = results.filter((r) => r.status === "fail").length;
    const warnCount = results.filter((r) => r.status === "warn").length;
    expect(results.length).toBe(20);
    expect(passCount + failCount + warnCount).toBe(results.length);
    // With the wired-in stubs, every question should pass — the stubs
    // are crafted to satisfy each curated `expect:` block.
    expect(passCount).toBe(20);
    expect(failCount).toBe(0);
    expect(warnCount).toBe(0);
    expect(calls).toBeGreaterThan(0);
  });
});
