/**
 * Pattern analysis for the learned patterns system.
 *
 * Inspired by packages/cli/lib/learn/analyze.ts, adapted for runtime use
 * with literal-placeholder normalization for stronger deduplication.
 * Provides SQL normalization, fingerprinting, and novelty detection
 * against YAML query_patterns in the semantic layer.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { Parser } from "node-sql-parser";
import { createLogger } from "@atlas/api/lib/logger";
import { getSemanticRoot as getDefaultSemanticRoot } from "@atlas/api/lib/semantic/files";

const log = createLogger("pattern-analyzer");

const parser = new Parser();

// ── SQL normalization ──────────────────────────────────────────────

/**
 * Normalize SQL for pattern deduplication.
 *
 * Strips comments, replaces string and numeric literals with placeholders,
 * removes LIMIT/OFFSET, collapses whitespace, and lowercases.
 */
export function normalizeSQL(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "")                     // strip line comments
    .replace(/\/\*[\s\S]*?\*\//g, "")             // strip block comments
    .replace(/'(?:[^']|'')*'/g, "'?'")            // normalize string literals
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")          // normalize numeric literals
    .replace(/\bLIMIT\s+\?\s*/gi, "")             // remove LIMIT (placeholder from step above)
    .replace(/\bOFFSET\s+\?\s*/gi, "")            // remove OFFSET
    .replace(/\s+/g, " ")                         // collapse whitespace
    .trim()
    .toLowerCase();
}

/**
 * Generate a 16-character SHA-256 hex prefix fingerprint for deduplication.
 */
export function fingerprintSQL(normalizedSql: string): string {
  return crypto.createHash("sha256").update(normalizedSql).digest("hex").slice(0, 16);
}

// ── Pattern info extraction ────────────────────────────────────────

export interface PatternInfo {
  tables: string[];
  hasJoins: boolean;
  hasAggregation: boolean;
  hasGroupBy: boolean;
  primaryTable: string;
  description: string;
}

/**
 * Extract structural information from a SQL query for pattern metadata.
 * Returns null if parsing fails.
 */
export function extractPatternInfo(sql: string, dialect: string = "PostgresQL"): PatternInfo | null {
  try {
    const ast = parser.astify(sql, { database: dialect });
    const stmt = Array.isArray(ast) ? ast[0] : ast;
    if (!stmt || stmt.type !== "select") return null;

    let tables: string[];
    try {
      const tableRefs = parser.tableList(sql, { database: dialect });
      tables = [...new Set(
        tableRefs
          .map((ref) => {
            const parts = ref.split("::");
            return parts.pop()?.toLowerCase() ?? "";
          })
          .filter(Boolean),
      )];
    } catch (tableListErr) {
      log.debug(
        { err: tableListErr instanceof Error ? tableListErr.message : String(tableListErr) },
        "tableList extraction failed — falling back to empty tables",
      );
      tables = [];
    }

    const stmtObj = stmt as unknown as Record<string, unknown>;
    const from = stmtObj.from as Array<Record<string, unknown>> | undefined;
    const hasJoins = Array.isArray(from) && from.some((item) => !!item.join);
    const hasGroupBy = !!stmtObj.groupby;
    // AST JSON serializes function names as property values (e.g. "name":"COUNT"),
    // not as SQL text. Match quoted function names instead of SQL-style `count(`.
    const astJson = JSON.stringify(stmtObj).toLowerCase();
    const hasAggregation = /"(count|sum|avg|min|max)"/.test(astJson);

    const primaryTable = tables[0] ?? "unknown";

    const descParts: string[] = [];
    if (hasAggregation && hasGroupBy) {
      descParts.push("Aggregation");
    } else if (hasAggregation) {
      descParts.push("Summary");
    }
    if (hasJoins) {
      descParts.push("with joins");
    }
    if (tables.length > 0) {
      descParts.push(`on ${primaryTable}`);
    }
    const description = descParts.length > 0 ? descParts.join(" ") : "Query pattern";

    return { tables, hasJoins, hasAggregation, hasGroupBy, primaryTable, description };
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err), sql: sql.slice(0, 200) },
      "Failed to extract pattern info — skipping",
    );
    return null;
  }
}

// ── YAML query_patterns loading ────────────────────────────────────

/**
 * Load all query_patterns SQL from entity YAMLs, normalized for comparison.
 * Returns a Set of normalized SQL strings.
 */
export function loadYamlQueryPatterns(semanticRoot?: string): Set<string> {
  const root = semanticRoot ?? getDefaultSemanticRoot();
  const patterns = new Set<string>();

  loadPatternsFromDir(path.join(root, "entities"), patterns);

  if (fs.existsSync(root)) {
    const reserved = new Set(["entities", "metrics", ".orgs"]);
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || reserved.has(entry.name)) continue;
        const subEntities = path.join(root, entry.name, "entities");
        if (fs.existsSync(subEntities)) {
          loadPatternsFromDir(subEntities, patterns);
        }
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to scan semantic root for pattern loading",
      );
    }
  }

  return patterns;
}

function loadPatternsFromDir(dir: string, out: Set<string>): void {
  if (!fs.existsSync(dir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
  } catch (err) {
    log.warn(
      { dir, err: err instanceof Error ? err.message : String(err) },
      "Failed to read entities directory for pattern loading",
    );
    return;
  }

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), "utf-8");
      const raw = yaml.load(content) as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object") continue;

      const queryPatterns = raw.query_patterns;
      if (!Array.isArray(queryPatterns)) continue;

      for (const pattern of queryPatterns) {
        if (pattern && typeof pattern === "object" && typeof (pattern as Record<string, unknown>).sql === "string") {
          out.add(normalizeSQL((pattern as Record<string, unknown>).sql as string));
        }
      }
    } catch (err) {
      log.warn(
        { file, dir, err: err instanceof Error ? err.message : String(err) },
        "Skipping entity file during pattern loading",
      );
    }
  }
}

// ── YAML pattern cache ─────────────────────────────────────────────

let _yamlPatternCache: Set<string> | null = null;

/** Get YAML patterns. When semanticRoot is provided, reads directly from disk
 * (bypasses cache). Otherwise, lazily loads from the default semantic directory
 * and caches for subsequent calls. Empty results are not cached so subsequent
 * calls retry the load. */
export function getYamlPatterns(semanticRoot?: string): Set<string> {
  if (semanticRoot) return loadYamlQueryPatterns(semanticRoot);
  if (!_yamlPatternCache) {
    const loaded = loadYamlQueryPatterns();
    if (loaded.size > 0) {
      _yamlPatternCache = loaded;
    }
    return loaded;
  }
  return _yamlPatternCache;
}

/** Clear the YAML pattern cache. For testing. */
export function _resetYamlPatternCache(): void {
  _yamlPatternCache = null;
}

/** Pre-populate the YAML pattern cache. For testing. */
export function _setYamlPatternCache(patterns: Set<string>): void {
  _yamlPatternCache = patterns;
}
