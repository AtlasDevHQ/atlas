import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  loadEvalCases,
  validateCase,
  filterCases,
  computeSummary,
  detectRegressions,
  type EvalCase,
  type EvalResult,
} from "../eval";

// ---------------------------------------------------------------------------
// Helper: create a temp directory with YAML case files
// ---------------------------------------------------------------------------

function writeTempCases(
  cases: Record<string, string>[],
  schemaDir: string = "simple",
): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-test-"));
  const schemaDirPath = path.join(tmpDir, schemaDir);
  fs.mkdirSync(schemaDirPath, { recursive: true });

  for (const c of cases) {
    const id = c.id ?? "test-001";
    fs.writeFileSync(
      path.join(schemaDirPath, `${id}.yml`),
      Object.entries(c)
        .map(([k, v]) => {
          if (k === "tags") return `tags: [${v}]`;
          if (k === "gold_sql") return `gold_sql: |\n  ${v}`;
          return `${k}: ${v}`;
        })
        .join("\n"),
    );
  }

  return tmpDir;
}

// ---------------------------------------------------------------------------
// validateCase
// ---------------------------------------------------------------------------

describe("validateCase", () => {
  test("rejects missing required field", () => {
    expect(() =>
      validateCase({ question: "test", schema: "simple", difficulty: "simple", category: "filter", gold_sql: "SELECT 1" }, "test.yml"),
    ).toThrow('Missing required field "id"');
  });

  test("rejects invalid schema", () => {
    expect(() =>
      validateCase(
        { id: "t-001", question: "test", schema: "invalid", difficulty: "simple", category: "filter", gold_sql: "SELECT 1" },
        "test.yml",
      ),
    ).toThrow('Invalid schema "invalid"');
  });

  test("rejects invalid difficulty", () => {
    expect(() =>
      validateCase(
        { id: "t-001", question: "test", schema: "simple", difficulty: "impossible", category: "filter", gold_sql: "SELECT 1" },
        "test.yml",
      ),
    ).toThrow('Invalid difficulty "impossible"');
  });

  test("rejects empty id", () => {
    expect(() =>
      validateCase(
        { id: "  ", question: "test", schema: "simple", difficulty: "simple", category: "filter", gold_sql: "SELECT 1" },
        "test.yml",
      ),
    ).toThrow("Invalid id");
  });

  test("rejects empty question", () => {
    expect(() =>
      validateCase(
        { id: "t-001", question: "", schema: "simple", difficulty: "simple", category: "filter", gold_sql: "SELECT 1" },
        "test.yml",
      ),
    ).toThrow("question");
  });

  test("rejects whitespace-only gold_sql", () => {
    expect(() =>
      validateCase(
        { id: "t-001", question: "Q?", schema: "simple", difficulty: "simple", category: "filter", gold_sql: "   " },
        "test.yml",
      ),
    ).toThrow("gold_sql");
  });

  test("rejects numeric id (YAML auto-casts numbers)", () => {
    expect(() =>
      validateCase(
        { id: 42, question: "Q?", schema: "simple", difficulty: "simple", category: "filter", gold_sql: "SELECT 1" },
        "test.yml",
      ),
    ).toThrow("Invalid id");
  });

  test("accepts valid case", () => {
    expect(() =>
      validateCase(
        { id: "t-001", question: "How many?", schema: "simple", difficulty: "simple", category: "filter", gold_sql: "SELECT 1" },
        "test.yml",
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadEvalCases
// ---------------------------------------------------------------------------

describe("loadEvalCases", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test("loads cases from YAML files", () => {
    tmpDir = writeTempCases([
      {
        id: "sp-001",
        question: "How many companies?",
        schema: "simple",
        difficulty: "simple",
        category: "aggregation",
        tags: "companies, count",
        gold_sql: "SELECT COUNT(*) FROM companies",
      },
    ]);

    const cases = loadEvalCases(tmpDir);
    expect(cases).toHaveLength(1);
    expect(cases[0].id).toBe("sp-001");
    expect(cases[0].question).toBe("How many companies?");
    expect(cases[0].schema).toBe("simple");
    expect(cases[0].difficulty).toBe("simple");
    expect(cases[0].category).toBe("aggregation");
    expect(cases[0].gold_sql).toBe("SELECT COUNT(*) FROM companies");
  });

  test("loads from multiple schema directories", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-test-"));

    // Simple case
    const simpleDir = path.join(tmpDir, "simple");
    fs.mkdirSync(simpleDir, { recursive: true });
    fs.writeFileSync(
      path.join(simpleDir, "sp-001.yml"),
      'id: sp-001\nquestion: "Q1"\nschema: simple\ndifficulty: simple\ncategory: filter\ntags: []\ngold_sql: "SELECT 1"',
    );

    // Cybersec case
    const cybersecDir = path.join(tmpDir, "cybersec");
    fs.mkdirSync(cybersecDir, { recursive: true });
    fs.writeFileSync(
      path.join(cybersecDir, "cs-001.yml"),
      'id: cs-001\nquestion: "Q2"\nschema: cybersec\ndifficulty: medium\ncategory: join\ntags: []\ngold_sql: "SELECT 2"',
    );

    const cases = loadEvalCases(tmpDir);
    expect(cases).toHaveLength(2);
    const schemas = cases.map(c => c.schema).sort();
    expect(schemas).toEqual(["cybersec", "simple"]);
  });

  test("throws on missing directory", () => {
    expect(() => loadEvalCases("/nonexistent/path")).toThrow("Eval cases directory not found");
  });

  test("returns empty for schema directory with no YAML files", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-test-"));
    fs.mkdirSync(path.join(tmpDir, "simple"), { recursive: true });
    const cases = loadEvalCases(tmpDir);
    expect(cases).toHaveLength(0);
  });

  test("defaults tags to empty array when missing from YAML", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-test-"));
    const dir = path.join(tmpDir, "simple");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "sp-001.yml"),
      'id: sp-001\nquestion: "Q1"\nschema: simple\ndifficulty: simple\ncategory: filter\ngold_sql: "SELECT 1"',
    );
    const cases = loadEvalCases(tmpDir);
    expect(cases).toHaveLength(1);
    expect(cases[0].tags).toEqual([]);
  });

  test("rejects duplicate case IDs across files", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-test-"));
    const dir = path.join(tmpDir, "simple");
    fs.mkdirSync(dir, { recursive: true });
    const yaml = 'id: dup-001\nquestion: "Q"\nschema: simple\ndifficulty: simple\ncategory: filter\ntags: []\ngold_sql: "SELECT 1"';
    fs.writeFileSync(path.join(dir, "a.yml"), yaml);
    fs.writeFileSync(path.join(dir, "b.yml"), yaml);
    expect(() => loadEvalCases(tmpDir)).toThrow('Duplicate eval case id "dup-001"');
  });

  test("throws on invalid case", () => {
    tmpDir = writeTempCases([
      {
        id: "bad-001",
        question: "Missing schema",
        difficulty: "simple",
        category: "filter",
        gold_sql: "SELECT 1",
      } as unknown as Record<string, string>,
    ]);

    expect(() => loadEvalCases(tmpDir)).toThrow('Missing required field "schema"');
  });
});

// ---------------------------------------------------------------------------
// filterCases
// ---------------------------------------------------------------------------

describe("filterCases", () => {
  const cases: EvalCase[] = [
    { id: "sp-001", question: "Q1", schema: "simple", difficulty: "simple", category: "aggregation", tags: [], gold_sql: "SELECT 1" },
    { id: "sp-002", question: "Q2", schema: "simple", difficulty: "medium", category: "join", tags: [], gold_sql: "SELECT 2" },
    { id: "cs-001", question: "Q3", schema: "cybersec", difficulty: "simple", category: "filter", tags: [], gold_sql: "SELECT 3" },
    { id: "cs-002", question: "Q4", schema: "cybersec", difficulty: "complex", category: "aggregation", tags: [], gold_sql: "SELECT 4" },
    { id: "ec-001", question: "Q5", schema: "ecommerce", difficulty: "medium", category: "timeseries", tags: [], gold_sql: "SELECT 5" },
    { id: "sp-skip", question: "Q6", schema: "simple", difficulty: "simple", category: "filter", tags: [], gold_sql: "SELECT 6", skip: true },
  ];

  test("filters by schema", () => {
    const result = filterCases(cases, { schema: "cybersec" });
    expect(result).toHaveLength(2);
    expect(result.every(c => c.schema === "cybersec")).toBe(true);
  });

  test("filters by category", () => {
    const result = filterCases(cases, { category: "aggregation" });
    expect(result).toHaveLength(2);
    expect(result.every(c => c.category === "aggregation")).toBe(true);
  });

  test("filters by difficulty", () => {
    const result = filterCases(cases, { difficulty: "simple" });
    expect(result).toHaveLength(2);
    expect(result.every(c => c.difficulty === "simple")).toBe(true);
  });

  test("filters by id", () => {
    const result = filterCases(cases, { id: "cs-001" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("cs-001");
  });

  test("applies limit", () => {
    const result = filterCases(cases, { limit: 2 });
    expect(result).toHaveLength(2);
  });

  test("excludes skipped cases", () => {
    const result = filterCases(cases, {});
    expect(result.find(c => c.id === "sp-skip")).toBeUndefined();
    expect(result).toHaveLength(5);
  });

  test("combines filters", () => {
    const result = filterCases(cases, { schema: "simple", difficulty: "simple" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("sp-001");
  });

  test("limit of 0 returns all cases (no slicing)", () => {
    const result = filterCases(cases, { limit: 0 });
    expect(result).toHaveLength(5);
  });

  test("returns empty on no match", () => {
    const result = filterCases(cases, { schema: "nonexistent" });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeSummary
// ---------------------------------------------------------------------------

describe("computeSummary", () => {
  const results: EvalResult[] = [
    { id: "sp-001", schema: "simple", question: "Q1", category: "aggregation", difficulty: "simple", tags: [], gold_sql: "", predicted_sql: "SELECT 1", match: true, error: null, latency_ms: 1000, tokens: 500, steps: 3 },
    { id: "sp-002", schema: "simple", question: "Q2", category: "join", difficulty: "medium", tags: [], gold_sql: "", predicted_sql: "SELECT 2", match: false, error: null, latency_ms: 2000, tokens: 800, steps: 5 },
    { id: "cs-001", schema: "cybersec", question: "Q3", category: "filter", difficulty: "simple", tags: [], gold_sql: "", predicted_sql: null, match: false, error: "timeout", latency_ms: 30000, tokens: 0, steps: 0 },
    { id: "cs-002", schema: "cybersec", question: "Q4", category: "aggregation", difficulty: "complex", tags: [], gold_sql: "", predicted_sql: "SELECT 4", match: true, error: null, latency_ms: 3000, tokens: 1200, steps: 7 },
  ];

  test("computes overall accuracy", () => {
    const summary = computeSummary(results);
    expect(summary.total).toBe(4);
    expect(summary.correct).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.accuracy).toBe(50);
  });

  test("computes per-schema breakdown", () => {
    const summary = computeSummary(results);
    expect(summary.bySchema.get("simple")).toEqual({ total: 2, correct: 1 });
    expect(summary.bySchema.get("cybersec")).toEqual({ total: 2, correct: 1 });
  });

  test("computes per-category breakdown", () => {
    const summary = computeSummary(results);
    expect(summary.byCategory.get("aggregation")).toEqual({ total: 2, correct: 2 });
    expect(summary.byCategory.get("join")).toEqual({ total: 1, correct: 0 });
    expect(summary.byCategory.get("filter")).toEqual({ total: 1, correct: 0 });
  });

  test("computes per-difficulty breakdown", () => {
    const summary = computeSummary(results);
    expect(summary.byDifficulty.get("simple")).toEqual({ total: 2, correct: 1 });
    expect(summary.byDifficulty.get("medium")).toEqual({ total: 1, correct: 0 });
    expect(summary.byDifficulty.get("complex")).toEqual({ total: 1, correct: 1 });
  });

  test("computes token and latency stats", () => {
    const summary = computeSummary(results);
    expect(summary.totalTokens).toBe(2500);
    expect(summary.totalLatencyMs).toBe(36000);
    expect(summary.avgLatencyMs).toBe(9000);
  });

  test("handles empty results", () => {
    const summary = computeSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.correct).toBe(0);
    expect(summary.accuracy).toBe(0);
    expect(summary.avgLatencyMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectRegressions
// ---------------------------------------------------------------------------

describe("detectRegressions", () => {
  const baseline: EvalResult[] = [
    { id: "sp-001", schema: "simple", question: "Q1", category: "agg", difficulty: "simple", tags: [], gold_sql: "", predicted_sql: "S1", match: true, error: null, latency_ms: 1000, tokens: 500, steps: 3 },
    { id: "sp-002", schema: "simple", question: "Q2", category: "join", difficulty: "medium", tags: [], gold_sql: "", predicted_sql: "S2", match: false, error: null, latency_ms: 2000, tokens: 800, steps: 5 },
    { id: "cs-001", schema: "cybersec", question: "Q3", category: "filter", difficulty: "simple", tags: [], gold_sql: "", predicted_sql: "S3", match: true, error: null, latency_ms: 1500, tokens: 600, steps: 4 },
  ];

  test("detects regression (was pass, now fail)", () => {
    const current: EvalResult[] = [
      { ...baseline[0], match: false, error: "wrong result" },  // sp-001: was PASS → now FAIL
      { ...baseline[1], match: false },                          // sp-002: was FAIL → still FAIL
      { ...baseline[2], match: true },                           // cs-001: was PASS → still PASS
    ];

    const report = detectRegressions(current, baseline);
    expect(report.regressions).toHaveLength(1);
    expect(report.regressions[0].id).toBe("sp-001");
    expect(report.newPasses).toHaveLength(0);
    expect(report.newCases).toHaveLength(0);
    expect(report.stable).toBe(2);
  });

  test("detects new pass (was fail, now pass)", () => {
    const current: EvalResult[] = [
      { ...baseline[0], match: true },                           // sp-001: still PASS
      { ...baseline[1], match: true },                           // sp-002: was FAIL → now PASS
      { ...baseline[2], match: true },                           // cs-001: still PASS
    ];

    const report = detectRegressions(current, baseline);
    expect(report.regressions).toHaveLength(0);
    expect(report.newPasses).toHaveLength(1);
    expect(report.newPasses[0].id).toBe("sp-002");
    expect(report.stable).toBe(2);
  });

  test("detects new cases (not in baseline)", () => {
    const current: EvalResult[] = [
      { ...baseline[0], match: true },
      { ...baseline[1], match: false },
      { ...baseline[2], match: true },
      { id: "ec-001", schema: "ecommerce", question: "New Q", category: "agg", difficulty: "simple", tags: [], gold_sql: "", predicted_sql: "S4", match: true, error: null, latency_ms: 1000, tokens: 500, steps: 3 },
    ];

    const report = detectRegressions(current, baseline);
    expect(report.newCases).toHaveLength(1);
    expect(report.newCases[0].id).toBe("ec-001");
    expect(report.stable).toBe(3);
  });

  test("handles empty baseline", () => {
    const current: EvalResult[] = [
      { ...baseline[0], match: true },
    ];

    const report = detectRegressions(current, []);
    expect(report.newCases).toHaveLength(1);
    expect(report.regressions).toHaveLength(0);
    expect(report.stable).toBe(0);
  });

  test("handles empty current", () => {
    const report = detectRegressions([], baseline);
    expect(report.regressions).toHaveLength(0);
    expect(report.newPasses).toHaveLength(0);
    expect(report.newCases).toHaveLength(0);
    expect(report.stable).toBe(0);
  });

  test("baseline cases absent from current are silently ignored", () => {
    const current: EvalResult[] = [
      { ...baseline[0], match: true },
    ];
    const report = detectRegressions(current, baseline);
    expect(report.regressions).toHaveLength(0);
    expect(report.newPasses).toHaveLength(0);
    expect(report.newCases).toHaveLength(0);
    expect(report.stable).toBe(1);
  });
});
