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

function restoreSemanticLayer(): void {
  if (!fs.existsSync(BACKUP_DIR)) return;
  try {
    if (fs.existsSync(SEMANTIC_DIR)) {
      fs.rmSync(SEMANTIC_DIR, { recursive: true });
    }
    fs.cpSync(BACKUP_DIR, SEMANTIC_DIR, { recursive: true });
    fs.rmSync(BACKUP_DIR, { recursive: true });
  } catch (err) {
    process.stderr.write(
      `\nCRITICAL: Failed to restore semantic layer: ${err instanceof Error ? err.message : String(err)}\n` +
        `Your original semantic layer was backed up to: ${BACKUP_DIR}\n` +
        `To restore manually: rm -rf ${SEMANTIC_DIR} && cp -r ${BACKUP_DIR} ${SEMANTIC_DIR}\n`,
    );
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

interface QueryPattern {
  name: string;
  sql: string;
}

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
    const raw = yaml.load(fs.readFileSync(filePath, "utf-8"));
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const matchesEntity =
      (typeof r.name === "string" && r.name === entity) ||
      (typeof r.table === "string" && r.table === entity);
    if (!matchesEntity) continue;
    const patterns = r.query_patterns;
    if (!Array.isArray(patterns)) return null;
    for (const p of patterns as QueryPattern[]) {
      if (p && typeof p === "object" && p.name === patternName) {
        return typeof p.sql === "string" ? p.sql : null;
      }
    }
    return null;
  }
  return null;
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
    findMetricSql: (id) => {
      const m = lookups.findMetricById(id);
      return m ? m.sql : null;
    },
    findPatternSql: (entity, pattern) =>
      findPatternSqlFromDisk(entity, pattern, SEMANTIC_DIR),
    searchGlossary: (term): readonly GlossaryMatch[] => {
      const matches = lookups.searchGlossary(term);
      return matches.map((m) => ({
        term: m.term,
        status: m.status,
        possible_mappings: m.possible_mappings,
      }));
    },
    executeSql: async (sql) => {
      const db = connections.getDefault();
      const result = await db.query(sql, 60_000);
      return { columns: result.columns, rows: result.rows };
    },
  };

  const questions = loadQuestions(options.questionsPath);
  const results: QuestionResult[] = [];
  for (const q of questions) {
    process.stdout.write(`  ${q.id} ${q.category} ... `);
    const r = await resolveQuestion(q, harnessOpts);
    process.stdout.write(`${r.status}\n`);
    results.push(r);
  }
  return results;
}

// ── Wiring (LLM mode) ────────────────────────────────────────────────────

async function runWithAgent(
  options: CanonicalEvalOptions,
): Promise<QuestionResult[]> {
  const { executeAgentQuery } = await import("@atlas/api/lib/agent-query");
  const lookups = await import("@atlas/api/lib/semantic/lookups");

  const questions = loadQuestions(options.questionsPath);
  const results: QuestionResult[] = [];

  for (const q of questions) {
    process.stdout.write(`  ${q.id} ${q.category} (--llm) ... `);
    let result: QuestionResult;
    try {
      if (q.mode === "glossary") {
        // For glossary, the agent should refuse / disambiguate. We assert
        // that the disambiguation contract is honored by checking the
        // semantic-layer state directly — same as deterministic.
        const matches = lookups.searchGlossary(q.term ?? "").map((m) => ({
          term: m.term,
          status: m.status,
          possible_mappings: m.possible_mappings,
        }));
        result = compareGlossaryResult(q, matches);
      } else {
        const agent = await executeAgentQuery(q.question);
        const lastSql = agent.sql.length > 0 ? agent.sql[agent.sql.length - 1] : "";
        const lastData =
          agent.data.length > 0 ? agent.data[agent.data.length - 1] : null;
        const executed = {
          sql: lastSql,
          columns: lastData?.columns ?? [],
          rows: lastData?.rows ?? [],
        };
        switch (q.mode) {
          case "metric":
            result = compareMetricResult(q, executed);
            break;
          case "pattern":
            result = comparePatternResult(q, executed);
            break;
          case "virtual":
            result = compareVirtualResult(q, executed);
            break;
          default:
            throw new Error(`unreachable mode: ${q.mode satisfies never}`);
        }
      }
    } catch (err) {
      result = {
        question: q,
        status: "fail",
        detail: `agent error: ${err instanceof Error ? err.message : String(err)}`,
        sql: null,
      };
    }
    process.stdout.write(`${result.status}\n`);
    results.push(result);
  }
  return results;
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
    await seedDemoPostgres(connStr);

    // Reset cached connection / whitelist / explore-backend state so the
    // freshly installed semantic layer is re-resolved.
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
    restoreSemanticLayer();
  }
  process.exit(exitCode);
}
