/**
 * `atlas eval` pure-function surface: case loading + validation, filtering,
 * summary arithmetic, regression detection, and the seed-progress sink.
 *
 * The seed-sink block below was formerly `eval-seed-sink.test.ts`; it moved
 * here because it exercises the same module and needs no isolation of its own.
 * `eval-query-json-stdout.test.ts` stays separate — it spawns the real CLI.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  evalSeedSink,
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
  schemaDir: string = "ecommerce",
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
      validateCase({ question: "test", schema: "ecommerce", difficulty: "simple", category: "filter", gold_sql: "SELECT 1" }, "test.yml"),
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
        { id: "t-001", question: "test", schema: "ecommerce", difficulty: "impossible", category: "filter", gold_sql: "SELECT 1" },
        "test.yml",
      ),
    ).toThrow('Invalid difficulty "impossible"');
  });

  test("rejects empty id", () => {
    expect(() =>
      validateCase(
        { id: "  ", question: "test", schema: "ecommerce", difficulty: "simple", category: "filter", gold_sql: "SELECT 1" },
        "test.yml",
      ),
    ).toThrow("Invalid id");
  });

  test("rejects empty question", () => {
    expect(() =>
      validateCase(
        { id: "t-001", question: "", schema: "ecommerce", difficulty: "simple", category: "filter", gold_sql: "SELECT 1" },
        "test.yml",
      ),
    ).toThrow("question");
  });

  test("rejects whitespace-only gold_sql", () => {
    expect(() =>
      validateCase(
        { id: "t-001", question: "Q?", schema: "ecommerce", difficulty: "simple", category: "filter", gold_sql: "   " },
        "test.yml",
      ),
    ).toThrow("gold_sql");
  });

  test("rejects numeric id (YAML auto-casts numbers)", () => {
    expect(() =>
      validateCase(
        { id: 42, question: "Q?", schema: "ecommerce", difficulty: "simple", category: "filter", gold_sql: "SELECT 1" },
        "test.yml",
      ),
    ).toThrow("Invalid id");
  });

  test("accepts valid case", () => {
    expect(() =>
      validateCase(
        { id: "t-001", question: "How many?", schema: "ecommerce", difficulty: "simple", category: "filter", gold_sql: "SELECT 1" },
        "test.yml",
      ),
    ).not.toThrow();
  });

  // The five typeof checks below back the `asserts doc is ValidatedCase`
  // contract — without them the assertion lies and a downstream consumer
  // could push a non-string `category` (etc.) into the `EvalCase` cache.

  test("rejects non-string category (e.g. YAML numeric)", () => {
    expect(() =>
      validateCase(
        { id: "t-001", question: "Q?", schema: "ecommerce", difficulty: "simple", category: 42, gold_sql: "SELECT 1" } as unknown as Record<string, unknown>,
        "test.yml",
      ),
    ).toThrow("Invalid category");
  });

  test("rejects tags that are not a string array", () => {
    expect(() =>
      validateCase(
        { id: "t-001", question: "Q?", schema: "ecommerce", difficulty: "simple", category: "filter", gold_sql: "SELECT 1", tags: [1, 2, 3] } as unknown as Record<string, unknown>,
        "test.yml",
      ),
    ).toThrow("Invalid tags");
  });

  test("rejects non-boolean skip", () => {
    expect(() =>
      validateCase(
        { id: "t-001", question: "Q?", schema: "ecommerce", difficulty: "simple", category: "filter", gold_sql: "SELECT 1", skip: "yes" } as unknown as Record<string, unknown>,
        "test.yml",
      ),
    ).toThrow("Invalid skip");
  });

  test("rejects non-number, non-null expected_rows", () => {
    expect(() =>
      validateCase(
        { id: "t-001", question: "Q?", schema: "ecommerce", difficulty: "simple", category: "filter", gold_sql: "SELECT 1", expected_rows: "5" } as unknown as Record<string, unknown>,
        "test.yml",
      ),
    ).toThrow("Invalid expected_rows");
  });

  test("accepts expected_rows: null (YAML 'unscored' sentinel)", () => {
    expect(() =>
      validateCase(
        { id: "t-001", question: "Q?", schema: "ecommerce", difficulty: "simple", category: "filter", gold_sql: "SELECT 1", expected_rows: null } as unknown as Record<string, unknown>,
        "test.yml",
      ),
    ).not.toThrow();
  });

  test("rejects non-string notes", () => {
    expect(() =>
      validateCase(
        { id: "t-001", question: "Q?", schema: "ecommerce", difficulty: "simple", category: "filter", gold_sql: "SELECT 1", notes: 42 } as unknown as Record<string, unknown>,
        "test.yml",
      ),
    ).toThrow("Invalid notes");
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
        schema: "ecommerce",
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
    expect(cases[0].schema).toBe("ecommerce");
    expect(cases[0].difficulty).toBe("simple");
    expect(cases[0].category).toBe("aggregation");
    expect(cases[0].gold_sql).toBe("SELECT COUNT(*) FROM companies");
  });

  test("loads from multiple files within a schema directory", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-test-"));

    const ecommerceDir = path.join(tmpDir, "ecommerce");
    fs.mkdirSync(ecommerceDir, { recursive: true });
    fs.writeFileSync(
      path.join(ecommerceDir, "ec-001.yml"),
      'id: ec-001\nquestion: "Q1"\nschema: ecommerce\ndifficulty: simple\ncategory: filter\ntags: []\ngold_sql: "SELECT 1"',
    );
    fs.writeFileSync(
      path.join(ecommerceDir, "ec-002.yml"),
      'id: ec-002\nquestion: "Q2"\nschema: ecommerce\ndifficulty: medium\ncategory: join\ntags: []\ngold_sql: "SELECT 2"',
    );

    const cases = loadEvalCases(tmpDir);
    expect(cases).toHaveLength(2);
    const ids = cases.map(c => c.id).sort();
    expect(ids).toEqual(["ec-001", "ec-002"]);
  });

  test("throws on missing directory", () => {
    expect(() => loadEvalCases("/nonexistent/path")).toThrow("Eval cases directory not found");
  });

  test("returns empty for schema directory with no YAML files", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-test-"));
    fs.mkdirSync(path.join(tmpDir, "ecommerce"), { recursive: true });
    const cases = loadEvalCases(tmpDir);
    expect(cases).toHaveLength(0);
  });

  test("defaults tags to empty array when missing from YAML", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-test-"));
    const dir = path.join(tmpDir, "ecommerce");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "ec-001.yml"),
      'id: ec-001\nquestion: "Q1"\nschema: ecommerce\ndifficulty: simple\ncategory: filter\ngold_sql: "SELECT 1"',
    );
    const cases = loadEvalCases(tmpDir);
    expect(cases).toHaveLength(1);
    expect(cases[0].tags).toEqual([]);
  });

  test("loads the real eval/cases/ecommerce/ fixture set without throwing", () => {
    // Catches the class of regression that bit us in #2021 review-pass 5:
    // synthetic test fixtures drifted from real `eval/cases/*.yml` shapes
    // (the strict typeof check on `expected_rows` rejected the YAML null
    // sentinel). Loading the production fixtures end-to-end pins the
    // contract between validateCase and the on-disk YAML format.
    const realCasesDir = path.resolve(__dirname, "../../../../eval/cases");
    const cases = loadEvalCases(realCasesDir);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((c) => c.schema === "ecommerce")).toBe(true);
  });

  test("rejects duplicate case IDs across files", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-test-"));
    const dir = path.join(tmpDir, "ecommerce");
    fs.mkdirSync(dir, { recursive: true });
    const yaml = 'id: dup-001\nquestion: "Q"\nschema: ecommerce\ndifficulty: simple\ncategory: filter\ntags: []\ngold_sql: "SELECT 1"';
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
    { id: "sp-001", question: "Q1", schema: "ecommerce", difficulty: "simple", category: "aggregation", tags: [], gold_sql: "SELECT 1" },
    { id: "sp-002", question: "Q2", schema: "ecommerce", difficulty: "medium", category: "join", tags: [], gold_sql: "SELECT 2" },
    { id: "cs-001", question: "Q3", schema: "ecommerce", difficulty: "simple", category: "filter", tags: [], gold_sql: "SELECT 3" },
    { id: "cs-002", question: "Q4", schema: "ecommerce", difficulty: "complex", category: "aggregation", tags: [], gold_sql: "SELECT 4" },
    { id: "ec-001", question: "Q5", schema: "ecommerce", difficulty: "medium", category: "timeseries", tags: [], gold_sql: "SELECT 5" },
    { id: "sp-skip", question: "Q6", schema: "ecommerce", difficulty: "simple", category: "filter", tags: [], gold_sql: "SELECT 6", skip: true },
  ];

  test("filters by schema", () => {
    const result = filterCases(cases, { schema: "ecommerce" });
    // All non-skipped cases match the canonical ecommerce schema since 1.4.0 (#2021)
    expect(result).toHaveLength(5);
    expect(result.every(c => c.schema === "ecommerce")).toBe(true);
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
    const result = filterCases(cases, { schema: "ecommerce", difficulty: "simple" });
    // sp-001 (aggregation) and cs-001 (filter); sp-skip is excluded by the skip flag
    expect(result).toHaveLength(2);
    expect(result.map(c => c.id).sort()).toEqual(["cs-001", "sp-001"]);
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
    { id: "sp-001", schema: "ecommerce", question: "Q1", category: "aggregation", difficulty: "simple", tags: [], gold_sql: "", predicted_sql: "SELECT 1", match: true, error: null, latency_ms: 1000, tokens: 500, steps: 3 },
    { id: "sp-002", schema: "ecommerce", question: "Q2", category: "join", difficulty: "medium", tags: [], gold_sql: "", predicted_sql: "SELECT 2", match: false, error: null, latency_ms: 2000, tokens: 800, steps: 5 },
    { id: "cs-001", schema: "ecommerce", question: "Q3", category: "filter", difficulty: "simple", tags: [], gold_sql: "", predicted_sql: null, match: false, error: "timeout", latency_ms: 30000, tokens: 0, steps: 0 },
    { id: "cs-002", schema: "ecommerce", question: "Q4", category: "aggregation", difficulty: "complex", tags: [], gold_sql: "", predicted_sql: "SELECT 4", match: true, error: null, latency_ms: 3000, tokens: 1200, steps: 7 },
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
    // All 4 results target the canonical ecommerce schema; 2 of the 4 match
    expect(summary.bySchema.get("ecommerce")).toEqual({ total: 4, correct: 2 });
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
    { id: "sp-001", schema: "ecommerce", question: "Q1", category: "agg", difficulty: "simple", tags: [], gold_sql: "", predicted_sql: "S1", match: true, error: null, latency_ms: 1000, tokens: 500, steps: 3 },
    { id: "sp-002", schema: "ecommerce", question: "Q2", category: "join", difficulty: "medium", tags: [], gold_sql: "", predicted_sql: "S2", match: false, error: null, latency_ms: 2000, tokens: 800, steps: 5 },
    { id: "cs-001", schema: "ecommerce", question: "Q3", category: "filter", difficulty: "simple", tags: [], gold_sql: "", predicted_sql: "S3", match: true, error: null, latency_ms: 1500, tokens: 600, steps: 4 },
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

// ---------------------------------------------------------------------------
// evalSeedSink
//
// `atlas eval`'s seed-progress sink picks the right fd (#5126).
//
// ⚠️ THIS CALL SITE HAD NO TEST OF ANY KIND. `handleEval` is untested end to
// end, and the sink was written inline as
// `(csvOutput || jsonOutput ? process.stderr : process.stdout).write(text)` —
// three plausible one-character mutations from reproducing #5126 one command
// over, all of which survived the whole repo: drop the ternary, swap the arms,
// or forget `csvOutput` (which would pollute the CSV body instead of the JSON
// one). Extracting the resolver is what makes those four lines falsifiable
// without spawning the LLM benchmark.
//
// The truth table is the point, so all four input classes are asserted rather
// than the two that motivated the change.
// ---------------------------------------------------------------------------

/** Capture what the returned sink writes, and to which stream. */
function captureSeedSink(
  options: { csvOutput: boolean; jsonOutput: boolean },
): { fd: 1 | 2; text: string } {
  const seen: Array<{ fd: 1 | 2; text: string }> = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    seen.push({ fd: 1, text: String(chunk) });
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    seen.push({ fd: 2, text: String(chunk) });
    return true;
  }) as typeof process.stderr.write;
  try {
    evalSeedSink(options)("demo loaded\n");
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  // Exactly one write: a sink that echoed to both streams would otherwise
  // satisfy whichever arm the caller happened to assert.
  expect(seen).toHaveLength(1);
  const only = seen[0];
  if (!only) throw new Error("unreachable — length asserted above");
  return only;
}

describe("evalSeedSink", () => {
  test("routes to fd 2 whenever a machine body owns stdout", () => {
    // Each of the three separately, so dropping either disjunct fails.
    expect(captureSeedSink({ csvOutput: false, jsonOutput: true }).fd).toBe(2);
    expect(captureSeedSink({ csvOutput: true, jsonOutput: false }).fd).toBe(2);
    expect(captureSeedSink({ csvOutput: true, jsonOutput: true }).fd).toBe(2);
  });

  test("routes to fd 1 for the human default", () => {
    // The counterpart arm: without it, "always stderr" passes everything above
    // and silently moves the interactive command's progress line.
    expect(captureSeedSink({ csvOutput: false, jsonOutput: false }).fd).toBe(1);
  });

  test("passes the text through unchanged", () => {
    // The sink must not add or trim a newline — `seedDemoPostgres` owns that
    // now, and a sink that re-added `console.log`'s implicit `\n` would produce
    // a blank line in every mode.
    expect(captureSeedSink({ csvOutput: false, jsonOutput: false }).text).toBe(
      "demo loaded\n",
    );
  });
});
