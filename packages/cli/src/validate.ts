/**
 * Atlas Validate — unified validation for config, semantic layer, and connectivity.
 *
 * Combines offline checks (YAML syntax, required fields, cross-references) with
 * connectivity checks (datasource, provider, internal DB, sandbox) from doctor.
 *
 * Use --offline to skip connectivity checks and run purely local validation.
 *
 * Exit codes: 0 = all pass, 1 = any fail, 2 = warnings only.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import * as p from "@clack/prompts";
import pc from "picocolors";

// Re-use check types from doctor
import type { CheckStatus, CheckResult } from "./doctor";
import {
  NON_CRITICAL_CHECKS,
  checkDatasourceUrl,
  checkDatabaseConnectivity,
  checkProvider,
  checkSandbox,
  checkInternalDb,
} from "./doctor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidateResult {
  status: CheckStatus;
  label: string;
  detail: string;
  fix?: string;
}

interface ValidateOptions {
  offline?: boolean;
  /** "strict" (default) exits 1 on any failure. "doctor" excludes NON_CRITICAL_CHECKS from exit 1. */
  mode?: "strict" | "doctor";
}

export interface ValidateSection {
  category: string;
  results: ValidateResult[];
}

/** Convert a doctor CheckResult to a ValidateResult. */
function fromCheckResult(check: CheckResult): ValidateResult {
  return {
    status: check.status,
    label: check.name,
    detail: check.detail,
    fix: check.fix,
  };
}

interface EntityInfo {
  file: string;
  table: string;
  dimensions: Record<string, unknown>;
  joins?: Record<string, unknown> | unknown[];
  connection?: string;
}

interface MetricInfo {
  file: string;
  table?: string;
  tables?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSemanticDir(): string {
  return path.resolve("semantic");
}

/**
 * Find the 1-based line number for a key in YAML text.
 * Returns undefined if not found.
 */
function findLineForKey(content: string, key: string): number | undefined {
  const lines = content.split("\n");
  // Match top-level key or nested key (indented)
  const keyPattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (keyPattern.test(lines[i])) return i + 1;
  }
  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Collect all *.yml files from a directory. Returns empty array if dir doesn't exist.
 * Returns an error string if the directory exists but cannot be read.
 */
function listYmlFiles(dir: string): { files: string[]; error?: string } {
  if (!fs.existsSync(dir)) return { files: [] };
  try {
    return { files: fs.readdirSync(dir).filter((f) => f.endsWith(".yml")) };
  } catch (err) {
    return {
      files: [],
      error: `Cannot read directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Scan the semantic root for per-source subdirectories.
 * Returns array of { source, entitiesDir, metricsDir }.
 */
function discoverSources(semanticRoot: string): Array<{ source: string; entitiesDir: string; metricsDir: string }> {
  const reserved = new Set(["entities", "metrics"]);
  const sources: Array<{ source: string; entitiesDir: string; metricsDir: string }> = [];

  if (!fs.existsSync(semanticRoot)) return sources;

  try {
    const entries = fs.readdirSync(semanticRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || reserved.has(entry.name) || entry.name.startsWith(".")) continue;
      sources.push({
        source: entry.name,
        entitiesDir: path.join(semanticRoot, entry.name, "entities"),
        metricsDir: path.join(semanticRoot, entry.name, "metrics"),
      });
    }
  } catch {
    // Ignore scan errors
  }

  return sources;
}

// ---------------------------------------------------------------------------
// Check: Config file
// ---------------------------------------------------------------------------

export function checkConfig(): ValidateResult {
  const configPath = path.resolve("atlas.config.ts");
  if (!fs.existsSync(configPath)) {
    return {
      status: "pass",
      label: "atlas.config.ts",
      detail: "Not present (using env vars)",
    };
  }

  // Static check: verify the file exists, is readable, and has expected structure.
  // Full Zod validation happens at runtime via loadConfig() → validateAndResolve()
  // which uses formatZodErrors() for human-readable error messages.
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    if (content.trim().length === 0) {
      return {
        status: "fail",
        label: "atlas.config.ts",
        detail: "File is empty",
        fix: "Add a valid config using defineConfig()",
      };
    }

    // Check for the defineConfig pattern
    const hasDefineConfig = /defineConfig\s*\(/.test(content);
    const hasExport = /export\s+default/.test(content);

    if (!hasExport) {
      return {
        status: "warn",
        label: "atlas.config.ts",
        detail: "No default export found",
        fix: "Config file should have: export default defineConfig({ ... })",
      };
    }

    return {
      status: "pass",
      label: "atlas.config.ts",
      detail: hasDefineConfig ? "Valid (defineConfig)" : "Valid",
    };
  } catch (err) {
    return {
      status: "fail",
      label: "atlas.config.ts",
      detail: `Cannot read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Check: Entity YAMLs
// ---------------------------------------------------------------------------

export function checkEntities(semanticRoot: string = getSemanticDir()): {
  results: ValidateResult[];
  entities: EntityInfo[];
} {
  const results: ValidateResult[] = [];
  const entities: EntityInfo[] = [];

  // Collect all entity directories: default + per-source
  const dirs: Array<{ dir: string; prefix: string }> = [
    { dir: path.join(semanticRoot, "entities"), prefix: "" },
  ];
  for (const src of discoverSources(semanticRoot)) {
    dirs.push({ dir: src.entitiesDir, prefix: `${src.source}/` });
  }

  let totalFiles = 0;
  let errorCount = 0;

  for (const { dir, prefix } of dirs) {
    const { files, error: dirError } = listYmlFiles(dir);
    if (dirError) {
      results.push({
        status: "fail",
        label: `${prefix}entities/`,
        detail: dirError,
      });
      errorCount++;
    }
    totalFiles += files.length;

    for (const file of files) {
      const filePath = path.join(dir, file);
      const displayName = `${prefix}entities/${file}`;
      let content: string;

      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch (err) {
        results.push({
          status: "fail",
          label: displayName,
          detail: `Cannot read: ${err instanceof Error ? err.message : String(err)}`,
        });
        errorCount++;
        continue;
      }

      // Parse YAML
      let doc: unknown;
      try {
        doc = yaml.load(content);
      } catch (err) {
        const yamlErr = err as yaml.YAMLException;
        const line = yamlErr.mark?.line != null ? yamlErr.mark.line + 1 : undefined;
        results.push({
          status: "fail",
          label: line ? `${displayName}:${line}` : displayName,
          detail: `Invalid YAML: ${yamlErr.reason || yamlErr.message}`,
        });
        errorCount++;
        continue;
      }

      if (!doc || typeof doc !== "object") {
        results.push({
          status: "fail",
          label: displayName,
          detail: "YAML parsed but is not an object",
        });
        errorCount++;
        continue;
      }

      const obj = doc as Record<string, unknown>;

      // Required: table (string)
      if (!obj.table || typeof obj.table !== "string") {
        const line = findLineForKey(content, "table");
        results.push({
          status: "fail",
          label: line ? `${displayName}:${line}` : displayName,
          detail: 'Missing or invalid required field "table" (must be a string)',
        });
        errorCount++;
        continue;
      }

      // Required: dimensions (object)
      if (!obj.dimensions || typeof obj.dimensions !== "object") {
        const line = findLineForKey(content, "dimensions");
        results.push({
          status: "fail",
          label: line ? `${displayName}:${line}` : displayName,
          detail: `Missing required field "dimensions" for table "${obj.table}"`,
        });
        errorCount++;
        continue;
      }

      const dims = obj.dimensions as Record<string, unknown>;

      // Validate each dimension
      for (const [dimName, dimVal] of Object.entries(dims)) {
        if (!dimVal || typeof dimVal !== "object") {
          const line = findLineForKey(content, dimName);
          results.push({
            status: "warn",
            label: line ? `${displayName}:${line}` : displayName,
            detail: `Dimension "${dimName}" is not an object`,
          });
          continue;
        }
        const dim = dimVal as Record<string, unknown>;

        if (!dim.type || typeof dim.type !== "string") {
          const line = findLineForKey(content, dimName);
          results.push({
            status: "warn",
            label: line ? `${displayName}:${line}` : displayName,
            detail: `Dimension "${dimName}" missing "type"`,
          });
        }

        if (!dim.description) {
          const line = findLineForKey(content, dimName);
          results.push({
            status: "warn",
            label: line ? `${displayName}:${line}` : displayName,
            detail: `Missing description for dimension "${dimName}"`,
          });
        }

        if (dim.sample_values !== undefined) {
          if (Array.isArray(dim.sample_values) && dim.sample_values.length === 0) {
            const line = findLineForKey(content, dimName);
            results.push({
              status: "warn",
              label: line ? `${displayName}:${line}` : displayName,
              detail: `Empty sample_values for dimension "${dimName}"`,
            });
          }
        }
      }

      entities.push({
        file: displayName,
        table: obj.table,
        dimensions: dims,
        joins: typeof obj.joins === "object" && obj.joins ? (obj.joins as Record<string, unknown>) : undefined,
        connection: typeof obj.connection === "string" ? obj.connection : undefined,
      });
    }
  }

  if (totalFiles === 0) {
    results.unshift({
      status: "fail",
      label: "semantic/entities/",
      detail: "No entity files found",
      fix: "Run 'bun run atlas -- init' to generate entity YAMLs",
    });
  } else {
    const entityCount = entities.length;
    const warnCount = results.filter((r) => r.status === "warn").length;
    const summaryParts = [`${entityCount} entities parsed`];
    if (errorCount > 0) summaryParts.push(`${errorCount} errors`);
    if (warnCount > 0) summaryParts.push(`${warnCount} warnings`);
    results.unshift({
      status: errorCount > 0 ? "fail" : "pass",
      label: "semantic/entities/",
      detail: summaryParts.join(", "),
    });
  }

  return { results, entities };
}

// ---------------------------------------------------------------------------
// Check: Glossary and Catalog
// ---------------------------------------------------------------------------

export function checkGlossary(semanticRoot: string = getSemanticDir()): ValidateResult {
  const glossaryPath = path.join(semanticRoot, "glossary.yml");
  if (!fs.existsSync(glossaryPath)) {
    return {
      status: "pass",
      label: "semantic/glossary.yml",
      detail: "Not present (optional)",
    };
  }

  let content: string;
  try {
    content = fs.readFileSync(glossaryPath, "utf-8");
  } catch (err) {
    return {
      status: "fail",
      label: "semantic/glossary.yml",
      detail: `Cannot read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const doc = yaml.load(content);
    if (!doc || typeof doc !== "object") {
      return {
        status: "fail",
        label: "semantic/glossary.yml",
        detail: "Parsed but is not an object",
      };
    }
    const termCount = Array.isArray(doc)
      ? doc.length
      : Object.keys(doc).length;
    return {
      status: "pass",
      label: "semantic/glossary.yml",
      detail: `Valid (${termCount} terms)`,
    };
  } catch (err) {
    const yamlErr = err as yaml.YAMLException;
    const line = yamlErr.mark?.line != null ? yamlErr.mark.line + 1 : undefined;
    return {
      status: "fail",
      label: line ? `semantic/glossary.yml:${line}` : "semantic/glossary.yml",
      detail: `Invalid YAML: ${yamlErr.reason || yamlErr.message}`,
    };
  }
}

export function checkCatalog(semanticRoot: string = getSemanticDir()): ValidateResult {
  const catalogPath = path.join(semanticRoot, "catalog.yml");
  if (!fs.existsSync(catalogPath)) {
    return {
      status: "pass",
      label: "semantic/catalog.yml",
      detail: "Not present (optional)",
    };
  }

  let content: string;
  try {
    content = fs.readFileSync(catalogPath, "utf-8");
  } catch (err) {
    return {
      status: "fail",
      label: "semantic/catalog.yml",
      detail: `Cannot read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const doc = yaml.load(content);
    if (!doc || typeof doc !== "object") {
      return {
        status: "fail",
        label: "semantic/catalog.yml",
        detail: "Parsed but is not an object",
      };
    }
    return {
      status: "pass",
      label: "semantic/catalog.yml",
      detail: "Valid",
    };
  } catch (err) {
    const yamlErr = err as yaml.YAMLException;
    const line = yamlErr.mark?.line != null ? yamlErr.mark.line + 1 : undefined;
    return {
      status: "fail",
      label: line ? `semantic/catalog.yml:${line}` : "semantic/catalog.yml",
      detail: `Invalid YAML: ${yamlErr.reason || yamlErr.message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Check: Metrics
// ---------------------------------------------------------------------------

export function checkMetrics(semanticRoot: string = getSemanticDir()): {
  results: ValidateResult[];
  metrics: MetricInfo[];
} {
  const results: ValidateResult[] = [];
  const metrics: MetricInfo[] = [];

  const dirs: Array<{ dir: string; prefix: string }> = [
    { dir: path.join(semanticRoot, "metrics"), prefix: "" },
  ];
  for (const src of discoverSources(semanticRoot)) {
    dirs.push({ dir: src.metricsDir, prefix: `${src.source}/` });
  }

  let totalFiles = 0;
  let errorCount = 0;

  for (const { dir, prefix } of dirs) {
    const { files, error: dirError } = listYmlFiles(dir);
    if (dirError) {
      results.push({
        status: "fail",
        label: `${prefix}metrics/`,
        detail: dirError,
      });
      errorCount++;
    }
    totalFiles += files.length;

    for (const file of files) {
      const filePath = path.join(dir, file);
      const displayName = `${prefix}metrics/${file}`;

      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch (err) {
        results.push({
          status: "fail",
          label: displayName,
          detail: `Cannot read: ${err instanceof Error ? err.message : String(err)}`,
        });
        errorCount++;
        continue;
      }

      let doc: unknown;
      try {
        doc = yaml.load(content);
      } catch (err) {
        const yamlErr = err as yaml.YAMLException;
        const line = yamlErr.mark?.line != null ? yamlErr.mark.line + 1 : undefined;
        results.push({
          status: "fail",
          label: line ? `${displayName}:${line}` : displayName,
          detail: `Invalid YAML: ${yamlErr.reason || yamlErr.message}`,
        });
        errorCount++;
        continue;
      }

      if (!doc || typeof doc !== "object") {
        results.push({
          status: "fail",
          label: displayName,
          detail: "YAML parsed but is not an object",
        });
        errorCount++;
        continue;
      }

      const obj = doc as Record<string, unknown>;
      const metricInfo: MetricInfo = { file: displayName };

      // Extract table references from metric
      if (typeof obj.table === "string") {
        metricInfo.table = obj.table;
      }
      if (Array.isArray(obj.tables)) {
        metricInfo.tables = obj.tables.filter((t): t is string => typeof t === "string");
      }
      // Also check inside metrics array entries
      if (Array.isArray(obj.metrics)) {
        const tablesFromEntries: string[] = [];
        for (const m of obj.metrics) {
          if (m && typeof m === "object") {
            const entry = m as Record<string, unknown>;
            if (typeof entry.table === "string") tablesFromEntries.push(entry.table);
          }
        }
        if (tablesFromEntries.length > 0) {
          metricInfo.tables = [...(metricInfo.tables ?? []), ...tablesFromEntries];
        }
      }

      metrics.push(metricInfo);
    }
  }

  if (totalFiles > 0) {
    const parsed = metrics.length;
    results.unshift({
      status: errorCount > 0 ? "fail" : "pass",
      label: "semantic/metrics/",
      detail: errorCount > 0 ? `${parsed} parsed, ${errorCount} errors` : `${parsed} metrics parsed`,
    });
  }

  return { results, metrics };
}

// ---------------------------------------------------------------------------
// Check: Cross-references
// ---------------------------------------------------------------------------

export function checkCrossReferences(
  entities: EntityInfo[],
  metrics: MetricInfo[],
): ValidateResult[] {
  const results: ValidateResult[] = [];

  // Build a set of known table names (lowercase)
  const knownTables = new Set<string>();
  for (const entity of entities) {
    knownTables.add(entity.table.toLowerCase());
    // Also add unqualified name if schema-qualified
    const parts = entity.table.split(".");
    if (parts.length > 1) {
      knownTables.add(parts[parts.length - 1].toLowerCase());
    }
  }

  // Check join targets — only add join TARGETS and metric refs, not entities themselves
  const referencedTables = new Set<string>();
  for (const entity of entities) {
    if (!entity.joins) continue;

    // Joins can be an array (profiler-generated) or an object (hand-written)
    const joinEntries: Array<[string, unknown]> = Array.isArray(entity.joins)
      ? entity.joins.map((v: unknown, i: number) => [String(i), v] as [string, unknown])
      : Object.entries(entity.joins);

    for (const [joinKey, joinVal] of joinEntries) {
      let targetTable: string | undefined;

      if (joinVal && typeof joinVal === "object") {
        const j = joinVal as Record<string, unknown>;
        if (typeof j.target_table === "string") targetTable = j.target_table;
        else if (typeof j.target_entity === "string") {
          // target_entity is PascalCase — convert to snake_case table name
          targetTable = j.target_entity.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
        } else if (typeof j.to === "string") targetTable = j.to;
      }

      // For object-style joins, the key itself is often the target table name
      const target = targetTable ?? (Array.isArray(entity.joins) ? undefined : joinKey);
      if (!target) continue; // Array join with no resolvable target — skip

      const targetLower = target.toLowerCase();
      referencedTables.add(targetLower);

      // Also add unqualified variant
      const targetParts = target.split(".");
      if (targetParts.length > 1) {
        referencedTables.add(targetParts[targetParts.length - 1].toLowerCase());
      }

      if (!knownTables.has(targetLower)) {
        // Check unqualified
        const unqualified = targetParts[targetParts.length - 1].toLowerCase();
        if (!knownTables.has(unqualified)) {
          results.push({
            status: "fail",
            label: entity.file,
            detail: `Join target "${target}" not found in entity files`,
            fix: `Create semantic/entities/${target}.yml or fix the join reference`,
          });
        }
      }
    }
  }

  // Check metric table references
  for (const metric of metrics) {
    const tables: string[] = [];
    if (metric.table) tables.push(metric.table);
    if (metric.tables) tables.push(...metric.tables);

    for (const table of tables) {
      const tableLower = table.toLowerCase();
      referencedTables.add(tableLower);
      if (!knownTables.has(tableLower)) {
        const parts = table.split(".");
        const unqualified = parts[parts.length - 1].toLowerCase();
        if (!knownTables.has(unqualified)) {
          results.push({
            status: "fail",
            label: metric.file,
            detail: `Metric references table "${table}" not found in entity files`,
            fix: `Create an entity file for "${table}" or fix the metric reference`,
          });
        }
      }
    }
  }

  // Warn on unused entities (defined but not referenced by any join or metric)
  for (const entity of entities) {
    const tableLower = entity.table.toLowerCase();
    const parts = entity.table.split(".");
    const unqualified = parts[parts.length - 1].toLowerCase();

    const isReferenced = referencedTables.has(tableLower) || referencedTables.has(unqualified);
    if (!isReferenced) {
      results.push({
        status: "warn",
        label: entity.file,
        detail: `Entity "${entity.table}" is not referenced by any join or metric`,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function statusIcon(status: CheckStatus): string {
  switch (status) {
    case "pass":
      return pc.green("✓");
    case "fail":
      return pc.red("✗");
    case "warn":
      return pc.yellow("⚠");
  }
}

export function renderValidateResults(results: ValidateResult[]): void {
  p.intro(pc.bold("Atlas Validate"));

  if (results.length === 0) {
    console.log("  No checks were run.\n");
    return;
  }

  const maxLabelLen = Math.max(...results.map((r) => r.label.length));

  for (const result of results) {
    const icon = statusIcon(result.status);
    const label = result.label.padEnd(maxLabelLen);
    console.log(`  ${icon} ${label}  ${result.detail}`);
    if (result.fix) {
      console.log(`    ${pc.dim("→")} ${pc.dim(result.fix)}`);
    }
  }

  console.log();
}

export function renderValidateSections(sections: ValidateSection[]): void {
  p.intro(pc.bold("Atlas Validate"));

  const nonEmpty = sections.filter((s) => s.results.length > 0);
  if (nonEmpty.length === 0) {
    console.log("  No checks were run.\n");
    return;
  }

  for (const section of nonEmpty) {
    console.log(`  ${pc.bold(section.category)}`);
    const maxLabelLen = Math.max(...section.results.map((r) => r.label.length));

    for (const result of section.results) {
      const icon = statusIcon(result.status);
      const label = result.label.padEnd(maxLabelLen);
      console.log(`    ${icon} ${label}  ${result.detail}`);
      if (result.fix) {
        console.log(`      ${pc.dim("→")} ${pc.dim(result.fix)}`);
      }
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** Wrap a check so unexpected throws become fail results instead of crashing. */
function safeRunSingle(
  fn: () => ValidateResult,
  fallbackLabel: string,
): ValidateResult {
  try {
    return fn();
  } catch (err) {
    return {
      status: "fail",
      label: fallbackLabel,
      detail: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      fix: "This check crashed unexpectedly — please report this as a bug",
    };
  }
}

/** Wrap an async check so unexpected throws become fail results. */
async function safeRunAsync(
  fn: () => ValidateResult | Promise<ValidateResult>,
  fallbackLabel: string,
): Promise<ValidateResult> {
  try {
    return await fn();
  } catch (err) {
    return {
      status: "fail",
      label: fallbackLabel,
      detail: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      fix: "This check crashed unexpectedly — please report this as a bug",
    };
  }
}

function safeRunMulti<T>(
  fn: () => T,
  fallbackLabel: string,
  fallback: (err: Error) => T,
): T {
  try {
    return fn();
  } catch (err) {
    return fallback(err instanceof Error ? err : new Error(String(err)));
  }
}

/** Exit codes: 0 = all pass, 1 = any fail, 2 = warnings only.
 *  In doctor mode, NON_CRITICAL_CHECKS failures do not contribute to exit 1. */
export function computeExitCode(allResults: ValidateResult[], opts?: ValidateOptions): number {
  const isDoctorMode = opts?.mode === "doctor";
  const hasFail = allResults.some(
    (r) => r.status === "fail" && !(isDoctorMode && NON_CRITICAL_CHECKS.has(r.label)),
  );
  const hasWarn = allResults.some((r) => r.status === "warn");
  if (hasFail) return 1;
  if (hasWarn) return 2;
  return 0;
}

export async function runValidate(opts?: ValidateOptions): Promise<number> {
  const sections: ValidateSection[] = [];

  // --- Config section ---
  const configResults: ValidateResult[] = [];
  configResults.push(safeRunSingle(() => checkConfig(), "atlas.config.ts"));
  sections.push({ category: "Config", results: configResults });

  // --- Semantic Layer section ---
  const semanticResults: ValidateResult[] = [];

  const { results: entityResults, entities } = safeRunMulti(
    () => checkEntities(),
    "semantic/entities/",
    (err) => ({
      results: [{ status: "fail" as const, label: "semantic/entities/", detail: `Unexpected error: ${err.message}`, fix: "Please report this as a bug" }],
      entities: [],
    }),
  );
  semanticResults.push(...entityResults);

  semanticResults.push(safeRunSingle(() => checkGlossary(), "semantic/glossary.yml"));
  semanticResults.push(safeRunSingle(() => checkCatalog(), "semantic/catalog.yml"));

  const { results: metricResults, metrics } = safeRunMulti(
    () => checkMetrics(),
    "semantic/metrics/",
    (err) => ({
      results: [{ status: "fail" as const, label: "semantic/metrics/", detail: `Unexpected error: ${err.message}`, fix: "Please report this as a bug" }],
      metrics: [],
    }),
  );
  semanticResults.push(...metricResults);

  if (entities.length > 0) {
    const crossRefResults = safeRunMulti(
      () => checkCrossReferences(entities, metrics),
      "cross-references",
      (err) => [{ status: "fail" as const, label: "cross-references", detail: `Unexpected error: ${err.message}`, fix: "Please report this as a bug" }],
    );
    semanticResults.push(...crossRefResults);
  }

  sections.push({ category: "Semantic Layer", results: semanticResults });

  // --- Connectivity section (skipped in offline mode) ---
  if (!opts?.offline) {
    const [dsUrl, dbConn, provider, sandbox, internalDb] = await Promise.all([
      safeRunAsync(() => fromCheckResult(checkDatasourceUrl()), "ATLAS_DATASOURCE_URL"),
      safeRunAsync(async () => fromCheckResult(await checkDatabaseConnectivity()), "Database connectivity"),
      safeRunAsync(() => fromCheckResult(checkProvider()), "LLM provider"),
      safeRunAsync(() => fromCheckResult(checkSandbox()), "Sandbox"),
      safeRunAsync(async () => fromCheckResult(await checkInternalDb()), "Internal DB"),
    ]);

    sections.push({
      category: "Connectivity",
      results: [dsUrl, dbConn, provider, sandbox, internalDb],
    });
  }

  renderValidateSections(sections);

  const allResults = sections.flatMap((s) => s.results);
  return computeExitCode(allResults, opts);
}
