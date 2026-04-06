/**
 * Context loader for the semantic expert scheduler.
 *
 * Loads entities, glossary, audit patterns, and rejected keys from disk
 * and the internal DB for use in the scheduled analysis tick.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { createLogger } from "@atlas/api/lib/logger";
import type { ParsedEntity, GlossaryTerm, AuditPattern } from "./types";

const log = createLogger("semantic-expert-context");

/**
 * Resolve the semantic root directory.
 * Uses ATLAS_SEMANTIC_ROOT or falls back to `semantic/` in cwd.
 */
function getSemanticRoot(): string {
  return process.env.ATLAS_SEMANTIC_ROOT ?? path.resolve(process.cwd(), "semantic");
}

/**
 * Load all entity YAML files from disk.
 */
export async function loadEntitiesFromDisk(): Promise<ParsedEntity[]> {
  const entitiesDir = path.join(getSemanticRoot(), "entities");
  if (!fs.existsSync(entitiesDir)) return [];

  const entities: ParsedEntity[] = [];

  for (const file of fs.readdirSync(entitiesDir)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    try {
      const content = fs.readFileSync(path.join(entitiesDir, file), "utf-8");
      const parsed = yaml.load(content) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object") continue;

      entities.push({
        name: String(parsed.table ?? file.replace(/\.ya?ml$/, "")),
        table: String(parsed.table ?? file.replace(/\.ya?ml$/, "")),
        description: typeof parsed.description === "string" ? parsed.description : undefined,
        dimensions: Array.isArray(parsed.dimensions) ? parsed.dimensions as ParsedEntity["dimensions"] : [],
        measures: Array.isArray(parsed.measures) ? parsed.measures as ParsedEntity["measures"] : [],
        joins: Array.isArray(parsed.joins) ? parsed.joins as ParsedEntity["joins"] : [],
        query_patterns: Array.isArray(parsed.query_patterns) ? parsed.query_patterns as ParsedEntity["query_patterns"] : [],
        connection: typeof parsed.connection === "string" ? parsed.connection : undefined,
      });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), file },
        "Failed to parse entity YAML",
      );
    }
  }

  return entities;
}

/**
 * Load glossary terms from disk.
 */
export async function loadGlossaryFromDisk(): Promise<GlossaryTerm[]> {
  const glossaryPath = path.join(getSemanticRoot(), "glossary.yml");
  if (!fs.existsSync(glossaryPath)) return [];

  try {
    const content = fs.readFileSync(glossaryPath, "utf-8");
    const parsed = yaml.load(content) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return [];

    const terms = parsed.terms;
    if (Array.isArray(terms)) {
      return terms.filter(
        (t): t is GlossaryTerm => t != null && typeof t === "object" && "term" in t,
      );
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to parse glossary.yml",
    );
  }

  return [];
}

/**
 * Load audit patterns from the internal DB.
 * Returns empty array when no internal DB is available.
 */
export async function loadAuditPatterns(): Promise<AuditPattern[]> {
  try {
    const { hasInternalDB, internalQuery } = await import("@atlas/api/lib/db/internal");
    if (!hasInternalDB()) return [];

    const rows = await internalQuery<{
      sql: string;
      count: string;
      last_seen: string;
      tables_accessed: string | string[] | null;
    }>(
      `SELECT sql, COUNT(*) AS count, MAX(timestamp) AS last_seen, tables_accessed
       FROM audit_log
       WHERE success = true AND deleted_at IS NULL
       GROUP BY sql, tables_accessed
       HAVING COUNT(*) >= 2
       ORDER BY COUNT(*) DESC
       LIMIT 200`,
      [],
    );

    return rows.map((row) => {
      let tables: string[] = [];
      try {
        if (typeof row.tables_accessed === "string") {
          tables = JSON.parse(row.tables_accessed) as string[];
        } else if (Array.isArray(row.tables_accessed)) {
          tables = row.tables_accessed;
        }
      } catch {
        // intentionally ignored: malformed tables_accessed
      }
      return {
        sql: row.sql,
        count: parseInt(String(row.count), 10),
        tables,
        lastSeen: String(row.last_seen),
      };
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Failed to load audit patterns from internal DB",
    );
    return [];
  }
}

/**
 * Load rejected proposal keys from the internal DB.
 * Returns empty set when no internal DB is available.
 */
export async function loadRejectedKeys(): Promise<Set<string>> {
  const keys = new Set<string>();

  try {
    const { hasInternalDB, internalQuery } = await import("@atlas/api/lib/db/internal");
    if (!hasInternalDB()) return keys;

    const rows = await internalQuery<{
      source_entity: string;
      amendment_payload: string | Record<string, unknown> | null;
    }>(
      `SELECT source_entity, amendment_payload FROM learned_patterns
       WHERE type = 'semantic_amendment' AND status = 'rejected'
       AND reviewed_at >= now() - interval '30 days'`,
      [],
    );

    for (const row of rows) {
      try {
        const payload = typeof row.amendment_payload === "string"
          ? JSON.parse(row.amendment_payload)
          : row.amendment_payload;
        if (payload && payload.amendmentType) {
          keys.add(`${row.source_entity}:${payload.amendmentType}:${payload.amendment?.name ?? ""}`);
        }
      } catch {
        // intentionally ignored: malformed payload
      }
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Failed to load rejected keys from internal DB",
    );
  }

  return keys;
}
