/**
 * CLI driver for the canonical-question eval harness.
 *
 * Usage:
 *   bun run atlas -- canonical-eval                 # deterministic mode (default)
 *   bun run atlas -- canonical-eval --llm           # full agent loop, snapshot SQL
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
  llm: boolean;
  json: boolean;
}

function parseOptions(args: string[]): CanonicalEvalOptions {
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
  const json = args.includes("--json");
  return {
    schema: schemaArg as ValidSchema,
    questionsPath,
    llm,
    json,
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
      return compareGlossaryResult(q, toGlossaryMatches(lookups, q.term ?? ""));
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
        const _exhaustive: never = q.mode;
        throw new Error(`unreachable mode: ${String(_exhaustive)}`);
      }
    }
  });
}

// ── Entrypoint ───────────────────────────────────────────────────────────

export async function handleCanonicalEval(args: string[]): Promise<void> {
  const options = parseOptions(args);

  const connStr = process.env.ATLAS_DATASOURCE_URL;
  if (!connStr) {
    process.stderr.write(
      "Error: ATLAS_DATASOURCE_URL is required for canonical-eval.\n" +
        "Tip: bun run db:up && export ATLAS_DATASOURCE_URL=postgres://atlas:atlas@localhost:5433/atlas_demo\n",
    );
    process.exit(1);
  }

  process.stdout.write(
    `Atlas canonical-question eval — schema=${options.schema} mode=${options.llm ? "llm" : "deterministic"}\n`,
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

    const results = options.llm
      ? await runWithAgent(options)
      : await runDeterministic(options);

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            schema: options.schema,
            mode: options.llm ? "llm" : "deterministic",
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
