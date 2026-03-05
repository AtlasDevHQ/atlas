/**
 * Atlas eval pipeline — run curated YAML eval cases against demo Postgres schemas,
 * compare agent output against gold SQL, and detect regressions.
 *
 * Usage:
 *   bun run atlas -- eval                          # Run all cases
 *   bun run atlas -- eval --schema cybersec        # Filter by schema
 *   bun run atlas -- eval --category aggregation   # Filter by category
 *   bun run atlas -- eval --difficulty simple       # Filter by difficulty
 *   bun run atlas -- eval --id cs-001              # Single case
 *   bun run atlas -- eval --limit 5                # Max N cases
 *   bun run atlas -- eval --resume results.jsonl   # Resume from JSONL
 *   bun run atlas -- eval --baseline               # Save results as new baseline
 *   bun run atlas -- eval --compare <file.jsonl>   # Diff against baseline (exit 1 on regression)
 *   bun run atlas -- eval --csv                    # CSV output
 *   bun run atlas -- eval --json                   # JSON summary output
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { getFlag, seedDemoPostgres, type DemoDataset } from "./atlas";
import { explainMismatch } from "../lib/compare";
import { connections } from "@atlas/api/lib/db/connection";
import { _resetWhitelists } from "@atlas/api/lib/semantic";
import { invalidateExploreBackend } from "@atlas/api/lib/tools/explore";

// --- Types ---

export interface EvalCase {
  id: string;
  question: string;
  schema: DemoDataset;
  difficulty: "simple" | "medium" | "complex";
  category: string;
  tags: string[];
  gold_sql: string;
  skip?: boolean;
  expected_rows?: number;
  notes?: string;
}

export interface EvalResult {
  id: string;
  schema: string;
  question: string;
  category: string;
  difficulty: string;
  tags: string[];
  gold_sql: string;
  predicted_sql: string | null;
  match: boolean;
  error: string | null;
  latency_ms: number;
  tokens: number;
  steps: number;
}

interface EvalSummary {
  total: number;
  correct: number;
  errors: number;
  accuracy: number;
  bySchema: Map<string, { total: number; correct: number }>;
  byCategory: Map<string, { total: number; correct: number }>;
  byDifficulty: Map<string, { total: number; correct: number }>;
  totalTokens: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
}

interface RegressionReport {
  regressions: EvalResult[];
  newPasses: EvalResult[];
  newCases: EvalResult[];
  stable: number;
}

// --- YAML case loading ---

const EVAL_DIR = path.resolve("eval");
const CASES_DIR = path.join(EVAL_DIR, "cases");
const SCHEMAS_DIR = path.join(EVAL_DIR, "schemas");
const BASELINES_DIR = path.join(EVAL_DIR, "baselines");
const SEMANTIC_DIR = path.resolve("semantic");
const BACKUP_DIR = path.resolve(".semantic-backup-eval");

const REQUIRED_CASE_FIELDS = ["id", "question", "schema", "difficulty", "category", "gold_sql"] as const;
const VALID_DIFFICULTIES = ["simple", "medium", "complex"] as const;
const VALID_SCHEMAS: DemoDataset[] = ["simple", "cybersec", "ecommerce"];

export function loadEvalCases(casesDir: string = CASES_DIR): EvalCase[] {
  if (!fs.existsSync(casesDir)) {
    throw new Error(`Eval cases directory not found: ${casesDir}`);
  }

  const cases: EvalCase[] = [];
  const seenIds = new Set<string>();
  const schemaDirs = fs.readdirSync(casesDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const schemaDir of schemaDirs) {
    const dirPath = path.join(casesDir, schemaDir);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith(".yml") || f.endsWith(".yaml"));

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const doc = yaml.load(content) as Record<string, unknown>;

      validateCase(doc, filePath);

      const caseId = doc.id as string;
      if (seenIds.has(caseId)) {
        throw new Error(`Duplicate eval case id "${caseId}" in ${filePath}`);
      }
      seenIds.add(caseId);

      cases.push({
        id: doc.id as string,
        question: doc.question as string,
        schema: doc.schema as DemoDataset,
        difficulty: doc.difficulty as EvalCase["difficulty"],
        category: doc.category as string,
        tags: (doc.tags as string[]) ?? [],
        gold_sql: (doc.gold_sql as string).trim(),
        skip: doc.skip as boolean | undefined,
        expected_rows: doc.expected_rows as number | undefined,
        notes: doc.notes as string | undefined,
      });
    }
  }

  return cases;
}

export function validateCase(doc: Record<string, unknown>, filePath: string): void {
  for (const field of REQUIRED_CASE_FIELDS) {
    if (!doc[field]) {
      throw new Error(`Missing required field "${field}" in ${filePath}`);
    }
  }

  if (!VALID_SCHEMAS.includes(doc.schema as DemoDataset)) {
    throw new Error(`Invalid schema "${doc.schema}" in ${filePath}. Valid: ${VALID_SCHEMAS.join(", ")}`);
  }

  if (!VALID_DIFFICULTIES.includes(doc.difficulty as typeof VALID_DIFFICULTIES[number])) {
    throw new Error(`Invalid difficulty "${doc.difficulty}" in ${filePath}. Valid: ${VALID_DIFFICULTIES.join(", ")}`);
  }

  if (typeof doc.id !== "string" || !doc.id.trim()) {
    throw new Error(`Invalid id in ${filePath}: must be a non-empty string`);
  }

  if (typeof doc.question !== "string" || !doc.question.trim()) {
    throw new Error(`Invalid question in ${filePath}: must be a non-empty string`);
  }

  if (typeof doc.gold_sql !== "string" || !doc.gold_sql.trim()) {
    throw new Error(`Invalid gold_sql in ${filePath}: must be a non-empty string`);
  }
}

export function filterCases(
  cases: EvalCase[],
  filters: {
    schema?: string;
    category?: string;
    difficulty?: string;
    id?: string;
    limit?: number;
  },
): EvalCase[] {
  let filtered = cases.filter(c => !c.skip);

  if (filters.id) {
    filtered = filtered.filter(c => c.id === filters.id);
  }
  if (filters.schema) {
    filtered = filtered.filter(c => c.schema === filters.schema);
  }
  if (filters.category) {
    filtered = filtered.filter(c => c.category === filters.category);
  }
  if (filters.difficulty) {
    filtered = filtered.filter(c => c.difficulty === filters.difficulty);
  }
  if (filters.limit && filters.limit > 0) {
    filtered = filtered.slice(0, filters.limit);
  }

  return filtered;
}

// --- Semantic layer management ---

function backupSemanticLayer(): void {
  if (fs.existsSync(BACKUP_DIR)) {
    fs.rmSync(BACKUP_DIR, { recursive: true });
  }
  if (fs.existsSync(SEMANTIC_DIR)) {
    try {
      fs.cpSync(SEMANTIC_DIR, BACKUP_DIR, { recursive: true });
    } catch (err) {
      throw new Error(
        `Failed to backup semantic layer before eval: ${err instanceof Error ? err.message : String(err)}. ` +
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

function installSchemaSemanticLayer(schema: string): void {
  const srcDir = path.join(SCHEMAS_DIR, schema);
  if (!fs.existsSync(srcDir)) {
    throw new Error(`Semantic layer not found for schema "${schema}" at ${srcDir}`);
  }

  if (fs.existsSync(SEMANTIC_DIR)) {
    fs.rmSync(SEMANTIC_DIR, { recursive: true });
  }
  fs.cpSync(srcDir, SEMANTIC_DIR, { recursive: true });
}

function resetCaches(): void {
  connections._reset();
  _resetWhitelists();
  invalidateExploreBackend();
}

// --- Case evaluation ---

async function evaluateCase(
  evalCase: EvalCase,
): Promise<EvalResult> {
  const start = Date.now();
  const baseResult = {
    id: evalCase.id,
    schema: evalCase.schema,
    question: evalCase.question,
    category: evalCase.category,
    difficulty: evalCase.difficulty,
    tags: evalCase.tags,
    gold_sql: evalCase.gold_sql,
  };

  // 1) Run agent
  let agentResult: Awaited<ReturnType<typeof import("@atlas/api/lib/agent-query").executeAgentQuery>>;
  try {
    const { executeAgentQuery } = await import("@atlas/api/lib/agent-query");
    agentResult = await executeAgentQuery(evalCase.question);
  } catch (err) {
    process.stderr.write(
      `\n  AGENT ERROR ${evalCase.id}: ${err instanceof Error && err.stack ? err.stack : String(err)}\n`,
    );
    return {
      ...baseResult,
      predicted_sql: null,
      match: false,
      error: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
      latency_ms: Date.now() - start,
      tokens: 0,
      steps: 0,
    };
  }

  const latencyMs = Date.now() - start;
  const predictedSql = agentResult.sql.length > 0 ? agentResult.sql[agentResult.sql.length - 1] : null;

  // 2) Execute gold SQL directly (bypasses validation — developer-authored queries only)
  const trimmedGold = evalCase.gold_sql.trim().toUpperCase();
  if (!trimmedGold.startsWith("SELECT") && !trimmedGold.startsWith("WITH")) {
    return {
      ...baseResult,
      predicted_sql: predictedSql,
      match: false,
      error: `Gold SQL for ${evalCase.id} is not a SELECT/WITH statement`,
      latency_ms: latencyMs,
      tokens: agentResult.usage.totalTokens,
      steps: agentResult.steps,
    };
  }

  let goldResult: { columns: string[]; rows: Record<string, unknown>[] };
  try {
    const db = connections.getDefault();
    goldResult = await db.query(evalCase.gold_sql, 60000);
  } catch (err) {
    process.stderr.write(
      `\n  GOLD SQL ERROR ${evalCase.id}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return {
      ...baseResult,
      predicted_sql: predictedSql,
      match: false,
      error: `Gold SQL error (test harness bug): ${err instanceof Error ? err.message : String(err)}`,
      latency_ms: latencyMs,
      tokens: agentResult.usage.totalTokens,
      steps: agentResult.steps,
    };
  }

  // 3) Compare result sets
  const predictedResult = agentResult.data.length > 0 ? agentResult.data[agentResult.data.length - 1] : null;
  let match = false;
  if (predictedResult) {
    const mismatchReason = explainMismatch(goldResult, predictedResult);
    match = mismatchReason === null;
    if (mismatchReason) {
      process.stderr.write(`\n  MISMATCH ${evalCase.id}: ${mismatchReason}\n`);
    }
  }

  return {
    ...baseResult,
    predicted_sql: predictedSql,
    match,
    error: null,
    latency_ms: latencyMs,
    tokens: agentResult.usage.totalTokens,
    steps: agentResult.steps,
  };
}

// --- Summary ---

export function computeSummary(results: EvalResult[]): EvalSummary {
  const total = results.length;
  const correct = results.filter(r => r.match).length;
  const errors = results.filter(r => r.error).length;
  const accuracy = total > 0 ? (correct / total) * 100 : 0;

  const bySchema = new Map<string, { total: number; correct: number }>();
  const byCategory = new Map<string, { total: number; correct: number }>();
  const byDifficulty = new Map<string, { total: number; correct: number }>();

  for (const r of results) {
    for (const [map, key] of [
      [bySchema, r.schema],
      [byCategory, r.category],
      [byDifficulty, r.difficulty],
    ] as [Map<string, { total: number; correct: number }>, string][]) {
      const entry = map.get(key) ?? { total: 0, correct: 0 };
      entry.total++;
      if (r.match) entry.correct++;
      map.set(key, entry);
    }
  }

  const totalTokens = results.reduce((s, r) => s + r.tokens, 0);
  const totalLatencyMs = results.reduce((s, r) => s + r.latency_ms, 0);
  const avgLatencyMs = total > 0 ? Math.round(totalLatencyMs / total) : 0;

  return {
    total,
    correct,
    errors,
    accuracy,
    bySchema,
    byCategory,
    byDifficulty,
    totalTokens,
    totalLatencyMs,
    avgLatencyMs,
  };
}

function printSummary(summary: EvalSummary): void {
  console.log("\n" + "=".repeat(60));
  console.log("Atlas Eval Results");
  console.log("=".repeat(60));
  console.log(`Total:    ${summary.total}`);
  console.log(`Correct:  ${summary.correct}`);
  console.log(`Errors:   ${summary.errors}`);
  console.log(`Accuracy: ${summary.accuracy.toFixed(1)}%`);

  if (summary.bySchema.size > 1) {
    console.log("\nPer-schema:");
    for (const [schema, stats] of [...summary.bySchema.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const acc = ((stats.correct / stats.total) * 100).toFixed(1);
      console.log(`  ${schema.padEnd(20)} ${stats.correct}/${stats.total} (${acc}%)`);
    }
  }

  if (summary.byCategory.size > 1) {
    console.log("\nPer-category:");
    for (const [cat, stats] of [...summary.byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const acc = ((stats.correct / stats.total) * 100).toFixed(1);
      console.log(`  ${cat.padEnd(20)} ${stats.correct}/${stats.total} (${acc}%)`);
    }
  }

  if (summary.byDifficulty.size > 1) {
    console.log("\nPer-difficulty:");
    for (const [diff, stats] of [...summary.byDifficulty.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const acc = ((stats.correct / stats.total) * 100).toFixed(1);
      console.log(`  ${diff.padEnd(15)} ${stats.correct}/${stats.total} (${acc}%)`);
    }
  }

  console.log(`\nTotal tokens: ${summary.totalTokens.toLocaleString()}`);
  console.log(`Avg latency:  ${summary.avgLatencyMs.toLocaleString()}ms`);
  console.log("=".repeat(60));
}

function printCSV(results: EvalResult[]): void {
  console.log("id,schema,difficulty,category,match,predicted_sql,gold_sql,error,latency_ms,tokens,steps");
  for (const r of results) {
    const csvSafe = (s: string | null) =>
      s ? `"${s.replace(/"/g, '""').replace(/\n/g, " ")}"` : "";
    console.log(
      [
        r.id,
        r.schema,
        r.difficulty,
        r.category,
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
}

function printJSON(results: EvalResult[], summary: EvalSummary): void {
  const output = {
    summary: {
      total: summary.total,
      correct: summary.correct,
      errors: summary.errors,
      accuracy: Number(summary.accuracy.toFixed(1)),
      totalTokens: summary.totalTokens,
      avgLatencyMs: summary.avgLatencyMs,
    },
    bySchema: Object.fromEntries(summary.bySchema),
    byCategory: Object.fromEntries(summary.byCategory),
    byDifficulty: Object.fromEntries(summary.byDifficulty),
    results,
  };
  console.log(JSON.stringify(output, null, 2));
}

// --- Regression detection ---

export function detectRegressions(
  current: EvalResult[],
  baseline: EvalResult[],
): RegressionReport {
  const baselineMap = new Map<string, EvalResult>();
  for (const r of baseline) {
    baselineMap.set(r.id, r);
  }

  const regressions: EvalResult[] = [];
  const newPasses: EvalResult[] = [];
  const newCases: EvalResult[] = [];
  let stable = 0;

  for (const r of current) {
    const prev = baselineMap.get(r.id);
    if (!prev) {
      newCases.push(r);
    } else if (prev.match && !r.match) {
      regressions.push(r);
    } else if (!prev.match && r.match) {
      newPasses.push(r);
    } else {
      stable++;
    }
  }

  return { regressions, newPasses, newCases, stable };
}

function printRegressionReport(report: RegressionReport): void {
  console.log("\n" + "=".repeat(60));
  console.log("Regression Report");
  console.log("=".repeat(60));

  if (report.regressions.length > 0) {
    console.log(`\n\x1b[31mREGRESSIONS (${report.regressions.length}):\x1b[0m`);
    for (const r of report.regressions) {
      console.log(`  FAIL ${r.id} [${r.schema}/${r.category}] ${r.question.slice(0, 60)}`);
      if (r.error) console.log(`       Error: ${r.error}`);
    }
  }

  if (report.newPasses.length > 0) {
    console.log(`\n\x1b[32mNEW PASSES (${report.newPasses.length}):\x1b[0m`);
    for (const r of report.newPasses) {
      console.log(`  PASS ${r.id} [${r.schema}/${r.category}] ${r.question.slice(0, 60)}`);
    }
  }

  if (report.newCases.length > 0) {
    console.log(`\nNEW CASES (${report.newCases.length}):`);
    for (const r of report.newCases) {
      const status = r.match ? "PASS" : "FAIL";
      console.log(`  ${status} ${r.id} [${r.schema}/${r.category}] ${r.question.slice(0, 60)}`);
    }
  }

  console.log(`\nStable: ${report.stable}`);
  console.log("=".repeat(60));
}

function loadBaseline(filePath: string): EvalResult[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Baseline file not found: ${filePath}`);
  }

  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  const results: EvalResult[] = [];
  let skippedLines = 0;

  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]) as EvalResult;
      if (typeof parsed.id !== "string" || !parsed.id || typeof parsed.match !== "boolean") {
        skippedLines++;
        continue;
      }
      results.push(parsed);
    } catch (err) {
      if (skippedLines < 3) {
        process.stderr.write(
          `WARNING: Baseline line ${i + 1} is malformed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      skippedLines++;
    }
  }

  if (skippedLines > 0) {
    process.stderr.write(`WARNING: ${skippedLines} of ${lines.length} baseline line(s) skipped in ${filePath}\n`);
  }

  return results;
}

// --- Main entry point ---

export async function handleEval(args: string[]): Promise<void> {
  const schemaFilter = getFlag(args, "--schema");
  const categoryFilter = getFlag(args, "--category");
  const difficultyFilter = getFlag(args, "--difficulty");
  const idFilter = getFlag(args, "--id");
  const limitArg = getFlag(args, "--limit");
  const limit = limitArg ? parseInt(limitArg, 10) : undefined;
  const resumeFile = getFlag(args, "--resume");
  const compareFile = getFlag(args, "--compare");
  if (compareFile && !fs.existsSync(compareFile)) {
    console.error(`Error: Baseline file not found: ${compareFile}`);
    process.exit(1);
  }
  const saveBaseline = args.includes("--baseline");
  const csvOutput = args.includes("--csv");
  const jsonOutput = args.includes("--json");

  // Load and filter cases
  let allCases: EvalCase[];
  try {
    allCases = loadEvalCases();
  } catch (err) {
    console.error(`Error loading eval cases: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const cases = filterCases(allCases, {
    schema: schemaFilter,
    category: categoryFilter,
    difficulty: difficultyFilter,
    id: idFilter,
    limit,
  });

  if (cases.length === 0) {
    console.error("No eval cases match the given filters.");
    process.exit(1);
  }

  // Load completed results for resume
  const completedIds = new Set<string>();
  const allResults: EvalResult[] = [];
  const resultsFile = resumeFile ?? `eval-results-${Date.now()}.jsonl`;

  if (resumeFile && fs.existsSync(resumeFile)) {
    const lines = fs.readFileSync(resumeFile, "utf-8").split("\n").filter(Boolean);
    let skippedLines = 0;
    for (let i = 0; i < lines.length; i++) {
      try {
        const r = JSON.parse(lines[i]) as EvalResult;
        if (typeof r.id !== "string" || !r.id) {
          skippedLines++;
          continue;
        }
        completedIds.add(r.id);
        allResults.push(r);
      } catch (err) {
        if (skippedLines < 3) {
          process.stderr.write(
            `WARNING: Resume line ${i + 1} is malformed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        skippedLines++;
      }
    }
    if (skippedLines > 0) {
      process.stderr.write(`WARNING: ${skippedLines} malformed line(s) skipped in resume file\n`);
    }
    console.log(`Resuming: ${completedIds.size} cases already completed`);
  }

  // Group remaining cases by schema to minimize re-seeding
  const bySchema = new Map<string, EvalCase[]>();
  for (const c of cases) {
    if (completedIds.has(c.id)) continue;
    const arr = bySchema.get(c.schema) ?? [];
    arr.push(c);
    bySchema.set(c.schema, arr);
  }

  const completedInScope = cases.filter(c => completedIds.has(c.id)).length;
  const remainingCount = cases.length - completedInScope;
  const schemaCount = bySchema.size;

  if (!csvOutput && !jsonOutput) {
    console.log(
      `Atlas Eval: ${cases.length} cases across ${schemaCount} schema(s)` +
      (completedIds.size > 0 ? ` (${remainingCount} remaining)` : ""),
    );
  }

  // Get connection string
  const connStr = process.env.ATLAS_DATASOURCE_URL;
  if (!connStr) {
    console.error("Error: ATLAS_DATASOURCE_URL is required for eval");
    process.exit(1);
  }

  // Backup semantic layer
  backupSemanticLayer();

  try {
    let caseIdx = 0;

    for (const [schema, schemaCases] of bySchema) {
      if (!csvOutput && !jsonOutput) {
        console.log(`\n--- Schema: ${schema} (${schemaCases.length} cases) ---`);
      }

      // Setup phase — errors here affect all cases in this schema
      try {
        await seedDemoPostgres(connStr, schema as DemoDataset);
        installSchemaSemanticLayer(schema);
        resetCaches();
        process.env.ATLAS_DATASOURCE_URL = connStr;
      } catch (schemaErr) {
        console.error(
          `  Error setting up schema ${schema}: ${schemaErr instanceof Error ? schemaErr.message : String(schemaErr)}`,
        );
        for (const c of schemaCases) {
          const errResult: EvalResult = {
            id: c.id,
            schema: c.schema,
            question: c.question,
            category: c.category,
            difficulty: c.difficulty,
            tags: c.tags,
            gold_sql: c.gold_sql,
            predicted_sql: null,
            match: false,
            error: `Schema setup failed: ${schemaErr instanceof Error ? schemaErr.message : String(schemaErr)}`,
            latency_ms: 0,
            tokens: 0,
            steps: 0,
          };
          allResults.push(errResult);
          fs.appendFileSync(resultsFile, JSON.stringify(errResult) + "\n");
        }
        continue;
      }

      // Evaluation phase — individual cases handle their own errors
      for (const evalCase of schemaCases) {
        caseIdx++;
        const progress = `[${caseIdx}/${remainingCount}]`;

        if (!csvOutput && !jsonOutput) {
          process.stderr.write(
            `${progress} ${evalCase.id} (${evalCase.difficulty}): ${evalCase.question.slice(0, 60)}...`,
          );
        }

        const result = await evaluateCase(evalCase);
        allResults.push(result);

        // Append to JSONL
        fs.appendFileSync(resultsFile, JSON.stringify(result) + "\n");

        const status = result.match ? "PASS" : result.error ? "ERROR" : "FAIL";
        if (!csvOutput && !jsonOutput) {
          process.stderr.write(` ${status} (${result.latency_ms}ms)\n`);
        }
      }
    }
  } finally {
    restoreSemanticLayer();
  }

  // Output results
  const summary = computeSummary(allResults);

  if (csvOutput) {
    printCSV(allResults);
  } else if (jsonOutput) {
    printJSON(allResults, summary);
  } else {
    printSummary(summary);
    console.log(`\nResults saved to: ${resultsFile}`);
  }

  // Baseline save
  if (saveBaseline) {
    const provider = process.env.ATLAS_PROVIDER ?? "anthropic";
    const model = (process.env.ATLAS_MODEL ?? "claude-opus-4-6").replace(/[/:]/g, "-");
    const baselineFile = path.join(BASELINES_DIR, `${provider}-${model}.jsonl`);
    fs.mkdirSync(BASELINES_DIR, { recursive: true });
    const content = allResults.map(r => JSON.stringify(r)).join("\n") + "\n";
    fs.writeFileSync(baselineFile, content);
    console.log(`\nBaseline saved to: ${baselineFile}`);
  }

  // Regression comparison
  if (compareFile) {
    const baseline = loadBaseline(compareFile);
    const report = detectRegressions(allResults, baseline);
    printRegressionReport(report);

    if (report.regressions.length > 0) {
      console.error(`\n${report.regressions.length} regression(s) detected — exiting with code 1`);
      process.exit(1);
    }
  }
}
