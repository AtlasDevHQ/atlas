/**
 * CLI driver for the canonical-question eval harness.
 *
 * Usage:
 *   bun run atlas -- canonical-eval                 # deterministic mode (default)
 *   bun run atlas -- canonical-eval --llm           # full agent loop, snapshot SQL
 *   bun run atlas -- canonical-eval --mcp-llm       # LLM-driven dispatch through MCP (#2119 Part B)
 *   bun run atlas -- canonical-eval --schema ecommerce
 *
 * Wires the pure runner core (`canonical-eval.ts`) up to:
 *   - Real semantic-layer reads via `@atlas/api/lib/semantic/lookups`
 *   - Real Postgres execution via `@atlas/api/lib/db/connection`
 *
 * The deterministic path mirrors what the typed MCP `runMetric` tool does:
 *   findMetricById(id) → executeSQL(sql). No LLM. No nondeterminism.
 *
 * The optional `--llm` path runs the full agent loop and asserts on the
 * SQL pattern of the last `executeSQL` call. This is the "snapshot" path
 * called out in the issue acceptance.
 *
 * The `--mcp-llm` path (#2119 Part B) hands an LLM the same MCP tool
 * surface a real client (Claude Desktop, Cursor) sees and grades the
 * tool-call sequence against the canonical question's expectation.
 * Mutually exclusive with `--llm`. See `canonical-eval-mcp-llm.ts` for
 * the dispatch loop and per-mode grader.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { getFlag, seedDemoPostgres } from "./atlas";
// Type-only — carries no runtime graph, so the `--help` / `--llm` paths still
// avoid pulling the MCP eval module (which the value import below defers).
import type { MetricExpectation } from "./canonical-eval-mcp-llm";
import {
  loadQuestions,
  formatSummary,
  resolveQuestion,
  compareMetricResult,
  comparePatternResult,
  compareVirtualResult,
  compareGlossaryResult,
  DEFAULT_QUESTIONS_PATH,
  type GlossaryMatch,
  type GlossaryStatus,
  type Question,
  type QuestionResult,
  type RunHarnessOptions,
} from "./canonical-eval";

const VALID_SCHEMAS = ["ecommerce"] as const;
type ValidSchema = (typeof VALID_SCHEMAS)[number];

const SEMANTIC_DIR = path.resolve("semantic");
// The canonical NovaMart semantic layer ships with the demo seed at
// packages/cli/data/seeds/<schema>/semantic. The auto-generated catalog
// at eval/schemas/<schema> is for the LLM benchmark (`atlas eval`); it
// uses different metric ids and is not the right ground truth here.
const SCHEMAS_DIR = path.resolve(
  "packages",
  "cli",
  "data",
  "seeds",
);
const BACKUP_DIR = path.resolve(".semantic-backup-canonical-eval");

interface CanonicalEvalOptions {
  schema: ValidSchema;
  questionsPath: string;
  /**
   * Mutually exclusive: `deterministic` is the default typed-dispatch
   * path; `llm` runs the full agent loop and asserts on the snapshot
   * SQL; `mcp-llm` is the #2119 Part B path that dispatches through
   * the real MCP route via an LLM. Modeling as a discriminated string
   * (rather than two booleans) makes the mutual exclusion enforceable
   * at parse time.
   */
  mode: "deterministic" | "llm" | "mcp-llm";
  json: boolean;
  /**
   * Path to the `--mcp-llm` latency baseline JSON. Defaults to
   * `eval/canonical-questions/mcp-llm-baseline.json`. Missing entries
   * are treated as "no baseline yet" by the grader.
   */
  baselinePath: string;
  /** When true and `mode === "mcp-llm"`, write the run's per-question latencies back to `baselinePath`. */
  writeBaseline: boolean;
  /**
   * When true, swap the canonical-question path for the held-out
   * tool-selection fixture — `eval/canonical-questions/tool-selection.json`
   * unless `--tool-selection-fixture` overrides. The grader asserts on
   * which tool the LLM picked first per item; the run exits non-zero
   * when accuracy < `rubric.acceptance_floor` (default 0.9). Only
   * meaningful with `--mcp-llm`. Drives the #2075 audit's success metric.
   */
  toolSelection: boolean;
  /** Path to the tool-selection fixture (#2075). Defaults to `eval/canonical-questions/tool-selection.json`. */
  toolSelectionFixturePath: string;
}

const DEFAULT_BASELINE_PATH = path.resolve(
  "eval",
  "canonical-questions",
  "mcp-llm-baseline.json",
);

const DEFAULT_TOOL_SELECTION_FIXTURE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "eval",
  "canonical-questions",
  "tool-selection.json",
);

export function parseCanonicalEvalOptions(args: string[]): CanonicalEvalOptions {
  const schemaArg = getFlag(args, "--schema") ?? "ecommerce";
  if (!(VALID_SCHEMAS as readonly string[]).includes(schemaArg)) {
    throw new Error(
      `Invalid --schema "${schemaArg}". Valid: ${VALID_SCHEMAS.join(", ")}`,
    );
  }
  const questionsPath = getFlag(args, "--questions") ?? DEFAULT_QUESTIONS_PATH;
  // Validate up front, before any destructive setup (semantic-layer backup,
  // demo seed). A typo in --questions used to surface as a confusing error
  // partway through a partially-staged run.
  if (!fs.existsSync(questionsPath)) {
    throw new Error(`--questions file not found: ${questionsPath}`);
  }
  const llm = args.includes("--llm");
  const mcpLlm = args.includes("--mcp-llm");
  if (llm && mcpLlm) {
    throw new Error(
      "--llm and --mcp-llm are mutually exclusive. Pick one: " +
        "--llm runs the agent loop and snapshots SQL; --mcp-llm dispatches " +
        "through the real MCP route via an LLM (#2119 Part B).",
    );
  }
  const mode: CanonicalEvalOptions["mode"] = mcpLlm
    ? "mcp-llm"
    : llm
      ? "llm"
      : "deterministic";
  const json = args.includes("--json");
  const baselinePath = getFlag(args, "--baseline") ?? DEFAULT_BASELINE_PATH;
  const writeBaseline = args.includes("--write-baseline");
  if (writeBaseline && !mcpLlm) {
    throw new Error("--write-baseline only applies to --mcp-llm mode");
  }
  const toolSelection = args.includes("--tool-selection");
  if (toolSelection && !mcpLlm) {
    throw new Error(
      "--tool-selection requires --mcp-llm — the held-out tool-selection " +
        "grader (#2075) reuses the MCP dispatch transport.",
    );
  }
  if (toolSelection && writeBaseline) {
    throw new Error(
      "--tool-selection and --write-baseline are mutually exclusive: the " +
        "tool-selection grader does not write per-question latency baselines.",
    );
  }
  const toolSelectionFixturePath =
    getFlag(args, "--tool-selection-fixture") ??
    DEFAULT_TOOL_SELECTION_FIXTURE_PATH;
  if (toolSelection && !fs.existsSync(toolSelectionFixturePath)) {
    throw new Error(
      `--tool-selection-fixture file not found: ${toolSelectionFixturePath}`,
    );
  }
  return {
    schema: schemaArg as ValidSchema,
    questionsPath,
    mode,
    json,
    baselinePath,
    writeBaseline,
    toolSelection,
    toolSelectionFixturePath,
  };
}

// ── Semantic-layer install/restore ──────────────────────────────────────

function backupSemanticLayer(): void {
  if (fs.existsSync(BACKUP_DIR)) {
    fs.rmSync(BACKUP_DIR, { recursive: true });
  }
  if (fs.existsSync(SEMANTIC_DIR)) {
    try {
      fs.cpSync(SEMANTIC_DIR, BACKUP_DIR, { recursive: true });
    } catch (err) {
      throw new Error(
        `Failed to backup semantic layer before canonical eval: ${err instanceof Error ? err.message : String(err)}. ` +
          `Refusing to proceed — your semantic/ directory would be at risk.`,
        { cause: err },
      );
    }
  }
}

/**
 * Restore the user's original semantic layer from the backup made by
 * `backupSemanticLayer`. Returns `true` on success, `false` on failure —
 * the caller MUST surface a non-zero exit code on failure so a user
 * doesn't see "all green" output while their `semantic/` directory is
 * gone.
 */
function restoreSemanticLayer(): boolean {
  if (!fs.existsSync(BACKUP_DIR)) return true;
  try {
    if (fs.existsSync(SEMANTIC_DIR)) {
      fs.rmSync(SEMANTIC_DIR, { recursive: true });
    }
    fs.cpSync(BACKUP_DIR, SEMANTIC_DIR, { recursive: true });
    fs.rmSync(BACKUP_DIR, { recursive: true });
    return true;
  } catch (err) {
    process.stderr.write(
      `\nCRITICAL: Failed to restore semantic layer: ${err instanceof Error ? err.message : String(err)}\n` +
        `Your original semantic layer was backed up to: ${BACKUP_DIR}\n` +
        `To restore manually: rm -rf ${SEMANTIC_DIR} && cp -r ${BACKUP_DIR} ${SEMANTIC_DIR}\n`,
    );
    return false;
  }
}

function installSchemaSemanticLayer(schema: ValidSchema): void {
  const srcDir = path.join(SCHEMAS_DIR, schema, "semantic");
  if (!fs.existsSync(srcDir)) {
    throw new Error(
      `Canonical semantic layer not found for schema "${schema}" at ${srcDir}. ` +
        `Expected packages/cli/data/seeds/<schema>/semantic to ship with the demo seed.`,
    );
  }
  if (fs.existsSync(SEMANTIC_DIR)) {
    fs.rmSync(SEMANTIC_DIR, { recursive: true });
  }
  fs.cpSync(srcDir, SEMANTIC_DIR, { recursive: true });
}

// ── Pattern / entity lookup ─────────────────────────────────────────────

/**
 * Find a `query_patterns[*].sql` by entity name + pattern name. Walks the
 * semantic root directly so it doesn't depend on the in-process scanner —
 * the deterministic harness is meant to behave like a fresh load every
 * time.
 */
function findPatternSqlFromDisk(
  entity: string,
  patternName: string,
  semanticRoot: string,
): string | null {
  const entitiesDir = path.join(semanticRoot, "entities");
  if (!fs.existsSync(entitiesDir)) return null;
  for (const file of fs.readdirSync(entitiesDir)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const filePath = path.join(entitiesDir, file);
    let raw: unknown;
    const text = fs.readFileSync(filePath, "utf-8");
    // js-yaml v5 throws on empty input where v4 returned undefined; an empty
    // entity file should be skipped (the `!raw` branch below), not abort the
    // whole run via the malformed-YAML rethrow.
    if (!text.trim()) {
      raw = undefined;
    } else {
      try {
        raw = yaml.load(text);
      } catch (err) {
        // Re-throw with file context so a malformed entity YAML is debuggable
        // — yaml.load's default error references neither the file nor the
        // calling harness.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to parse semantic entity ${filePath}: ${msg}`, {
          cause: err,
        });
      }
    }
    if (!raw || typeof raw !== "object") {
      process.stderr.write(
        `[canonical-eval] WARN: skipping ${filePath} — top-level value is not an object\n`,
      );
      continue;
    }
    const r = raw as Record<string, unknown>;
    const matchesEntity =
      (typeof r.name === "string" && r.name === entity) ||
      (typeof r.table === "string" && r.table === entity);
    if (!matchesEntity) continue;
    const patterns = r.query_patterns;
    if (!Array.isArray(patterns)) return null;
    // Duck-type each pattern entry — the YAML is operator-authored, so
    // never trust the shape. The previous `as QueryPattern[]` cast was a
    // lie that hid malformed entries.
    for (const p of patterns) {
      if (!p || typeof p !== "object") continue;
      const pp = p as { name?: unknown; sql?: unknown };
      if (typeof pp.name === "string" && pp.name === patternName) {
        return typeof pp.sql === "string" ? pp.sql : null;
      }
    }
    return null;
  }
  return null;
}

// Map a `lookups.searchGlossary` result to the wire shape the harness
// comparator expects. Shared by deterministic + LLM paths. Upstream
// `status` is typed `string | null` (the YAML is operator-authored) — we
// narrow at the boundary to the harness's `GlossaryStatus | null`, mapping
// any unrecognised value to `null` so the comparator never asserts on a
// status it doesn't understand.
type LookupsModule = typeof import("@atlas/api/lib/semantic/lookups");

function narrowGlossaryStatus(value: string | null): GlossaryStatus | null {
  if (value === "defined" || value === "ambiguous") return value;
  return null;
}

function toGlossaryMatches(
  lookups: LookupsModule,
  term: string,
): readonly GlossaryMatch[] {
  return lookups.searchGlossary(term).map((m) => ({
    term: m.term,
    status: narrowGlossaryStatus(m.status),
    possible_mappings: m.possible_mappings,
  }));
}

// Iterate questions printing a per-question progress line. The resolver
// closure isolates the deterministic-vs-LLM behavioral difference; this
// helper just owns the I/O and the result accumulator.
async function evalEachQuestion(
  questions: readonly Question[],
  label: string,
  resolve: (q: Question) => Promise<QuestionResult>,
): Promise<QuestionResult[]> {
  const results: QuestionResult[] = [];
  for (const q of questions) {
    process.stdout.write(`  ${q.id} ${q.category}${label} ... `);
    const r = await resolve(q);
    process.stdout.write(`${r.status}\n`);
    results.push(r);
  }
  return results;
}

// ── Wiring (deterministic mode) ──────────────────────────────────────────

async function runDeterministic(
  options: CanonicalEvalOptions,
): Promise<QuestionResult[]> {
  // Lazy imports so that --llm / --help paths don't pull the full API runtime.
  const lookups = await import("@atlas/api/lib/semantic/lookups");
  const { connections } = await import("@atlas/api/lib/db/connection");

  const harnessOpts: RunHarnessOptions = {
    questionsPath: options.questionsPath,
    findMetricSql: (id) => lookups.findMetricById(id)?.sql ?? null,
    findPatternSql: (entity, pattern) =>
      findPatternSqlFromDisk(entity, pattern, SEMANTIC_DIR),
    searchGlossary: (term) => toGlossaryMatches(lookups, term),
    executeSql: async (sql) => {
      const db = connections.getDefault();
      const { columns, rows } = await db.query(sql, 60_000);
      return { columns, rows };
    },
  };

  const questions = loadQuestions(options.questionsPath);
  return evalEachQuestion(questions, "", (q) => resolveQuestion(q, harnessOpts));
}

// ── Wiring (LLM mode) ────────────────────────────────────────────────────

async function runWithAgent(
  options: CanonicalEvalOptions,
): Promise<QuestionResult[]> {
  const { executeAgentQuery } = await import("@atlas/api/lib/agent-query");
  const lookups = await import("@atlas/api/lib/semantic/lookups");

  const questions = loadQuestions(options.questionsPath);
  return evalEachQuestion(questions, " (--llm)", async (q) => {
    // Glossary mode never invokes the agent — we assert the
    // disambiguation contract by checking semantic-layer state directly.
    if (q.mode === "glossary") {
      return compareGlossaryResult(q, toGlossaryMatches(lookups, q.term));
    }

    // Narrow the try/catch to ONLY the agent invocation. Comparator
    // throws + the unreachable-mode default below are harness bugs (not
    // eval failures) and should propagate so they're visible.
    let agent;
    try {
      agent = await executeAgentQuery(q.question);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        question: q,
        status: "fail",
        detail:
          `agent error: ${msg}. ` +
          `Tip: verify ATLAS_DATASOURCE_URL is reachable and the configured model provider is responsive.`,
        sql: null,
      };
    }

    // The `?? ""` / `?? null` are defensive, NOT compiler-required — no tsconfig
    // in the repo sets `noUncheckedIndexedAccess`, so index access here is `T`.
    // The empty-array hard-fail below at `agent.sql.length === 0` is the
    // load-bearing guard for the empty case; these defaults only feed the
    // early-return branch's `sql: lastSql || null` mapping.
    const lastSql = agent.sql[agent.sql.length - 1] ?? "";
    const lastData = agent.data[agent.data.length - 1] ?? null;

    // Hard-fail when the agent never executed SQL or returned no rows.
    // Without this guard the executed shape `{ sql: "", columns: [], rows: [] }`
    // falls through to the comparators which return pass/warn depending
    // on whether `min_rows` is set — masking a legitimate LLM failure as
    // a green run.
    if (agent.sql.length === 0 || agent.data.length === 0) {
      return {
        question: q,
        status: "fail",
        detail:
          agent.sql.length === 0
            ? "agent did not execute any SQL"
            : "agent executed SQL but returned no result rows",
        sql: lastSql || null,
      };
    }

    const executed = {
      sql: lastSql,
      columns: lastData?.columns ?? [],
      rows: lastData?.rows ?? [],
    };
    switch (q.mode) {
      case "metric":
        return compareMetricResult(q, executed);
      case "pattern":
        return comparePatternResult(q, executed);
      case "virtual":
        return compareVirtualResult(q, executed);
      default: {
        const _exhaustive: never = q;
        throw new Error(`unreachable mode: ${String(_exhaustive)}`);
      }
    }
  });
}

// ── Entrypoint ───────────────────────────────────────────────────────────

export async function handleCanonicalEval(args: string[]): Promise<void> {
  const options = parseCanonicalEvalOptions(args);

  const connStr = process.env.ATLAS_DATASOURCE_URL;
  if (!connStr) {
    process.stderr.write(
      "Error: ATLAS_DATASOURCE_URL is required for canonical-eval.\n" +
        "Tip: bun run db:up && export ATLAS_DATASOURCE_URL=postgres://atlas:atlas@localhost:5433/atlas_demo\n",
    );
    process.exit(1);
  }

  process.stdout.write(
    `Atlas canonical-question eval — schema=${options.schema} mode=${options.mode}\n`,
  );

  const exitCode = await runStagedCanonicalEval(options, connStr);
  process.exit(exitCode);
}

/**
 * Stage the semantic layer, run the eval, restore, and reduce the whole run to
 * ONE exit code for {@link handleCanonicalEval} to hand the shell.
 *
 * ⚠️ THE EXIT MUST LIVE OUTSIDE THIS FUNCTION, THE `return` MUST LIVE OUTSIDE
 * THE `try`, AND THE `try` MUST HAVE A `catch`. All three were wrong until
 * #5130, and each one on its own silently discards a failure:
 *
 *   - The exit used to sit after the `try`/`finally` in the same function as
 *     the eval body, so every `return` inside that body ran `finally` and then
 *     left the function — skipping `process.exit(exitCode)` entirely and ending
 *     the process on its natural code, 0. `--mcp-llm` computed its acceptance
 *     floor, printed `FAIL: 12/20 below acceptance floor 18`, and exited 0; the
 *     demo-seed catch did the same for BOTH modes. Splitting the body out into
 *     {@link runInstalledCanonicalEval}, declared `Promise<number>`, is what
 *     keeps a future early `return` from re-opening it: a path that returns
 *     without a code is then a compile error (TS2366/TS2322 — the mechanism is
 *     `strictNullChecks`, which the root tsconfig sets via `strict`).
 *   - `return exitCode` INSIDE the `try` would capture the value at return time,
 *     so the `finally`'s restore-failure bump to 2 would be computed and thrown
 *     away — the same defect one layer over. The `return` below is deliberately
 *     after the block.
 *   - A `throw` is one of the code-less paths the compiler still permits, and
 *     without the `catch` below it discarded the bump the same way: the
 *     exception propagated past `return exitCode` to `main().catch` in
 *     `bin/atlas.ts`, which exits 1 unconditionally. A run that destroyed the
 *     user's `semantic/` then reported 1 — indistinguishable from an ordinary
 *     eval failure, on precisely the path where the distinction matters most.
 *   - ⚠️ The second is a call returning `never`, which `Promise<number>` also
 *     accepts — and `process.exit` has exactly that type. **Do not call
 *     `process.exit` anywhere below this function.** It is this CLI's house
 *     idiom (`bin/atlas.ts` uses it eleven times), so the edit is a natural one
 *     to make, and it is strictly WORSE than the defect #5130 fixed: it skips
 *     the `finally` as well as the aggregation, leaving the caller's `semantic/`
 *     replaced by the demo fixture with no message and no restore. Return a code
 *     and let it travel. Checked at the time of writing: no `process.exit` in the
 *     CLI-side eval modules (`canonical-eval*.ts`, `seedDemoPostgres`). The graph
 *     reaches `@atlas/api` and `@atlas/mcp` through dynamic imports, which a grep
 *     cannot audit — so this is a rule to follow, not a property anything checks.
 *     (A non-terminating loop is a third code-less path, and equally accepted.)
 */
async function runStagedCanonicalEval(
  options: CanonicalEvalOptions,
  connStr: string,
): Promise<number> {
  // Stage the semantic layer for the chosen schema, identical to bin/eval.ts.
  backupSemanticLayer();
  let exitCode = 0;
  try {
    exitCode = await runInstalledCanonicalEval(options, connStr);
  } catch (err) {
    // Logged here rather than re-thrown: re-throwing reaches `main().catch`,
    // which exits 1 and would outrank the restore bump computed below. Same
    // stack the top-level handler would have printed, so nothing is lost.
    process.stderr.write(
      `\nError: canonical eval failed: ${err instanceof Error ? err.message : String(err)}\n` +
        (err instanceof Error && err.stack ? `${err.stack}\n` : ""),
    );
    exitCode = 1;
  } finally {
    // Surface restore failure via the exit code — silently swallowing it
    // would let a developer see an "all green" run while their original
    // semantic/ directory is gone. Use exit 2 so it's distinguishable from
    // a normal eval failure (exit 1).
    const restored = restoreSemanticLayer();
    if (!restored) exitCode = Math.max(exitCode, 2);
  }
  return exitCode;
}

/**
 * Write to stdout with a BLOCKING syscall loop instead of the buffered stream.
 *
 * ⚠️ `process.exit()` DISCARDS whatever is still sitting in `process.stdout`'s
 * buffer, with no error on either side. Measured on bun 1.3.13: a 2 MB payload
 * written via `process.stdout.write` and followed by `process.exit` reaches a
 * pipe truncated — 65_536 bytes (one pipe buffer) under `| wc -c`, 219_264 under
 * a concurrently-draining reader. HOW MUCH survives is whatever the reader
 * drained in time, so it is not a fixed number and not something a caller can
 * budget against; what is fixed is that the tail is lost and nothing says so.
 *
 * That cliff is not theoretical for this command. The workflow runs
 * `canonical-eval --mcp-llm --json | tee eval-mcp-llm-output.json` and uploads
 * the result as the adjudication artifact; the file from the 2026-08-11 run is
 * 63_024 bytes, 2.5 KB under the limit and growing with every field added to
 * the payload. Until #5130 the `--mcp-llm` path left via `return` and the
 * process ended naturally, so the stream always drained — routing it through
 * the shared `process.exit` is what exposes this, which makes it this change's
 * to carry.
 *
 * `fs.writeSync` returns only once the bytes are handed to the fd, so there is
 * nothing left to discard. Reserved for the payloads that can cross that cliff —
 * the three `--json` bodies and the failure-artifact bundle.
 *
 * ⚠️ STDERR HAS THE SAME CLIFF and no equivalent helper. Measured the same way:
 * 200 KB to stderr followed by `process.exit` arrives as 65_536 bytes. The
 * FAILURE-path diagnostics all live there — the acceptance-floor FAIL line,
 * `CRITICAL: Failed to restore semantic layer`, the harness stack — at a few
 * hundred bytes each, except the stack, which runs to a few KB. (The pass/fail
 * DETAIL is not on stderr: that is `formatSummary` and the `--json` bodies, on
 * stdout.) So this is latent rather than live; whoever adds an unbounded stderr
 * diagnostic needs a `writeStderrSync` twin first.
 *
 * ⚠️ MIXING SYNCHRONOUS AND BUFFERED WRITES IS ORDER-SENSITIVE. A `writeSync`
 * bypasses `process.stdout`'s queue entirely, so it can print ahead of an
 * earlier buffered write that has not flushed. The interleaving is correct on
 * every path measured on bun 1.3.13 — a 4-byte buffered write, a 60_000-byte
 * one, and a real 40-question `--json` run all landed ahead of the following
 * `writeStdoutSync` — but that is a MEASUREMENT of this runtime's flush timing,
 * not a guarantee the code enforces, so do not extend the mixing on the strength
 * of it. Note in particular that `formatSummary` (the deterministic human
 * summary) and the `note:` lines in `resolveExpectations` are NOT bounded in
 * principle: both interpolate caught error messages, and `--questions` is
 * caller-supplied. They stay on the stream because the buffered path is what
 * they have always used, not because they are known small.
 */
export function writeStdoutSync(text: string): void {
  const buf = Buffer.from(text, "utf-8");
  // A one-word cell purely to get a blocking sleep on the EAGAIN path below;
  // there is no synchronous `sleep` and a bare retry loop would spin at 100%.
  const idle = new Int32Array(new SharedArrayBuffer(4));
  let offset = 0;
  while (offset < buf.length) {
    let written: number;
    try {
      written = fs.writeSync(1, buf, offset, buf.length - offset);
    } catch (err) {
      // `.code` is read only after narrowing to Error. Reading it off a bare
      // caught value raises a TypeError from inside the handler for `throw null`
      // / `throw undefined` — substituting nonsense for the real write failure —
      // and silently yields `undefined` for a string or number throw.
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      // A reader that hung up (`… | head`, a quit pager) is not a failure and
      // must not become one: the buffered stream this replaced dropped EPIPE
      // silently, and turning `atlas canonical-eval --json | head` into exit 1
      // with a stack trace would be a regression introduced by a flush fix.
      // intentionally ignored: the reader hung up. This is the one path here
      // that emits nothing, and that is the correct behaviour for a pipe.
      if (code === "EPIPE") return;
      // EAGAIN drives a RETRY; it is not discarded. A `write(2)` that returns
      // EAGAIN wrote nothing, so re-driving the same offset loses no bytes, and
      // waiting for the reader is exactly what a blocking fd would have done —
      // this branch only exists because fd 1 may arrive with O_NONBLOCK set.
      // Every other errno (ENOSPC, EBADF) is a real write failure and
      // propagates to `runStagedCanonicalEval`'s catch.
      //
      // ⚠️ UNTESTED: nothing in the suite can force EAGAIN on a pipe, so this
      // branch and the sleep below are reasoning, not measurement.
      if (code !== "EAGAIN") throw err;
      Atomics.wait(idle, 0, 0, 1);
      continue;
    }
    // A zero-byte return makes no progress and raises nothing, so without this
    // the loop spins forever with no diagnostic — a hang, which no test can
    // falsify. Fail loudly with the offset reached instead.
    if (written === 0) {
      throw new Error(
        `stdout write stalled at ${offset}/${buf.length} bytes: write(2) returned 0. ` +
          `Refusing to spin — the remaining payload would be lost silently.`,
      );
    }
    offset += written;
  }
}

/**
 * Run the eval against the freshly installed semantic layer and return the exit
 * code it earns: 1 for a seed failure or any failing question, otherwise
 * whatever the selected mode reports. Restoring the caller's semantic layer is
 * {@link runStagedCanonicalEval}'s job, not this one's.
 */
async function runInstalledCanonicalEval(
  options: CanonicalEvalOptions,
  connStr: string,
): Promise<number> {
  installSchemaSemanticLayer(options.schema);

  // Seed the demo Postgres before running so the harness is self-contained
  // — same hook used by bin/eval.ts. seedDemoPostgres takes a connection
  // string, not a schema; only `ecommerce` ships today (#2021).
  try {
    await seedDemoPostgres(connStr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `\nError: failed to seed demo Postgres: ${msg}\n` +
        `Tip: bun run db:up && export ATLAS_DATASOURCE_URL=postgres://atlas:atlas@localhost:5433/atlas_demo\n`,
    );
    return 1;
  }

  // Reset cached connection / whitelist / explore-backend state so the
  // freshly installed semantic layer is re-resolved. `connections._reset()`
  // is intentionally synchronous — it queues async pool closes via
  // `.catch()` handlers (verified in lib/db/connection.ts).
  const { connections } = await import("@atlas/api/lib/db/connection");
  const { _resetWhitelists } = await import("@atlas/api/lib/semantic");
  const { invalidateExploreBackend } = await import(
    "@atlas/api/lib/tools/explore"
  );
  connections._reset();
  _resetWhitelists();
  invalidateExploreBackend();

  if (options.mode === "mcp-llm") {
    return await runMcpLlmMode(options);
  }

  const results =
    options.mode === "llm"
      ? await runWithAgent(options)
      : await runDeterministic(options);

  if (options.json) {
    writeStdoutSync(
      `${JSON.stringify(
        {
          schema: options.schema,
          mode: options.mode,
          total: results.length,
          passing: results.filter((r) => r.status === "pass").length,
          warning: results.filter((r) => r.status === "warn").length,
          failing: results.filter((r) => r.status === "fail").length,
          results: results.map((r) => ({
            id: r.question.id,
            category: r.question.category,
            question: r.question.question,
            status: r.status,
            detail: r.detail,
            sql: r.sql,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`\n${formatSummary(results)}\n`);
  }

  return results.some((r) => r.status === "fail") ? 1 : 0;
}

// ── Wiring (--mcp-llm mode, #2119 Part B) ───────────────────────────────

/**
 * LLM-driven dispatch through the real MCP route. Boots the in-process
 * Better Auth + MCP server, hands the LLM the discovered MCP tool set
 * via the Vercel AI SDK, and grades each canonical question's tool-call
 * sequence. See `canonical-eval-mcp-llm.ts` for the dispatch loop.
 *
 * This branch lives here (rather than alongside `runWithAgent`) so it
 * can short-circuit the deterministic JSON formatting and own its own
 * summary printer — the LLM-mode outcomes carry per-call latency +
 * artifact metadata the deterministic shape doesn't model.
 */
/**
 * Map a provider type to the env var that holds its API key. Returns
 * `null` when the key is set OR when the provider doesn't need one
 * (`ollama`, `openai-compatible` running locally). Lives at module
 * scope so the test surface can pin the mapping if a future provider
 * lands here.
 */
function providerKeyMissing(providerType: string): string | null {
  const required: Record<string, string | null> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    "bedrock-anthropic": "AWS_ACCESS_KEY_ID",
    google: "GOOGLE_GENERATIVE_AI_API_KEY",
    ollama: null,
    "openai-compatible": null,
  };
  const envVar = required[providerType];
  if (!envVar) return null;
  return process.env[envVar] ? null : envVar;
}

async function runMcpLlmMode(
  options: CanonicalEvalOptions,
): Promise<number> {
  const { runMcpLlmEval, readBaseline, writeBaseline } = await import(
    "./canonical-eval-mcp-llm"
  );
  const { formatArtifactBundle } = await import(
    "@atlas/mcp/eval/failure-artifact"
  );
  const { getModelForConfig } = await import("@atlas/api/lib/providers");

  // Resolve provider + model from env. Wrap getModelForConfig errors
  // with eval-context framing so a CI maintainer hitting "ATLAS_MODEL
  // is required" sees the connection to --mcp-llm rather than a bare
  // provider-layer error. Mirrors the seedDemoPostgres wrap pattern
  // higher up in this file.
  let model;
  let providerType;
  let modelId;
  try {
    ({ model, providerType, modelId } = getModelForConfig());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `\nError: --mcp-llm requires a configured LLM provider: ${msg}\n` +
        `Tip: export ATLAS_PROVIDER=<provider> ATLAS_MODEL=<model-id> <PROVIDER>_API_KEY=...\n` +
          `     (see apps/docs/content/shared/reference/environment-variables.mdx for current model ids)\n`,
    );
    return 1;
  }

  // Pre-flight the API key for the resolved provider. The provider
  // SDKs (Anthropic, OpenAI, etc.) lazily read the env var at call
  // time, so without this guard the eval can run end-to-end with no
  // key, classify everything as `tool_selection` failure, and trip
  // the acceptance floor for the wrong reason.
  const keyMissing = providerKeyMissing(providerType);
  if (keyMissing) {
    process.stderr.write(
      `\nError: --mcp-llm requires ${keyMissing} for provider "${providerType}".\n` +
        `Tip: export ${keyMissing}=... and re-run.\n`,
    );
    return 1;
  }

  process.stdout.write(
    `  using LLM provider=${providerType} model=${modelId}\n`,
  );

  // Branch into the held-out tool-selection fixture (#2075) when
  // requested. The MCP transport boot is identical to the canonical
  // path; the grader is narrower (first-tool match, not per-mode answer
  // correctness) and the acceptance metric is an accuracy floor.
  if (options.toolSelection) {
    // `await`ed, not returned bare: a rejection's stack then stays in this
    // frame rather than unwinding with the caller's.
    return await runToolSelectionMode({
      ...options,
      providerLabel: `${providerType}/${modelId}`,
      model,
    });
  }

  const baseline = readBaseline(options.baselinePath);
  if (baseline) {
    process.stdout.write(
      `  loaded baseline from ${options.baselinePath} (${Object.keys(baseline).length} entries)\n`,
    );
  } else {
    process.stdout.write(
      `  no baseline file at ${options.baselinePath} — latency check skipped (run with --write-baseline to seed)\n`,
    );
  }

  // Ground truth for every metric question, established BEFORE any LLM call by
  // executing each metric's own authoritative SQL. See `MetricExpectation` —
  // LLM metric mode grades the ANSWER now, not the SQL's spelling (#5122).
  const { metricExpectations, answerExpectations } = await resolveExpectations(
    options.questionsPath,
  );
  process.stdout.write(
    `  resolved ${Object.keys(metricExpectations).length} metric + ` +
      `${Object.keys(answerExpectations).length} pattern/virtual expectations from the semantic layer\n`,
  );

  const result = await runMcpLlmEval({
    questionsPath: options.questionsPath,
    model,
    baseline,
    metricExpectations,
    answerExpectations,
  });

  const passing = result.outcomes.filter((o) => o.status === "pass").length;
  const failing = result.outcomes.length - passing;

  // Run the baseline write BEFORE the summary so a write failure (EACCES
  // on a CI runner, ENOSPC, parent-dir missing) aborts cleanly with the
  // wrapped error from writeBaseline rather than printing "all green"
  // and then crashing on the FS error after the user has already moved
  // on to read the next CI step.
  if (options.writeBaseline) {
    writeBaseline(options.baselinePath, result.outcomes);
    process.stdout.write(
      `  wrote per-question latency baseline to ${options.baselinePath}\n`,
    );
  }

  if (options.json) {
    writeStdoutSync(
      `${JSON.stringify(
        {
          schema: options.schema,
          mode: options.mode,
          total: result.outcomes.length,
          passing,
          failing,
          outcomes: result.outcomes.map((o) => ({
            id: o.questionId,
            status: o.status,
            latencyMs: o.latencyMs,
            tools: o.toolCalls.map((c) => c.name),
            // ⚠️ `finalText` WAS NEVER ACTUALLY SERIALIZED (#5122). The
            // workflow's own comment claims this JSON "captures full
            // per-question artifacts (toolCalls, finalText, response payloads)"
            // and explains that the human summary "truncates finalText and
            // would lose the recovery-class diagnostic data" — but the mapping
            // here only ever emitted id/status/latency/tools/artifact, so the
            // field the comment names as the reason for the JSON mode's
            // existence was dropped on the floor.
            //
            // It is load-bearing for exactly the adjudication this issue
            // demands: a glossary question passes when the model SURFACES the
            // ambiguity, which lives in the answer text and nowhere else — so
            // without this you cannot tell "asked the user which revenue they
            // meant" (correct) from "silently picked one" (the regression the
            // eval exists to catch) from the tool sequence alone.
            finalText: o.finalText,
            artifact: o.status === "fail" ? o.artifact : undefined,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `\nMCP LLM canonical eval — ${passing}/${result.outcomes.length} passing (${failing} failing)\n`,
    );
    for (const o of result.outcomes) {
      const tag = o.status === "pass" ? "[PASS]" : "[FAIL]";
      process.stdout.write(
        `  ${tag} ${o.questionId.padEnd(7)} ${String(o.latencyMs).padStart(5)}ms tools=${o.toolCalls.map((c) => c.name).join(",") || "<none>"}\n`,
      );
    }
    if (result.artifacts.length > 0) {
      writeStdoutSync(formatArtifactBundle(result.artifacts));
    }
  }

  // Acceptance criterion (#2119 Part B): ≥90% of canonical questions
  // resolved correctly. We exit 1 below the bar so a regression trips
  // the workflow red on tag pushes (`continue-on-error: false` in CI).
  const ACCEPTANCE_FLOOR = Math.ceil(result.outcomes.length * 0.9);
  if (passing < ACCEPTANCE_FLOOR) {
    process.stderr.write(
      `\nFAIL: ${passing}/${result.outcomes.length} below acceptance floor ${ACCEPTANCE_FLOOR}\n`,
    );
    return 1;
  }
  return 0;
}

/**
 * Execute every metric question's authoritative SQL and reduce each result to a
 * {@link MetricExpectation} the LLM grader compares answers against.
 *
 * ⚠️ GROUND TRUTH IS DERIVED, NEVER WRITTEN DOWN. The expectation comes from
 * `findMetricById(id).sql` executed against the same datasource the model
 * queries, so it cannot drift from the semantic layer and cannot be quietly
 * tuned to make a run pass. The `expect.sql_pattern` needles it replaces were
 * the opposite: copies of the metric SQL, which made the deterministic eval's
 * check vacuous and the LLM eval's check a spelling test (#5122).
 *
 * Shape classification is structural, not configured: a 1×1 numeric result is a
 * scalar metric; anything else is a grouped result whose FIRST column is the
 * grouping key by convention across the corpus (`channel`, `carrier`,
 * `stock_status`, `month`) and whose remaining columns are its measures.
 *
 * ⚠️ THE FIRST COLUMN IS A LABEL, NOT GROUND TRUTH (#5128). It used to be the
 * whole of a grouped expectation, which made a hand-written
 * `CASE … THEN 'With Promo'` load-bearing for a correctness check. The reduction
 * now happens in `keyedExpectationFrom`, next to the comparison that consumes
 * it, and takes the measures as well — see {@link MetricExpectation}.
 *
 * A metric that cannot be resolved or executed THROWS. A missing expectation
 * would otherwise silently downgrade that question's grading, and a gate that
 * stops checking without saying so is the failure mode this whole issue is about.
 */
async function resolveExpectations(questionsPath: string): Promise<{
  metricExpectations: Record<string, MetricExpectation>;
  answerExpectations: Record<string, MetricExpectation>;
}> {
  const lookups = await import("@atlas/api/lib/semantic/lookups");
  const { connections } = await import("@atlas/api/lib/db/connection");
  // Dynamic, like its siblings above: this module's top-level import of
  // `canonical-eval-mcp-llm` is deliberately TYPE-ONLY so `--help` / `--llm`
  // never pull the MCP eval graph. Only `--mcp-llm` reaches here, and it has
  // already imported the module, so this resolves from cache.
  const { keyedExpectationFrom } = await import("./canonical-eval-mcp-llm");

  /** Execute one authoritative statement and reduce it to an expectation. */
  async function expectationFor(label: string, sql: string): Promise<MetricExpectation> {
    let columns: string[];
    let rows: Array<Record<string, unknown>>;
    try {
      const db = connections.getDefault();
      ({ columns, rows } = await db.query(sql, 60_000));
    } catch (err) {
      throw new Error(
        `Cannot establish ground truth for ${label}: its authoritative SQL failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const firstColumn = columns[0];
    if (rows.length === 1 && columns.length === 1 && firstColumn !== undefined) {
      const cell = rows[0]?.[firstColumn];
      const value = typeof cell === "number" ? cell : Number(cell);
      if (Number.isFinite(value)) return { kind: "scalar", value };
    }
    if (firstColumn === undefined || rows.length === 0) {
      throw new Error(
        `Cannot establish ground truth for ${label}: its authoritative SQL returned ` +
          `${rows.length} row(s) / ${columns.length} column(s), which is neither a scalar nor a ` +
          `keyed result. Ground truth must be one or the other for the answer comparison to mean anything.`,
      );
    }
    // ⚠️ HARVESTED BY THE COMPARISON'S OWN FACTORY, NOT BY HAND HERE (#5128) —
    // see `MetricExpectation` for why reading ground truth off a display column
    // was the defect. `firstColumn` is passed separately because the guard above
    // has already proved it non-undefined; the factory consumes that proof
    // rather than re-checking it.
    return keyedExpectationFrom(firstColumn, columns.slice(1), rows);
  }

  const questions = loadQuestions(questionsPath);
  const metricExpectations: Record<string, MetricExpectation> = {};
  const answerExpectations: Record<string, MetricExpectation> = {};

  for (const id of new Set(
    questions
      .filter((q): q is Extract<Question, { mode: "metric" }> => q.mode === "metric")
      .map((q) => q.metric_id),
  )) {
    const sql = lookups.findMetricById(id)?.sql;
    if (!sql) {
      throw new Error(
        `Cannot establish ground truth for metric "${id}": findMetricById returned no SQL. ` +
          `The installed semantic layer does not define it — check the schema fixture.`,
      );
    }
    metricExpectations[id] = await expectationFor(`metric "${id}"`, sql);
  }

  // Pattern + virtual ground truth. Failures here are NON-FATAL, unlike the
  // metric branch: this expectation is an additive accept path over checks that
  // still stand on their own, so a pattern whose SQL cannot be resolved leaves
  // the question graded exactly as it was before rather than aborting the run.
  for (const q of questions) {
    if (q.mode !== "pattern" && q.mode !== "virtual") continue;
    const sql =
      q.mode === "pattern"
        ? findPatternSqlFromDisk(q.entity, q.pattern, SEMANTIC_DIR)
        : q.sql;
    if (!sql) {
      process.stdout.write(
        `  note: no authoritative SQL for ${q.id} — value accept path disabled for it\n`,
      );
      continue;
    }
    try {
      answerExpectations[q.id] = await expectationFor(`${q.mode} question ${q.id}`, sql);
    } catch (err) {
      process.stdout.write(
        `  note: ${q.id} ground truth unavailable (${err instanceof Error ? err.message : String(err)}) — ` +
          `value accept path disabled for it\n`,
      );
    }
  }

  return { metricExpectations, answerExpectations };
}

// ── Wiring (--tool-selection mode, #2075) ───────────────────────────────

interface ToolSelectionModeOptions extends CanonicalEvalOptions {
  readonly providerLabel: string;
  readonly model: import("ai").LanguageModel;
}

/**
 * Held-out tool-selection accuracy run for the MCP tool-description
 * audit (#2075). Reuses the `--mcp-llm` MCP transport but swaps the
 * grader for a per-item first-tool match against the JSON fixture at
 * `eval/canonical-questions/tool-selection.json`.
 *
 * The acceptance criterion lives in the fixture's `rubric.acceptance_floor`
 * (default 0.9) so the audit's success metric is co-located with the
 * prompts it grades — drift the floor and the test it gates ship in the
 * same PR.
 */
async function runToolSelectionMode(
  options: ToolSelectionModeOptions,
): Promise<number> {
  const { runToolSelectionEval } = await import("./canonical-eval-tool-selection");

  process.stdout.write(
    `  tool-selection fixture: ${options.toolSelectionFixturePath}\n`,
  );

  const result = await runToolSelectionEval({
    fixturePath: options.toolSelectionFixturePath,
    model: options.model,
  });

  const passing = result.outcomes.filter((o) => o.passed).length;
  const failing = result.outcomes.length - passing;
  const accuracyPct = (result.accuracy * 100).toFixed(1);
  const floorPct = (result.acceptanceFloor * 100).toFixed(1);

  if (options.json) {
    writeStdoutSync(
      `${JSON.stringify(
        {
          schema: options.schema,
          mode: options.mode,
          submode: "tool-selection",
          total: result.outcomes.length,
          passing,
          failing,
          accuracy: result.accuracy,
          acceptanceFloor: result.acceptanceFloor,
          outcomes: result.outcomes.map((o) => ({
            id: o.id,
            prompt: o.prompt,
            expected: o.expected,
            firstTool: o.firstTool,
            toolSequence: o.toolSequence,
            passed: o.passed,
            latencyMs: o.latencyMs,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `\nMCP tool-selection eval — ${passing}/${result.outcomes.length} accurate (${accuracyPct}%; floor ${floorPct}%)\n`,
    );
    for (const o of result.outcomes) {
      const tag = o.passed ? "[PASS]" : "[FAIL]";
      const firstTool = o.firstTool ?? "<none>";
      process.stdout.write(
        `  ${tag} ${o.id.padEnd(20)} ${String(o.latencyMs).padStart(5)}ms first=${firstTool} expected=${o.expected.join("|")} sequence=${o.toolSequence.join(",") || "<none>"}\n`,
      );
    }
  }

  if (result.accuracy < result.acceptanceFloor) {
    process.stderr.write(
      `\nFAIL: tool-selection accuracy ${accuracyPct}% below floor ${floorPct}%\n`,
    );
    return 1;
  }
  return 0;
}
