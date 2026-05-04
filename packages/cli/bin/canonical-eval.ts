/**
 * Canonical-question eval harness — pure runner core.
 *
 * Proves the consolidated NovaMart demo dataset (#2021) returns correct
 * answers to a curated question set (`eval/canonical-questions/questions.yml`).
 *
 * Why a separate harness from the LLM eval (`bin/eval.ts`):
 *   - `bin/eval.ts` is the SQL-quality LLM benchmark (gold SQL, single shot,
 *     LLM nondeterminism) and is run with `bun run atlas -- eval`.
 *   - This harness is the *semantic-layer correctness* gate. It calls metric
 *     SQL exactly as the typed MCP `runMetric` tool would, asserts ambiguous
 *     glossary terms still trigger disambiguation, and proves
 *     `query_patterns:` / `virtual:` dimensions compile against the seed.
 *
 * The runner is split so the loader and per-mode comparators stay pure
 * (DB-free, no semantic-root resolution) and unit-testable. The CLI driver
 * in `canonical-eval-run.ts` injects the real SQL executor / semantic
 * lookup; tests inject stubs.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

// ── Types ────────────────────────────────────────────────────────────────

export type QuestionMode = "metric" | "pattern" | "virtual" | "glossary";

export type QuestionCategory =
  | "simple_metric"
  | "segmentation"
  | "join"
  | "timeseries"
  | "virtual_dimension"
  | "glossary"
  | "filtered_pattern";

export interface QuestionExpectations {
  /** Case-insensitive substrings that must appear in the executed SQL. */
  readonly sql_pattern?: readonly string[];
  /** Lower bound on row count. */
  readonly min_rows?: number;
  /** Upper bound on row count. */
  readonly max_rows?: number;
  /** Scalar metric must return a non-zero numeric value. */
  readonly non_zero?: boolean;
  /** Named column must appear in the result columns. */
  readonly column?: string;
  /** Glossary status (`defined` / `ambiguous`). */
  readonly status?: "defined" | "ambiguous";
  /** Minimum number of `possible_mappings` on an ambiguous glossary term. */
  readonly mappings_min?: number;
}

export interface Question {
  readonly id: string;
  readonly category: QuestionCategory;
  readonly question: string;
  readonly mode: QuestionMode;
  readonly metric_id?: string;
  readonly entity?: string;
  readonly pattern?: string;
  readonly dimension?: string;
  readonly sql?: string;
  readonly term?: string;
  readonly expect: QuestionExpectations;
}

/**
 * Wire shape returned by an executed SQL query — used by both the metric /
 * pattern / virtual comparators and the `RunHarnessOptions.executeSql`
 * dependency. Extracted so the CLI driver and tests share a single source
 * of truth for what `executeSql` returns.
 */
export interface SqlQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}

export interface ExecutedQuery extends SqlQueryResult {
  readonly sql: string;
}

/**
 * Glossary status values recognised by the harness. The literal
 * `"ambiguous"` is load-bearing — agent clients are instructed to surface
 * ambiguity to the user instead of silently picking a mapping. `null`
 * means the underlying YAML omitted a status.
 */
export type GlossaryStatus = "defined" | "ambiguous";

export interface GlossaryMatch {
  readonly term: string;
  readonly status: GlossaryStatus | null;
  readonly possible_mappings: readonly string[];
}

export type ResultStatus = "pass" | "warn" | "fail";

export interface QuestionResult {
  readonly question: Question;
  readonly status: ResultStatus;
  readonly detail: string;
  readonly sql: string | null;
}

interface QuestionsFile {
  readonly version?: string;
  readonly schema?: string;
  readonly questions: readonly unknown[];
}

const VALID_MODES: ReadonlySet<QuestionMode> = new Set([
  "metric",
  "pattern",
  "virtual",
  "glossary",
]);

const VALID_CATEGORIES: ReadonlySet<QuestionCategory> = new Set([
  "simple_metric",
  "segmentation",
  "join",
  "timeseries",
  "virtual_dimension",
  "glossary",
  "filtered_pattern",
]);

// ── Loader ───────────────────────────────────────────────────────────────

export function loadQuestions(filePath: string): Question[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Canonical questions file not found: ${filePath}`);
  }

  const raw = yaml.load(fs.readFileSync(filePath, "utf-8"));
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid questions file (not an object): ${filePath}`);
  }

  const file = raw as QuestionsFile;
  if (!Array.isArray(file.questions)) {
    throw new Error(`questions: array missing in ${filePath}`);
  }

  const seen = new Set<string>();
  const out: Question[] = [];

  for (let i = 0; i < file.questions.length; i++) {
    const rawQ = file.questions[i];
    if (!rawQ || typeof rawQ !== "object") {
      throw new Error(`questions[${i}] is not an object in ${filePath}`);
    }
    const q = rawQ as Partial<Question>;

    if (typeof q.id !== "string" || !/^cq-\d{3}$/.test(q.id)) {
      throw new Error(
        `questions[${i}].id must match /^cq-\\d{3}$/ in ${filePath} (got ${String(q.id)})`,
      );
    }
    if (seen.has(q.id)) {
      throw new Error(`Duplicate question id "${q.id}" in ${filePath}`);
    }
    seen.add(q.id);

    if (typeof q.question !== "string" || !q.question.trim()) {
      throw new Error(`${q.id}: question must be a non-empty string`);
    }
    if (typeof q.mode !== "string" || !VALID_MODES.has(q.mode as QuestionMode)) {
      throw new Error(
        `${q.id}: mode must be one of ${[...VALID_MODES].join(", ")} (got ${String(q.mode)})`,
      );
    }
    if (
      typeof q.category !== "string" ||
      !VALID_CATEGORIES.has(q.category as QuestionCategory)
    ) {
      throw new Error(
        `${q.id}: category must be one of ${[...VALID_CATEGORIES].join(", ")} (got ${String(q.category)})`,
      );
    }
    if (!q.expect || typeof q.expect !== "object") {
      throw new Error(`${q.id}: expect must be an object`);
    }

    const mode = q.mode as QuestionMode;
    if (mode === "metric" && !q.metric_id) {
      throw new Error(`${q.id}: metric mode requires metric_id`);
    }
    if (mode === "pattern" && (!q.entity || !q.pattern)) {
      throw new Error(`${q.id}: pattern mode requires entity + pattern`);
    }
    if (mode === "virtual" && (!q.entity || !q.dimension || !q.sql)) {
      throw new Error(`${q.id}: virtual mode requires entity + dimension + sql`);
    }
    if (mode === "glossary" && !q.term) {
      throw new Error(`${q.id}: glossary mode requires term`);
    }

    out.push(q as Question);
  }

  return out;
}

// ── Per-mode comparators ────────────────────────────────────────────────

function checkSqlPattern(
  expectations: QuestionExpectations,
  sql: string,
): string | null {
  const patterns = expectations.sql_pattern ?? [];
  const haystack = sql.toLowerCase();
  for (const needle of patterns) {
    if (!haystack.includes(needle.toLowerCase())) {
      return `expected SQL to include ${JSON.stringify(needle)}`;
    }
  }
  return null;
}

function checkRowBounds(
  expectations: QuestionExpectations,
  rowCount: number,
): { kind: "pass" } | { kind: "warn"; detail: string } {
  if (typeof expectations.min_rows === "number" && rowCount < expectations.min_rows) {
    return {
      kind: "warn",
      detail: `min_rows=${expectations.min_rows}, got ${rowCount}`,
    };
  }
  if (typeof expectations.max_rows === "number" && rowCount > expectations.max_rows) {
    return {
      kind: "warn",
      detail: `max_rows=${expectations.max_rows}, got ${rowCount}`,
    };
  }
  return { kind: "pass" };
}

function checkColumn(
  expectations: QuestionExpectations,
  columns: readonly string[],
): string | null {
  if (!expectations.column) return null;
  if (!columns.includes(expectations.column)) {
    return `expected column ${JSON.stringify(expectations.column)} not in result (got [${columns.join(", ")}])`;
  }
  return null;
}

function checkNonZero(
  expectations: QuestionExpectations,
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
): string | null {
  if (!expectations.non_zero) return null;
  if (rows.length === 0 || columns.length === 0) {
    return "non-zero scalar expected, but result was empty";
  }
  const first = rows[0]?.[columns[0]];
  const num = typeof first === "number" ? first : Number(first);
  if (!Number.isFinite(num) || num === 0) {
    return `expected non-zero scalar, got ${JSON.stringify(first)}`;
  }
  return null;
}

/**
 * Generic comparator used by metric / pattern / virtual modes. The three
 * exported `compare*Result` functions below are aliases — the per-mode
 * dispatch happens in `resolveQuestion`, but distinct names document intent
 * at the call sites in `canonical-eval-run.ts`.
 */
function compareSqlResult(
  question: Question,
  executed: ExecutedQuery,
): QuestionResult {
  const { sql } = executed;
  const failOn =
    checkSqlPattern(question.expect, sql) ??
    checkColumn(question.expect, executed.columns) ??
    checkNonZero(question.expect, executed.rows, executed.columns);
  if (failOn) {
    return { question, status: "fail", detail: failOn, sql };
  }

  const rowBounds = checkRowBounds(question.expect, executed.rows.length);
  if (rowBounds.kind === "warn") {
    return { question, status: "warn", detail: rowBounds.detail, sql };
  }

  const n = executed.rows.length;
  return {
    question,
    status: "pass",
    detail: `${n} row${n === 1 ? "" : "s"}`,
    sql,
  };
}

export const compareMetricResult = compareSqlResult;
export const comparePatternResult = compareSqlResult;
export const compareVirtualResult = compareSqlResult;

export function compareGlossaryResult(
  question: Question,
  matches: readonly GlossaryMatch[],
): QuestionResult {
  const fail = (detail: string): QuestionResult => ({
    question,
    status: "fail",
    detail,
    sql: null,
  });
  const pass = (detail: string): QuestionResult => ({
    question,
    status: "pass",
    detail,
    sql: null,
  });

  if (matches.length === 0) {
    return fail(`no glossary match for term "${question.term ?? ""}"`);
  }

  const expectedStatus = question.expect.status ?? null;
  if (expectedStatus === null) {
    return pass(`${matches.length} match${matches.length === 1 ? "" : "es"}`);
  }

  const match = matches.find((m) => m.status === expectedStatus);
  if (!match) {
    const got = matches.map((m) => `${m.term}=${m.status}`).join(", ");
    return fail(`expected ${expectedStatus} status but got [${got}]`);
  }

  if (expectedStatus === "ambiguous") {
    const { mappings_min } = question.expect;
    const count = match.possible_mappings.length;
    if (typeof mappings_min === "number" && count < mappings_min) {
      return fail(
        `expected at least ${mappings_min} possible_mappings, got ${count}`,
      );
    }
    return pass(`ambiguous (${count} mappings)`);
  }

  return pass("defined");
}

// ── Formatter ───────────────────────────────────────────────────────────

const STATUS_GLYPH: Record<ResultStatus, string> = {
  pass: "[PASS]",
  warn: "[WARN]",
  fail: "[FAIL]",
};

export function formatSummary(results: readonly QuestionResult[]): string {
  const lines: string[] = [];
  lines.push("Atlas canonical-question eval");
  lines.push("=".repeat(60));

  const passing = results.filter((r) => r.status === "pass").length;
  const warning = results.filter((r) => r.status === "warn").length;
  const failing = results.filter((r) => r.status === "fail").length;

  lines.push(`${passing}/${results.length} passing  (${warning} warn, ${failing} fail)`);
  lines.push("");

  for (const r of results) {
    const id = r.question.id.padEnd(7);
    const cat = r.question.category.padEnd(18);
    const head = `${STATUS_GLYPH[r.status]} ${id} ${cat} ${r.question.question}`;
    lines.push(head);
    if (r.status !== "pass") {
      lines.push(`         -> ${r.detail}`);
    }
  }

  lines.push("");
  lines.push("=".repeat(60));
  lines.push(`${passing}/${results.length} passing`);

  // Per-category summary — useful for spotting an entire category regressing.
  const byCat = new Map<string, { total: number; pass: number }>();
  for (const r of results) {
    const entry = byCat.get(r.question.category) ?? { total: 0, pass: 0 };
    entry.total++;
    if (r.status === "pass") entry.pass++;
    byCat.set(r.question.category, entry);
  }
  const sortedCats = [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [cat, stats] of sortedCats) {
    lines.push(`  ${cat.padEnd(20)} ${stats.pass}/${stats.total}`);
  }

  return lines.join("\n");
}

// ── Default questions path ───────────────────────────────────────────────

/**
 * Default location of the curated question set, relative to the repo root.
 * Resolved at runtime by walking up from this file.
 */
export const DEFAULT_QUESTIONS_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "eval",
  "canonical-questions",
  "questions.yml",
);

// ── Driver ───────────────────────────────────────────────────────────────

export interface RunHarnessOptions {
  /** Override the questions file path (defaults to `DEFAULT_QUESTIONS_PATH`). */
  readonly questionsPath?: string;
  /**
   * Resolve a metric's authoritative SQL by id. Returns `null` when the
   * metric is unknown. The CLI driver wires this to `findMetricById` from
   * `@atlas/api/lib/semantic/lookups`; tests inject stubs.
   */
  readonly findMetricSql: (id: string) => string | null;
  /**
   * Resolve an entity's `query_patterns[*].sql` by entity name + pattern
   * name. Returns `null` when either is unknown.
   */
  readonly findPatternSql: (entity: string, pattern: string) => string | null;
  /**
   * Search the glossary for a term. Returns the matching entries (zero or
   * more). The CLI driver wires this to `searchGlossary`; tests inject
   * stubs.
   */
  readonly searchGlossary: (term: string) => readonly GlossaryMatch[];
  /**
   * Execute a SQL string and return the result. The CLI driver wires this
   * to the configured Postgres datasource; tests inject stubs.
   */
  readonly executeSql: (sql: string) => Promise<SqlQueryResult>;
}

/**
 * Resolve a single question to a `QuestionResult`. Pure given its
 * dependencies — the actual DB / semantic-layer reads come in via
 * `RunHarnessOptions`.
 */
export async function resolveQuestion(
  question: Question,
  opts: RunHarnessOptions,
): Promise<QuestionResult> {
  const failNoSql = (detail: string): QuestionResult => ({
    question,
    status: "fail",
    detail,
    sql: null,
  });

  try {
    // Resolve SQL up-front so the execute + compare tail is shared across
    // the three SQL-bearing modes. Glossary mode skips SQL entirely.
    let sql: string;
    switch (question.mode) {
      case "metric": {
        const m = opts.findMetricSql(question.metric_id ?? "");
        if (!m) {
          return failNoSql(
            `unknown metric ${JSON.stringify(question.metric_id)}`,
          );
        }
        sql = m;
        break;
      }
      case "pattern": {
        const p = opts.findPatternSql(
          question.entity ?? "",
          question.pattern ?? "",
        );
        if (!p) {
          return failNoSql(
            `unknown query_pattern ${JSON.stringify(question.entity)}.${JSON.stringify(question.pattern)}`,
          );
        }
        sql = p;
        break;
      }
      case "virtual":
        sql = question.sql ?? "";
        break;
      case "glossary":
        return compareGlossaryResult(
          question,
          opts.searchGlossary(question.term ?? ""),
        );
      default: {
        // Compile-time exhaustiveness — adding a new mode here forces TS to
        // flag this branch. Mirrors the dispatcher in `runWithAgent`.
        const _exhaustive: never = question.mode;
        throw new Error(`unreachable mode: ${String(_exhaustive)}`);
      }
    }

    const { columns, rows } = await opts.executeSql(sql);
    return compareSqlResult(question, { sql, columns, rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failNoSql(`error: ${message}`);
  }
}

/**
 * Run every question in the curated set against the wired-in dependencies,
 * returning the per-question results. Caller is responsible for printing
 * via `formatSummary` and exiting with a non-zero code when desired.
 */
export async function runHarness(
  opts: RunHarnessOptions,
): Promise<QuestionResult[]> {
  const questions = loadQuestions(
    opts.questionsPath ?? DEFAULT_QUESTIONS_PATH,
  );
  const results: QuestionResult[] = [];
  for (const q of questions) {
    results.push(await resolveQuestion(q, opts));
  }
  return results;
}
