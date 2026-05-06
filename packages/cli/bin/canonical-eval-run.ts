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
}

const DEFAULT_BASELINE_PATH = path.resolve(
  "eval",
  "canonical-questions",
  "mcp-llm-baseline.json",
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
  return {
    schema: schemaArg as ValidSchema,
    questionsPath,
    mode,
    json,
    baselinePath,
    writeBaseline,
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
    try {
      raw = yaml.load(fs.readFileSync(filePath, "utf-8"));
    } catch (err) {
      // Re-throw with file context so a malformed entity YAML is debuggable
      // — yaml.load's default error references neither the file nor the
      // calling harness.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse semantic entity ${filePath}: ${msg}`, {
        cause: err,
      });
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

    // The `?? ""` / `?? null` are required under TS strict
    // `noUncheckedIndexedAccess` — array index access is `T | undefined`.
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

  // Stage the semantic layer for the chosen schema, identical to bin/eval.ts.
  backupSemanticLayer();
  let exitCode = 0;
  try {
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
      exitCode = 1;
      return;
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
      const mcpExitCode = await runMcpLlmMode(options);
      exitCode = mcpExitCode;
      return;
    }

    const results =
      options.mode === "llm"
        ? await runWithAgent(options)
        : await runDeterministic(options);

    if (options.json) {
      process.stdout.write(
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

    if (results.some((r) => r.status === "fail")) exitCode = 1;
  } finally {
    // Surface restore failure via the exit code — silently swallowing it
    // would let a developer see an "all green" run while their original
    // semantic/ directory is gone. Use exit 2 so it's distinguishable from
    // a normal eval failure (exit 1).
    const restored = restoreSemanticLayer();
    if (!restored) exitCode = Math.max(exitCode, 2);
  }
  process.exit(exitCode);
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
        `Tip: export ATLAS_PROVIDER=anthropic ATLAS_MODEL=claude-haiku-4-5-20251001 ANTHROPIC_API_KEY=sk-ant-...\n`,
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

  const result = await runMcpLlmEval({
    questionsPath: options.questionsPath,
    model,
    baseline,
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
    process.stdout.write(
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
      process.stdout.write(formatArtifactBundle(result.artifacts));
    }
  }

  // Acceptance criterion (#2119 Part B): ≥18/20 canonical questions
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
