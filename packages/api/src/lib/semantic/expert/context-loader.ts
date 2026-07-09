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
 * Project a parsed YAML record into a `ParsedEntity`. Shared by every entity
 * loader (DB, disk, merged) so the three views always agree on field shape
 * and fallback ordering. `fallbackName` covers rows/files where the YAML
 * itself omits `name` (DB → `row.name`, disk → filename without extension);
 * `fallbackConnection` is the DB-row `connection_group_id` carried through
 * when the YAML doesn't carry an explicit `connection:` field.
 */
function projectParsedEntity(
  parsed: Record<string, unknown>,
  opts: { fallbackName: string; fallbackConnection?: string | null },
): ParsedEntity {
  const name = typeof parsed.name === "string" && parsed.name
    ? parsed.name
    : String((parsed.table ?? opts.fallbackName) as string);
  return {
    name,
    table: String((parsed.table ?? opts.fallbackName) as string),
    description: typeof parsed.description === "string" ? parsed.description : undefined,
    dimensions: Array.isArray(parsed.dimensions) ? parsed.dimensions as ParsedEntity["dimensions"] : [],
    measures: Array.isArray(parsed.measures) ? parsed.measures as ParsedEntity["measures"] : [],
    joins: Array.isArray(parsed.joins) ? parsed.joins as ParsedEntity["joins"] : [],
    query_patterns: Array.isArray(parsed.query_patterns) ? parsed.query_patterns as ParsedEntity["query_patterns"] : [],
    connection: typeof parsed.connection === "string" ? parsed.connection : (opts.fallbackConnection ?? undefined),
  };
}

/** Log the "all rows failed parse" diagnostic when every DB row was corrupt.
 * Kept as a helper so `loadEntitiesFromDB` and `loadEntitiesForOrg` log the
 * same shape — operators see one consistent signal. */
function logIfAllRowsCorrupt(orgId: string, totalRows: number, parseFailures: number): void {
  if (parseFailures > 0 && parseFailures === totalRows) {
    log.error(
      { orgId, totalRows, parseFailures },
      "All org entity rows failed YAML parse — semantic layer is corrupt",
    );
  }
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
      // NOTE: ignores `parsed.name` (keys off `parsed.table ?? row.name`) —
      // preserved verbatim from pre-#2503 to avoid changing the schedule-tick
      // semantics. `loadEntitiesForOrg` honors `parsed.name` because the
      // admin merge path keys dedup by it.
      entities.push({
        name: String((parsed.table ?? row.name) as string),
        table: String((parsed.table ?? row.name) as string),
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

  logIfAllRowsCorrupt(orgId, rows.length, parseFailures);
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
 * carry a non-null `connection_group_id` (introduced by migration 0063 /
 * #2412) and the disk-mirror entries — written with no group scope — no
 * longer share the dedup key. Result was visible drift: file tree showed
 * roughly twice the row count the Health caption did.
 *
 * Three invariants this helper holds in lockstep with `mergeAdminEntities`
 * (#2503 review):
 *   1. Dedup key is built via `dedupKey()` re-exported from `admin-source.ts`
 *      — not a hand-maintained copy — so the formula can never silently drift.
 *   2. Disk entries key on `(parsed.table, null)`, mirroring
 *      `diskToAdminSummary` which ignores YAML `name:` for disk rows. DB rows
 *      key on `(parsed.name ?? parsed.table, group)`, mirroring
 *      `parseRowToAdminSummary`.
 *   3. Disk traversal goes through `scanEntities` so per-source
 *      `{source}/entities/` subdirectories are walked (matches
 *      `discoverEntities`). The dual-write sync writes flat under
 *      `entities/` today, but the file tree also surfaces per-source files,
 *      and the Health count must include them or the gap reopens.
 *
 * `totalRows` stays DB-rows-scoped (matches `loadEntitiesFromDB`'s contract)
 * so the route's `corrupt` discriminator (`parseFailures === totalRows &&
 * totalRows > 0`) still fires when every DB row fails parse, even if the
 * disk mirror has healthy entries that would otherwise mask the corruption.
 * `entities.length` is the merged user-facing count.
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
  const { scanEntities } = await import("@atlas/api/lib/semantic/scanner");
  const { dedupKey } = await import("@atlas/api/lib/semantic/dedup-key");

  const rows = mode === "developer"
    ? await listEntitiesWithOverlay(orgId, "entity")
    : await listEntityRows(orgId, "entity", "published");

  const entities: ParsedEntity[] = [];
  const seen = new Set<string>();
  let parseFailures = 0;

  for (const row of rows) {
    try {
      const parsed = yaml.load(row.yaml_content) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object") {
        parseFailures++;
        continue;
      }
      const groupId = row.connection_group_id ?? null;
      const entity = projectParsedEntity(parsed, {
        fallbackName: row.name,
        fallbackConnection: groupId,
      });
      // DB rows key on the YAML display name (matches
      // `parseRowToAdminSummary` in admin-source.ts).
      const key = dedupKey(entity.name, groupId);
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push(entity);
    } catch (err) {
      parseFailures++;
      log.warn(
        { err: err instanceof Error ? err.message : String(err), entity: row.name, orgId },
        "Failed to parse entity YAML from DB",
      );
    }
  }

  // Disk mirror — org-scoped under `.orgs/<orgId>/entities/` (and any
  // `{source}/entities/` subdirectories scanEntities walks). `scanEntities`
  // is the same traversal `discoverEntities` uses, so the Health count
  // includes every file the admin file tree renders.
  const diskRoot = getOrgSemanticRoot(orgId);
  if (fs.existsSync(diskRoot)) {
    const { entities: scanned } = scanEntities(diskRoot);
    for (const { raw, filePath } of scanned) {
      // `scanEntities` already filtered out files whose YAML failed to
      // parse or didn't produce an object — those surface via its
      // `warnings`. We additionally require a `table:` field so we match
      // `discoverEntities`'s "skip files missing required `table`" gate
      // (files.ts:88), keeping the disk count in lockstep with the
      // admin file tree.
      if (typeof raw.table !== "string" || !raw.table) continue;
      const entity = projectParsedEntity(raw, {
        fallbackName: path.basename(filePath).replace(/\.ya?ml$/, ""),
      });
      // Disk entries key on `parsed.table` (not the display name).
      // `diskToAdminSummary` in admin-source.ts produces
      // `summary.name = e.table` for disk entries — keying on `entity.name`
      // here would diverge when a disk file authors a distinct YAML `name:`.
      const key = dedupKey(String(raw.table), null);
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push(entity);
    }
  }

  logIfAllRowsCorrupt(orgId, rows.length, parseFailures);

  // `totalRows = rows.length` (DB-only) — see header comment. Merged count
  // is `entities.length`, available to the caller via the entities array;
  // `computeSemanticHealth` derives `entityCount` from `entities.length` so
  // the user-facing number is still the merged total.
  return { entities, totalRows: rows.length, parseFailures };
}

/**
 * Load entity YAML files across every on-disk layout (ADR-0012): the flat
 * default `entities/`, the canonical `groups/<group>/entities/` namespace, and
 * legacy `<source>/entities/`. Routed through the shared `scanEntities`
 * traversal the discovery read paths use, so the expert context can no longer
 * miss per-group entities (#3284).
 *
 * Each entity carries its effective Connection group on `ParsedEntity.group`,
 * resolved directory-canonically via {@link resolveEntityGroup} (matching the
 * importer + file whitelist): `"default"` for the flat root, the group name for
 * `groups/<group>/` and legacy `<source>/`. That group is threaded
 * analyze → insert → apply so the scheduled tick's auto-apply path
 * (`runExpertSchedulerTick` → `applyAmendmentToEntity`) updates the correct
 * group's row instead of 409-ing as ambiguous or corrupting the default scope —
 * the gap that previously kept this loader deliberately root-only.
 *
 * `name` keys off the file stem — the storage key the importer
 * (`_scanEntityDirs`) writes to `semantic_entities.name` and that the apply
 * path looks the entity up by — matching `discoverEntities` rather than the
 * YAML `name:` display label. Files missing the required `table:` field are
 * skipped, mirroring `discoverEntities`/`_scanEntityDirs`.
 */
export async function loadEntitiesFromDisk(): Promise<ParsedEntity[]> {
  const { scanEntities, resolveEntityGroup, readGroupField } = await import(
    "@atlas/api/lib/semantic/scanner"
  );

  const root = getSemanticRoot();
  if (!fs.existsSync(root)) return [];

  const { entities: scanned, warnings } = scanEntities(root);
  // The interactive read paths surface scan warnings to the user; the expert
  // tick runs unattended, so re-log a partial scan against the expert context
  // (matches `loadGlossaryFromDisk`'s fail-loud handling of a partial union).
  if (warnings.length > 0) {
    log.warn(
      { warnings },
      "Expert entity context is partial — some entity files failed to scan",
    );
  }

  const entities: ParsedEntity[] = [];
  for (const { raw, filePath, sourceName, origin } of scanned) {
    // Require `table:` so we match `discoverEntities`/`_scanEntityDirs`'s gate;
    // `scanEntities` already dropped files whose YAML failed to parse.
    if (typeof raw.table !== "string" || !raw.table) continue;

    // Mirror the importer's write scope (`_scanEntityDirs`) so the apply path's
    // `getEntity(..., group)` resolves the SAME row the importer wrote (#3284):
    //   - flat root → "default" (NULL `connection_group_id`). The importer
    //     scopes flat entities by install-id, NOT a declared `group:`/`connection:`
    //     field — which resolves to NULL in the self-hosted scheduler context
    //     this loader serves — so honoring the field here would target a group
    //     the DB row was never imported into.
    //   - canonical `groups/<group>/` and legacy `<source>/` → the resolved
    //     group (the importer sets `connection_group_id` from the same
    //     `resolveEntityGroup` call), so honor it.
    const group = origin === "flat"
      ? "default"
      : resolveEntityGroup(sourceName, origin, readGroupField(raw)).group;
    entities.push({
      name: path.basename(filePath).replace(/\.ya?ml$/, ""),
      table: raw.table,
      description: typeof raw.description === "string" ? raw.description : undefined,
      dimensions: Array.isArray(raw.dimensions) ? raw.dimensions as ParsedEntity["dimensions"] : [],
      measures: Array.isArray(raw.measures) ? raw.measures as ParsedEntity["measures"] : [],
      joins: Array.isArray(raw.joins) ? raw.joins as ParsedEntity["joins"] : [],
      query_patterns: Array.isArray(raw.query_patterns) ? raw.query_patterns as ParsedEntity["query_patterns"] : [],
      connection: typeof raw.connection === "string" ? raw.connection : undefined,
      group,
    });
  }

  return entities;
}

/**
 * Load glossary terms from disk across every on-disk layout (ADR-0012): the flat
 * default root, the canonical `groups/<group>/glossary.yml` namespace, and
 * legacy `<source>/glossary.yml`. Routed through the same layout-aware
 * `getGroupDirs` traversal the discovery read paths use (#3240), so the expert
 * context can no longer miss per-group glossary terms (#3273).
 *
 * Both glossary YAML shapes are honored, matching the discovery loaders
 * (`lib/semantic/lookups.ts`, `lib/semantic/search.ts`): the object form
 * `terms: { name: { status, definition } }` (canonical) and the array form
 * `terms: [{ term, definition, ambiguous }]` (legacy). The previous root-only
 * loader parsed the array form *only*, so it returned nothing for the object
 * form the bundled glossaries actually use — a second drift point this closes.
 *
 * The expert `GlossaryTerm` carries no group label, so the loader returns a flat
 * union of every group's terms (per-group attribution is the entity loader's
 * concern). It does NOT dedup: the gap detector keys off term name via a Set
 * (`categories.ts`), so a name defined in two groups won't spawn spurious gap
 * proposals; the health count uses the raw list length (`health.ts`), so a name
 * repeated across groups is counted once per group.
 */
export async function loadGlossaryFromDisk(): Promise<GlossaryTerm[]> {
  const { getGroupDirs } = await import("@atlas/api/lib/semantic/scanner");

  const terms: GlossaryTerm[] = [];
  const { dirs, failedScans } = getGroupDirs(getSemanticRoot(), null);
  for (const { dir } of dirs) {
    loadGlossaryFile(path.join(dir, "glossary.yml"), terms);
  }
  // The interactive lookup/search read paths surface scan failures to the user
  // through the response; the expert tick runs unattended, so re-log a failed
  // namespace enumeration against the expert context — otherwise a quietly
  // partial glossary leaves only a low-level scanner warn (#3243 fail-closed
  // semantics).
  if (failedScans.length > 0) {
    log.warn(
      { failedScans },
      "Expert glossary context is partial — a semantic namespace failed to enumerate",
    );
  }
  return terms;
}

/**
 * Parse a single `glossary.yml` into expert `GlossaryTerm`s, appending to `out`.
 * Tolerates both the object- and array-term shapes; a read/parse failure on one
 * group's file is logged and skipped so it can't blank the whole expert context.
 */
function loadGlossaryFile(filePath: string, out: GlossaryTerm[]): void {
  if (!fs.existsSync(filePath)) return;

  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    log.warn(
      { filePath, err: err instanceof Error ? err.message : String(err) },
      "Failed to parse glossary.yml",
    );
    return;
  }

  if (!raw || typeof raw !== "object") return;
  const termsNode = (raw as { terms?: unknown }).terms;

  if (Array.isArray(termsNode)) {
    for (const entry of termsNode) {
      const term = normalizeGlossaryTerm(entry);
      if (term) out.push(term);
    }
  } else if (termsNode && typeof termsNode === "object") {
    for (const [key, value] of Object.entries(termsNode as Record<string, unknown>)) {
      const term = normalizeGlossaryTerm(value, key);
      if (term) out.push(term);
    }
  }
}

/**
 * Normalize one glossary entry into the expert `GlossaryTerm` shape. Object-form
 * entries supply the term name via `fallbackTerm` (the YAML key); array-form
 * entries carry their own `term`. Returns `null` when no term name resolves.
 * `ambiguous` is derived from an explicit `ambiguous: true` or the load-bearing
 * `status: ambiguous` marker (the glossary's canonical "ask the user" signal).
 */
function normalizeGlossaryTerm(raw: unknown, fallbackTerm?: string): GlossaryTerm | null {
  if (raw == null || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const term = typeof rec.term === "string" && rec.term ? rec.term : fallbackTerm;
  if (!term) return null;
  return {
    term,
    definition: typeof rec.definition === "string" ? rec.definition : "",
    ambiguous: rec.ambiguous === true || rec.status === "ambiguous",
  };
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
      connection_group_id: string | null;
      amendment_payload: string | Record<string, unknown> | null;
    }>(
      `SELECT source_entity, connection_group_id, amendment_payload FROM learned_patterns
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
          // Group-scoped key (#3284): NULL `connection_group_id` → "default",
          // matching `entity.group` in `categories.ts` so one group's rejection
          // doesn't mark another group's same-named amendment stale.
          const group = row.connection_group_id ?? "default";
          keys.add(`${group}:${row.source_entity}:${payload.amendmentType}:${payload.amendment?.name ?? ""}`);
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
