/**
 * BIRD Benchmark harness for Atlas text-to-SQL accuracy measurement.
 *
 * Runs the BIRD dev set (~1500 questions across 11 SQLite databases),
 * using DuckDB + sqlite_scanner to load each database, the Atlas agent
 * to generate SQL, and bun:sqlite to execute gold SQL. Result sets are
 * compared order-insensitive with type coercion.
 *
 * Usage:
 *   bun run atlas -- benchmark --bird-path ./bird-dev
 *   bun run atlas -- benchmark --bird-path ./bird-dev --limit 10
 *   bun run atlas -- benchmark --bird-path ./bird-dev --db california_schools
 *   bun run atlas -- benchmark --bird-path ./bird-dev --csv
 *   bun run atlas -- benchmark --bird-path ./bird-dev --resume results.jsonl
 */

import * as fs from "fs";
import * as path from "path";
import {
  getFlag,
  generateEntityYAML,
  generateCatalogYAML,
  generateGlossaryYAML,
  type TableProfile,
  type ColumnProfile,
} from "./atlas";
import { connections, type DBConnection, type QueryResult } from "@atlas/api/lib/db/connection";
import { _resetWhitelists } from "@atlas/api/lib/semantic";
import { invalidateExploreBackend } from "@atlas/api/lib/tools/explore";

// --- Types ---

interface BIRDQuestion {
  question_id: number;
  db_id: string;
  question: string;
  evidence: string;
  SQL: string;
  difficulty: string;
}

export interface QuestionResult {
  question_id: number;
  db_id: string;
  question: string;
  difficulty: string;
  gold_sql: string;
  predicted_sql: string | null;
  match: boolean;
  error: string | null;
  latency_ms: number;
  tokens: number;
  steps: number;
}

// --- Result set comparison (re-exported from shared module) ---

import { escapeIdent, compareResultSets } from "../lib/compare";
export { escapeIdent, normalizeValue, sortRows, valuesMatch, compareResultSets, explainMismatch } from "../lib/compare";

// --- Gold SQL execution (bun:sqlite) ---

export function executeGoldSQL(
  sqlitePath: string,
  sql: string,
): { columns: string[]; rows: Record<string, unknown>[] } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require("bun:sqlite");
  const db = new Database(sqlitePath, { readonly: true });
  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all() as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : stmt.columnNames ?? [];
    return { columns, rows };
  } finally {
    db.close();
  }
}

// --- DuckDB helpers ---

async function loadDuckDB() {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  return DuckDBInstance;
}

async function duckdbQuery<T = Record<string, unknown>>(
  conn: unknown,
  sql: string,
): Promise<T[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reader = await (conn as any).runAndReadAll(sql);
  return reader.getRowObjects() as T[];
}

/**
 * Build a DBConnection wrapper around a DuckDB connection.
 */
function wrapDuckDBConnection(conn: unknown): DBConnection {
  return {
    async query(sql: string): Promise<QueryResult> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reader = await (conn as any).runAndReadAll(sql);
      const columns: string[] = reader.columnNames();
      const rows: Record<string, unknown>[] = reader.getRowObjects();
      return { columns, rows };
    },
    async close(): Promise<void> {
      // DuckDB lifecycle managed externally by closeDuckDB() — intentional no-op.
    },
  };
}

// --- Lightweight profiler for DuckDB tables ---

/**
 * Profile tables in an already-connected DuckDB instance.
 * Uses information_schema queries — no external DB connection needed.
 */
async function profileFromConnection(
  conn: unknown,
  tableNames: string[],
): Promise<TableProfile[]> {
  const profiles: TableProfile[] = [];

  for (const tableName of tableNames) {
    const countRows = await duckdbQuery<{ c: number | bigint }>(
      conn,
      `SELECT COUNT(*) as c FROM ${escapeIdent(tableName)}`,
    );
    const rowCount = Number(countRows[0].c);

    const colRows = await duckdbQuery<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      conn,
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = '${tableName.replace(/'/g, "''")}' AND table_schema = 'main'
       ORDER BY ordinal_position`,
    );

    const columns: ColumnProfile[] = [];
    for (const col of colRows) {
      let uniqueCount: number | null = null;
      let nullCount: number | null = null;
      let sampleValues: string[] = [];
      let isEnumLike = false;

      try {
        const stats = await duckdbQuery<{ u: number | bigint; n: number | bigint }>(
          conn,
          `SELECT COUNT(DISTINCT ${escapeIdent(col.column_name)}) as u, COUNT(*) - COUNT(${escapeIdent(col.column_name)}) as n FROM ${escapeIdent(tableName)}`,
        );
        uniqueCount = Number(stats[0].u);
        nullCount = Number(stats[0].n);

        // Enum-like: text columns with <=20 unique values and low cardinality
        const mappedType = mapDuckDBType(col.data_type);
        if (
          mappedType === "string" &&
          uniqueCount > 0 &&
          uniqueCount <= 20 &&
          rowCount > 0
        ) {
          const cardinality = uniqueCount / rowCount;
          if (cardinality < 0.05 || uniqueCount <= 10) {
            isEnumLike = true;
            const enumRows = await duckdbQuery<{ v: string }>(
              conn,
              `SELECT DISTINCT CAST(${escapeIdent(col.column_name)} AS VARCHAR) as v FROM ${escapeIdent(tableName)} WHERE ${escapeIdent(col.column_name)} IS NOT NULL ORDER BY v LIMIT 20`,
            );
            sampleValues = enumRows.map((r) => String(r.v));
          }
        }

        if (!isEnumLike) {
          const sampleRows = await duckdbQuery<{ v: string }>(
            conn,
            `SELECT DISTINCT CAST(${escapeIdent(col.column_name)} AS VARCHAR) as v FROM ${escapeIdent(tableName)} WHERE ${escapeIdent(col.column_name)} IS NOT NULL LIMIT 5`,
          );
          sampleValues = sampleRows.map((r) => String(r.v));
        }
      } catch (err) {
        process.stderr.write(`  WARNING: Failed to profile column "${col.column_name}" in "${tableName}": ${err instanceof Error ? err.message : String(err)}\n`);
      }

      columns.push({
        name: col.column_name,
        type: col.data_type,
        nullable: col.is_nullable === "YES",
        unique_count: uniqueCount,
        null_count: nullCount,
        sample_values: sampleValues,
        is_primary_key: false,
        is_foreign_key: false,
        fk_target_table: null,
        fk_target_column: null,
        is_enum_like: isEnumLike,
        profiler_notes: [],
      });
    }

    profiles.push({
      table_name: tableName,
      object_type: "table",
      row_count: rowCount,
      columns,
      primary_key_columns: [],
      foreign_keys: [],
      inferred_foreign_keys: [],
      profiler_notes: [],
      table_flags: {
        possibly_abandoned: false,
        possibly_denormalized: false,
      },
    });
  }

  return profiles;
}

export function mapDuckDBType(duckType: string): string {
  const t = duckType.toLowerCase();
  if (
    t.includes("int") || t.includes("float") || t.includes("double") ||
    t.includes("decimal") || t.includes("numeric") || t.includes("real") ||
    t === "hugeint" || t === "uhugeint"
  ) return "number";
  if (t.startsWith("bool")) return "boolean";
  if (t.includes("date") || t.includes("time") || t.includes("timestamp")) return "date";
  return "string";
}

// --- Semantic layer backup/restore ---

const SEMANTIC_DIR = path.resolve("semantic");
const BACKUP_DIR = path.resolve(".semantic-backup-benchmark");

function backupSemanticLayer(): void {
  if (fs.existsSync(BACKUP_DIR)) {
    fs.rmSync(BACKUP_DIR, { recursive: true });
  }
  if (fs.existsSync(SEMANTIC_DIR)) {
    fs.cpSync(SEMANTIC_DIR, BACKUP_DIR, { recursive: true });
  }
}

function restoreSemanticLayer(): void {
  if (fs.existsSync(BACKUP_DIR)) {
    if (fs.existsSync(SEMANTIC_DIR)) {
      fs.rmSync(SEMANTIC_DIR, { recursive: true });
    }
    fs.cpSync(BACKUP_DIR, SEMANTIC_DIR, { recursive: true });
    fs.rmSync(BACKUP_DIR, { recursive: true });
  }
}

function clearSemanticDir(): void {
  const entitiesDir = path.join(SEMANTIC_DIR, "entities");
  const metricsDir = path.join(SEMANTIC_DIR, "metrics");
  for (const dir of [entitiesDir, metricsDir]) {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(".yml")) fs.unlinkSync(path.join(dir, f));
      }
    }
  }
}

// --- Per-database setup ---

interface DatabaseSetupResult {
  instance: unknown;
  conn: unknown;
  dbConnection: DBConnection;
}

async function setupDatabase(
  dbId: string,
  devDbDir: string,
): Promise<DatabaseSetupResult> {
  const sqlitePath = path.join(devDbDir, dbId, `${dbId}.sqlite`);
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite file not found: ${sqlitePath}`);
  }

  const DuckDBInstance = await loadDuckDB();
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  // Install and load sqlite_scanner
  await duckdbQuery(conn, "INSTALL sqlite_scanner");
  await duckdbQuery(conn, "LOAD sqlite_scanner");

  // Attach SQLite file read-only
  await duckdbQuery(
    conn,
    `ATTACH '${sqlitePath.replace(/'/g, "''")}' AS bird_src (TYPE sqlite, READ_ONLY)`,
  );

  // Discover tables in the attached SQLite database via sqlite_master
  // (information_schema uses table_catalog for attached DBs in DuckDB,
  //  but sqlite_master is simpler and always works for attached SQLite files)
  const sqliteTables = await duckdbQuery<{ name: string }>(
    conn,
    `SELECT name FROM bird_src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
  );
  const tableNames = sqliteTables.map((t) => t.name);

  if (tableNames.length === 0) {
    throw new Error(`No tables found in SQLite database: ${sqlitePath}`);
  }

  // Copy tables into DuckDB main schema
  for (const table of tableNames) {
    await duckdbQuery(
      conn,
      `CREATE TABLE main.${escapeIdent(table)} AS SELECT * FROM bird_src.${escapeIdent(table)}`,
    );
  }

  // Detach SQLite source
  await duckdbQuery(conn, "DETACH bird_src");

  // Build DBConnection wrapper
  const dbConnection = wrapDuckDBConnection(conn);

  // Register in ConnectionRegistry
  connections._reset();
  connections.registerDirect("default", dbConnection, "duckdb");

  // Profile tables and generate semantic layer
  const profiles = await profileFromConnection(conn, tableNames);

  // Write YAMLs
  clearSemanticDir();
  const entitiesDir = path.join(SEMANTIC_DIR, "entities");
  const metricsDir = path.join(SEMANTIC_DIR, "metrics");
  fs.mkdirSync(entitiesDir, { recursive: true });
  fs.mkdirSync(metricsDir, { recursive: true });

  for (const profile of profiles) {
    const entityYaml = generateEntityYAML(profile, profiles, "duckdb", "main");
    fs.writeFileSync(path.join(entitiesDir, `${profile.table_name}.yml`), entityYaml);
  }

  fs.writeFileSync(path.join(SEMANTIC_DIR, "catalog.yml"), generateCatalogYAML(profiles));
  fs.writeFileSync(path.join(SEMANTIC_DIR, "glossary.yml"), generateGlossaryYAML(profiles));

  // Refresh caches
  _resetWhitelists();
  invalidateExploreBackend();

  return { instance, conn, dbConnection };
}

function closeDuckDB(instance: unknown, conn: unknown): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).disconnectSync();
  } catch (err) {
    process.stderr.write(`WARNING: DuckDB disconnect failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (instance as any).closeSync();
  } catch (err) {
    process.stderr.write(`WARNING: DuckDB close failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// --- Question evaluation ---

async function evaluateQuestion(
  q: BIRDQuestion,
  devDbDir: string,
): Promise<QuestionResult> {
  const start = Date.now();

  try {
    // Build question text with evidence hint
    let questionText = q.question;
    if (q.evidence && q.evidence.trim()) {
      questionText += `\n\nHint: ${q.evidence}`;
    }

    // Run agent
    const { executeAgentQuery } = await import("@atlas/api/lib/agent-query");
    const result = await executeAgentQuery(questionText);

    const latencyMs = Date.now() - start;
    const predictedSql = result.sql.length > 0 ? result.sql[result.sql.length - 1] : null;

    // Execute gold SQL via bun:sqlite
    const sqlitePath = path.join(devDbDir, q.db_id, `${q.db_id}.sqlite`);
    const goldResult = executeGoldSQL(sqlitePath, q.SQL);

    // Get predicted result (agent already executed it)
    const predictedResult = result.data.length > 0 ? result.data[result.data.length - 1] : null;

    let match = false;
    if (predictedResult) {
      match = compareResultSets(goldResult, predictedResult);
    }

    return {
      question_id: q.question_id,
      db_id: q.db_id,
      question: q.question,
      difficulty: q.difficulty,
      gold_sql: q.SQL,
      predicted_sql: predictedSql,
      match,
      error: null,
      latency_ms: latencyMs,
      tokens: result.usage.totalTokens,
      steps: result.steps,
    };
  } catch (err) {
    process.stderr.write(`\n  ERROR evaluating Q${q.question_id}: ${err instanceof Error && err.stack ? err.stack : String(err)}\n`);
    return {
      question_id: q.question_id,
      db_id: q.db_id,
      question: q.question,
      difficulty: q.difficulty,
      gold_sql: q.SQL,
      predicted_sql: null,
      match: false,
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
      tokens: 0,
      steps: 0,
    };
  }
}

// --- Summary printing ---

function printSummary(results: QuestionResult[], csvOutput: boolean): void {
  if (csvOutput) {
    console.log("question_id,db_id,difficulty,match,predicted_sql,gold_sql,error,latency_ms,tokens,steps");
    for (const r of results) {
      const csvSafe = (s: string | null) =>
        s ? `"${s.replace(/"/g, '""').replace(/\n/g, " ")}"` : "";
      console.log(
        [
          r.question_id,
          r.db_id,
          r.difficulty,
          r.match,
          csvSafe(r.predicted_sql),
          csvSafe(r.gold_sql),
          csvSafe(r.error),
          r.latency_ms,
          r.tokens,
          r.steps,
        ].join(","),
      );
    }
    return;
  }

  const total = results.length;
  const correct = results.filter((r) => r.match).length;
  const errors = results.filter((r) => r.error).length;
  const accuracy = total > 0 ? ((correct / total) * 100).toFixed(1) : "0.0";

  console.log("\n" + "=".repeat(60));
  console.log("BIRD Benchmark Results");
  console.log("=".repeat(60));
  console.log(`Total:    ${total}`);
  console.log(`Correct:  ${correct}`);
  console.log(`Errors:   ${errors}`);
  console.log(`Accuracy: ${accuracy}%`);

  // Per-database breakdown
  const byDb = new Map<string, QuestionResult[]>();
  for (const r of results) {
    const arr = byDb.get(r.db_id) ?? [];
    arr.push(r);
    byDb.set(r.db_id, arr);
  }

  if (byDb.size > 1) {
    console.log("\nPer-database:");
    for (const [dbId, dbResults] of [...byDb.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const dbCorrect = dbResults.filter((r) => r.match).length;
      const dbAcc = ((dbCorrect / dbResults.length) * 100).toFixed(1);
      console.log(`  ${dbId.padEnd(30)} ${dbCorrect}/${dbResults.length} (${dbAcc}%)`);
    }
  }

  // Per-difficulty breakdown
  const byDiff = new Map<string, QuestionResult[]>();
  for (const r of results) {
    const arr = byDiff.get(r.difficulty) ?? [];
    arr.push(r);
    byDiff.set(r.difficulty, arr);
  }

  if (byDiff.size > 1) {
    console.log("\nPer-difficulty:");
    for (const [diff, diffResults] of [...byDiff.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const diffCorrect = diffResults.filter((r) => r.match).length;
      const diffAcc = ((diffCorrect / diffResults.length) * 100).toFixed(1);
      console.log(`  ${diff.padEnd(15)} ${diffCorrect}/${diffResults.length} (${diffAcc}%)`);
    }
  }

  // Token and latency stats
  const totalTokens = results.reduce((s, r) => s + r.tokens, 0);
  const totalLatency = results.reduce((s, r) => s + r.latency_ms, 0);
  const avgLatency = total > 0 ? Math.round(totalLatency / total) : 0;
  console.log(`\nTotal tokens: ${totalTokens.toLocaleString()}`);
  console.log(`Avg latency:  ${avgLatency.toLocaleString()}ms`);
  console.log("=".repeat(60));
}

// --- Main entry point ---

export async function handleBenchmark(args: string[]): Promise<void> {
  const birdPath = getFlag(args, "--bird-path");
  if (!birdPath) {
    console.error(
      "Usage: atlas benchmark --bird-path <path> [options]\n\n" +
      "Options:\n" +
      "  --bird-path <path>   Path to BIRD dev directory (required)\n" +
      "  --limit <n>          Max questions to evaluate\n" +
      "  --db <name>          Filter to a single database\n" +
      "  --csv                CSV output\n" +
      "  --resume <file>      Resume from existing JSONL results file",
    );
    process.exit(1);
  }

  const limitArg = getFlag(args, "--limit");
  const limit = limitArg ? parseInt(limitArg, 10) : undefined;
  const dbFilter = getFlag(args, "--db");
  const csvOutput = args.includes("--csv");
  const resumeFile = getFlag(args, "--resume");

  // Locate BIRD files
  const devJsonPath = path.resolve(birdPath, "dev.json");
  const devDbDir = path.resolve(birdPath, "dev_databases");

  if (!fs.existsSync(devJsonPath)) {
    console.error(`Error: dev.json not found at ${devJsonPath}`);
    console.error("  Expected BIRD directory structure:");
    console.error("    <bird-path>/dev.json");
    console.error("    <bird-path>/dev_databases/<db_id>/<db_id>.sqlite");
    process.exit(1);
  }

  if (!fs.existsSync(devDbDir)) {
    console.error(`Error: dev_databases directory not found at ${devDbDir}`);
    process.exit(1);
  }

  // Load questions
  const allQuestions: BIRDQuestion[] = JSON.parse(
    fs.readFileSync(devJsonPath, "utf-8"),
  );

  // Filter by database
  let questions = dbFilter
    ? allQuestions.filter((q) => q.db_id === dbFilter)
    : allQuestions;

  if (questions.length === 0) {
    console.error(`Error: No questions found${dbFilter ? ` for database "${dbFilter}"` : ""}.`);
    if (dbFilter) {
      const dbIds = [...new Set(allQuestions.map((q) => q.db_id))].sort();
      console.error(`  Available databases: ${dbIds.join(", ")}`);
    }
    process.exit(1);
  }

  // Apply limit
  if (limit && limit > 0) {
    questions = questions.slice(0, limit);
  }

  // Load completed results for resume
  const completedIds = new Set<number>();
  const allResults: QuestionResult[] = [];
  const resultsFile = resumeFile ?? `benchmark-results-${Date.now()}.jsonl`;

  if (resumeFile && fs.existsSync(resumeFile)) {
    const lines = fs.readFileSync(resumeFile, "utf-8").split("\n").filter(Boolean);
    let skippedLines = 0;
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as QuestionResult;
        if (typeof r.question_id !== "number" || Number.isNaN(r.question_id)) {
          skippedLines++;
          continue;
        }
        completedIds.add(r.question_id);
        allResults.push(r);
      } catch {
        skippedLines++;
      }
    }
    if (skippedLines > 0) {
      process.stderr.write(`WARNING: ${skippedLines} malformed line(s) skipped in resume file\n`);
    }
    console.log(`Resuming: ${completedIds.size} questions already completed`);
  }

  // Group questions by db_id
  const byDb = new Map<string, BIRDQuestion[]>();
  for (const q of questions) {
    if (completedIds.has(q.question_id)) continue;
    const arr = byDb.get(q.db_id) ?? [];
    arr.push(q);
    byDb.set(q.db_id, arr);
  }

  const completedInScope = questions.filter(q => completedIds.has(q.question_id)).length;
  const remainingCount = questions.length - completedInScope;
  const dbCount = byDb.size;
  console.log(
    `BIRD Benchmark: ${questions.length} questions across ${dbCount} database(s)` +
    (completedIds.size > 0 ? ` (${remainingCount} remaining)` : ""),
  );

  // Backup semantic layer
  backupSemanticLayer();

  try {
    let questionIdx = 0;

    for (const [dbId, dbQuestions] of byDb) {
      console.log(`\n--- Database: ${dbId} (${dbQuestions.length} questions) ---`);

      let setup: DatabaseSetupResult | null = null;
      try {
        setup = await setupDatabase(dbId, devDbDir);

        for (const q of dbQuestions) {
          questionIdx++;
          const progress = `[${questionIdx}/${remainingCount}]`;
          process.stderr.write(`${progress} Q${q.question_id} (${q.difficulty}): ${q.question.slice(0, 60)}...`);

          const result = await evaluateQuestion(q, devDbDir);
          allResults.push(result);

          // Append to JSONL
          fs.appendFileSync(resultsFile, JSON.stringify(result) + "\n");

          const status = result.match ? "PASS" : result.error ? "ERROR" : "FAIL";
          process.stderr.write(` ${status} (${result.latency_ms}ms)\n`);
        }
      } catch (dbErr) {
        console.error(
          `  Error setting up database ${dbId}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        );
        // Mark all questions for this DB as errored
        for (const q of dbQuestions) {
          const errResult: QuestionResult = {
            question_id: q.question_id,
            db_id: q.db_id,
            question: q.question,
            difficulty: q.difficulty,
            gold_sql: q.SQL,
            predicted_sql: null,
            match: false,
            error: `Database setup failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
            latency_ms: 0,
            tokens: 0,
            steps: 0,
          };
          allResults.push(errResult);
          fs.appendFileSync(resultsFile, JSON.stringify(errResult) + "\n");
        }
      } finally {
        if (setup) {
          closeDuckDB(setup.instance, setup.conn);
        }
      }
    }
  } finally {
    restoreSemanticLayer();
  }

  // Print summary
  printSummary(allResults, csvOutput);

  if (!csvOutput) {
    console.log(`\nResults saved to: ${resultsFile}`);
  }
}
