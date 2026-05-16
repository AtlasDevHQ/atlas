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

/** Outcome of {@link loadEntitiesFromDB} / {@link loadEntitiesForOrg} — a
 * discriminator so callers can tell "no entities" from "every entity row failed
 * to parse" (the latter signals data corruption and should drive a different UI
 * signal than "0% coverage"). */
export interface LoadEntitiesFromDBResult {
  entities: ParsedEntity[];
  totalRows: number;
  parseFailures: number;
}

/**
 * Load entities for an org from the internal DB.
 *
 * Preferred whenever the caller has both an org context and an internal DB
 * (SaaS, or self-hosted with `DATABASE_URL` set). The disk loader returns the
 * bundled YAML present on every API container, which would otherwise make
 * empty-DB workspaces look fully populated.
 *
 * Returns a discriminated result so callers can distinguish:
 *   - `totalRows === 0` — org has no entity rows (legitimate empty state)
 *   - `parseFailures === totalRows && totalRows > 0` — every row failed YAML
 *     parse; the workspace is corrupt, not empty
 *   - `parseFailures > 0` — partial corruption; surface warning
 *
 * Without this discriminator the Health widget shows "0% coverage" for both
 * "no entities" and "all entities corrupt" — two states that need different
 * operator actions.
 */
export async function loadEntitiesFromDB(
  orgId: string,
  mode?: "published" | "developer",
): Promise<LoadEntitiesFromDBResult> {
  const { hasInternalDB } = await import("@atlas/api/lib/db/internal");
  if (!hasInternalDB()) return { entities: [], totalRows: 0, parseFailures: 0 };

  const { listEntityRows, listEntitiesWithOverlay } = await import("@atlas/api/lib/semantic/entities");
  const rows = mode === "developer"
    ? await listEntitiesWithOverlay(orgId, "entity")
    : await listEntityRows(orgId, "entity", "published");

  const entities: ParsedEntity[] = [];
  let parseFailures = 0;
  for (const row of rows) {
    try {
      const parsed = yaml.load(row.yaml_content) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object") {
        parseFailures++;
        continue;
      }
      entities.push({
        name: String(parsed.table ?? row.name),
        table: String(parsed.table ?? row.name),
        description: typeof parsed.description === "string" ? parsed.description : undefined,
        dimensions: Array.isArray(parsed.dimensions) ? parsed.dimensions as ParsedEntity["dimensions"] : [],
        measures: Array.isArray(parsed.measures) ? parsed.measures as ParsedEntity["measures"] : [],
        joins: Array.isArray(parsed.joins) ? parsed.joins as ParsedEntity["joins"] : [],
        query_patterns: Array.isArray(parsed.query_patterns) ? parsed.query_patterns as ParsedEntity["query_patterns"] : [],
        connection: typeof parsed.connection === "string" ? parsed.connection : (row.connection_group_id ?? undefined),
      });
    } catch (err) {
      parseFailures++;
      log.warn(
        { err: err instanceof Error ? err.message : String(err), entity: row.name, orgId },
        "Failed to parse entity YAML from DB",
      );
    }
  }

  if (parseFailures > 0 && parseFailures === rows.length) {
    log.error(
      { orgId, totalRows: rows.length, parseFailures },
      "All org entity rows failed YAML parse — semantic layer is corrupt",
    );
  }

  return { entities, totalRows: rows.length, parseFailures };
}

/**
 * Load entities for an org, merging DB rows with the per-org disk mirror
 * under the same `(name, connection_group_id)` dedup rule that
 * `listAdminEntities` uses (#2503).
 *
 * The Health card's entity count must agree with the Overview tile, the chat
 * empty state, and the `/admin/semantic` file tree — those three all read
 * through `listAdminEntities`. Reading only DB rows (`loadEntitiesFromDB`)
 * left the Health card displaying a smaller number when the org's DB rows
 * carry a non-null `connection_group_id` (post-1.4.4 backfill) and the disk-
 * mirror entries — written with no group scope — no longer share the dedup
 * key. Result was visible drift: file tree showed 46 rows, Health caption
 * read "23 entities."
 *
 * This helper mirrors `listAdminEntities`'s merge logic but returns the full
 * `ParsedEntity[]` `computeSemanticHealth` needs. DB rows are parsed once
 * here (no extra YAML pass); disk entries are read from the org-scoped
 * `.orgs/<orgId>/entities/` directory so a SaaS pod never falls through to
 * the image's bundled fixture.
 *
 * Dedup is `(name, connection_group_id)` — same key `mergeAdminEntities`
 * uses, so the count matches by construction. Multi-group orgs surface the
 * same name once per group; disk entries (group = `null`) survive only when
 * no DB row already covers `(name, null)`.
 *
 * `parseFailures` counts only DB rows that failed YAML parsing — disk parse
 * failures bubble through the file-level `try/catch` and are surfaced via
 * the logger, matching `loadEntitiesFromDisk`'s existing contract.
 */
export async function loadEntitiesForOrg(
  orgId: string,
  mode: "published" | "developer" = "published",
): Promise<LoadEntitiesFromDBResult> {
  const { hasInternalDB } = await import("@atlas/api/lib/db/internal");
  if (!hasInternalDB()) return { entities: [], totalRows: 0, parseFailures: 0 };

  const { listEntityRows, listEntitiesWithOverlay } = await import("@atlas/api/lib/semantic/entities");
  const { getSemanticRoot: getOrgSemanticRoot } = await import("@atlas/api/lib/semantic/sync");

  const rows = mode === "developer"
    ? await listEntitiesWithOverlay(orgId, "entity")
    : await listEntityRows(orgId, "entity", "published");

  const entities: ParsedEntity[] = [];
  // Dedup key matches `mergeAdminEntities` (`packages/api/src/lib/semantic/
  // admin-source.ts`): `${name}\0${groupId ?? ""}`. `\0` is illegal in both
  // YAML names and connection-group ids, so it can't collide with a real key.
  const seen = new Set<string>();
  let parseFailures = 0;

  for (const row of rows) {
    try {
      const parsed = yaml.load(row.yaml_content) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object") {
        parseFailures++;
        continue;
      }
      const nameField = typeof parsed.name === "string" && parsed.name
        ? parsed.name
        : String(parsed.table ?? row.name);
      const groupId = row.connection_group_id ?? null;
      const key = `${nameField}\0${groupId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push({
        name: nameField,
        table: String(parsed.table ?? row.name),
        description: typeof parsed.description === "string" ? parsed.description : undefined,
        dimensions: Array.isArray(parsed.dimensions) ? parsed.dimensions as ParsedEntity["dimensions"] : [],
        measures: Array.isArray(parsed.measures) ? parsed.measures as ParsedEntity["measures"] : [],
        joins: Array.isArray(parsed.joins) ? parsed.joins as ParsedEntity["joins"] : [],
        query_patterns: Array.isArray(parsed.query_patterns) ? parsed.query_patterns as ParsedEntity["query_patterns"] : [],
        connection: typeof parsed.connection === "string" ? parsed.connection : (groupId ?? undefined),
      });
    } catch (err) {
      parseFailures++;
      log.warn(
        { err: err instanceof Error ? err.message : String(err), entity: row.name, orgId },
        "Failed to parse entity YAML from DB",
      );
    }
  }

  // Disk mirror — org-scoped under `.orgs/<orgId>/entities/`. `discoverEntities`
  // walks the per-source subdirectories too, but the dual-write sync writes flat
  // under `entities/` regardless of group, so disk entries always key on the
  // null group. Matches `diskToAdminSummary` in `admin-source.ts`.
  const diskRoot = getOrgSemanticRoot(orgId);
  const entitiesDir = path.join(diskRoot, "entities");
  if (fs.existsSync(entitiesDir)) {
    for (const file of fs.readdirSync(entitiesDir)) {
      if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
      try {
        const content = fs.readFileSync(path.join(entitiesDir, file), "utf-8");
        const parsed = yaml.load(content) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== "object") continue;

        const baseName = file.replace(/\.ya?ml$/, "");
        const nameField = typeof parsed.name === "string" && parsed.name
          ? parsed.name
          : String(parsed.table ?? baseName);
        const key = `${nameField}\0`;
        if (seen.has(key)) continue;
        seen.add(key);
        entities.push({
          name: nameField,
          table: String(parsed.table ?? baseName),
          description: typeof parsed.description === "string" ? parsed.description : undefined,
          dimensions: Array.isArray(parsed.dimensions) ? parsed.dimensions as ParsedEntity["dimensions"] : [],
          measures: Array.isArray(parsed.measures) ? parsed.measures as ParsedEntity["measures"] : [],
          joins: Array.isArray(parsed.joins) ? parsed.joins as ParsedEntity["joins"] : [],
          query_patterns: Array.isArray(parsed.query_patterns) ? parsed.query_patterns as ParsedEntity["query_patterns"] : [],
          connection: typeof parsed.connection === "string" ? parsed.connection : undefined,
        });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), file, orgId },
          "Failed to parse entity YAML from disk",
        );
      }
    }
  }

  if (parseFailures > 0 && parseFailures === rows.length) {
    log.error(
      { orgId, totalRows: rows.length, parseFailures },
      "All org entity rows failed YAML parse — semantic layer is corrupt",
    );
  }

  // `totalRows` is the count of merged entities (DB + disk after dedup) — the
  // canonical "what the user sees" number that lines up with `listAdminEntities`.
  // `parseFailures` is still rows-scoped (DB only) so the existing `corrupt`
  // discriminator in the route stays meaningful: a workspace whose DB rows all
  // fail parse is `parseFailures === rows.length && rows.length > 0`, regardless
  // of how many disk entries merged in.
  return { entities, totalRows: entities.length, parseFailures };
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
