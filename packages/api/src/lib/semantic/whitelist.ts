/**
 * Semantic layer utilities.
 *
 * Reads the semantic/ directory to extract metadata used by the SQL tool
 * (table whitelist) and the CLI (schema profiling).
 *
 * Table whitelists are partitioned by Connection group. The canonical layout
 * is the `semantic/groups/<group>/entities/` namespace, where the directory
 * names the group (ADR-0012); the flat `semantic/entities/` root is the
 * default group. An in-file `group:` field (with `connection:` as a deprecated
 * alias) assigns the group from the flat root, and in the legacy
 * `semantic/<source>/entities/` layout the field still wins over the directory
 * (back-compat); in the canonical `groups/` namespace the directory is
 * canonical and a disagreeing field warns. When no group signal is present,
 * all connections share the same whitelist (backward compat with single-DB).
 *
 * **Org scoping:** When an orgId is active, the whitelist is loaded from
 * the internal DB (`semantic_entities` table). The semantic index is built
 * from persistent on-disk files at `{semanticRoot}/.orgs/{orgId}/`, maintained
 * by the dual-write sync layer (`./sync.ts`). When no orgId is
 * present (CLI, self-hosted without orgs), file-based YAML is used
 * (existing behavior).
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { z } from "zod";
import { getSemanticRoot as getDefaultSemanticRoot } from "./files";
import { createLogger } from "@atlas/api/lib/logger";
import { invalidateSemanticIndex } from "./search";
import { getEntityDirs, readGroupField, resolveEntityGroup, type EntityDirOrigin, type ScanNamespace } from "./scanner";
import { invalidateOrgModeRoots } from "./sync";

const log = createLogger("semantic");

const CrossSourceJoinShape = z.object({
  source: z.string().min(1),
  target_table: z.string().min(1),
  on: z.string().min(1),
  relationship: z.enum(["many_to_one", "one_to_many", "one_to_one", "many_to_many"]),
  description: z.string().optional(),
});

type CrossSourceJoinRelationship = z.infer<typeof CrossSourceJoinShape>["relationship"];

// `EntityShape` lives in `./shapes` so the consolidated `listEntities`
// in `entities.ts` validates rows with the same predicate (#2150).
import { EntityShape } from "./shapes";

export interface CrossSourceJoin {
  fromSource: string;
  fromTable: string;
  toSource: string;
  toTable: string;
  on: string;
  relationship: CrossSourceJoinRelationship;
  description?: string;
}

const _whitelists = new Map<string, Set<string>>();
let _tablesByConnection: Map<string, Set<string>> | null = null;
/**
 * Namespaces whose directory scan failed during the cached load (#3243).
 * Cached alongside `_tablesByConnection` so the fail-closed decision in
 * {@link getWhitelistedTables} stays consistent with the table map it was
 * built from. Reset by `_resetWhitelists`.
 */
let _scanFailedNamespaces: ScanNamespace[] = [];
let _crossSourceJoins: CrossSourceJoin[] | null = null;

/**
 * Strip identifier quotes from each dotted segment of a table name.
 *
 * Entity YAMLs sometimes carry quoted table names because the underlying
 * identifier is a SQL reserved keyword (e.g. Better Auth's Postgres `"user"`
 * table). `node-sql-parser` strips identifier quotes from its `tableList`
 * output before we look the name up, so the whitelist must store the
 * unquoted form or the lookup misses on every `FROM "user"` the agent
 * emits. Handles the three identifier-quote forms our supported dialects
 * use: `"name"` (Postgres / ANSI), `` `name` `` (MySQL), `[name]` (T-SQL).
 * Schema-qualified names are normalized per segment so `public."user"`
 * → `public.user`.
 */
export function normalizeTableIdentifier(raw: string): string {
  return raw
    .split(".")
    .map((seg) => {
      if (seg.length < 2) return seg;
      const first = seg[0];
      const last = seg[seg.length - 1];
      if (
        (first === '"' && last === '"') ||
        (first === "`" && last === "`") ||
        (first === "[" && last === "]")
      ) {
        return seg.slice(1, -1);
      }
      return seg;
    })
    .join(".");
}

/** Plugin-provided entity tables, keyed by connection ID. */
const _pluginEntities = new Map<string, Set<string>>();

/**
 * Load entity YAMLs from a single directory into the group map.
 *
 * The effective group is resolved per-entity from the directory and any
 * declared `group:`/`connection:` field via {@link resolveEntityGroup}
 * (ADR-0012): the canonical `groups/<group>/` directory is authoritative
 * (a disagreeing field warns and the directory wins); the flat default root
 * and legacy `<source>/` layouts let the field assign the group.
 *
 * @param dir - Directory containing *.yml entity files.
 * @param dirGroup - Group implied by the directory: `"default"` for the flat
 *   root, the directory name for `groups/<group>/` or legacy `<source>/`.
 * @param origin - On-disk layout of `dir`, driving group precedence.
 * @param byConnection - Accumulator map to populate (keyed by group).
 * @param crossJoins - Optional accumulator for cross-source join hints.
 *   When provided, valid `cross_source_joins` entries from each entity are
 *   appended here. Invalid individual join entries are skipped with a warning
 *   without affecting the entity's whitelist membership.
 */
function loadEntitiesFromDir(
  dir: string,
  dirGroup: string,
  origin: EntityDirOrigin,
  byConnection: Map<string, Set<string>>,
  crossJoins?: CrossSourceJoin[],
): void {
  if (!fs.existsSync(dir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
  } catch (err) {
    log.error({ dir, err: err instanceof Error ? err.message : String(err) }, "Failed to read entities directory — skipping");
    return;
  }

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), "utf-8");
      // js-yaml v4+ yaml.load() uses DEFAULT_SCHEMA (JSON + core YAML types) which is
      // safe — it does not instantiate arbitrary JS objects (unlike v3's yaml.load).
      const raw = yaml.load(content);
      const parsed = EntityShape.safeParse(raw);
      if (!parsed.success) {
        // Try to extract the table name from raw YAML for a more useful log message
        const tableName = raw && typeof raw === "object" && "table" in raw && typeof (raw as Record<string, unknown>).table === "string"
          ? (raw as Record<string, unknown>).table as string
          : undefined;
        log.warn({ file, table: tableName, err: parsed.error.message }, "Skipping entity file — failed to validate");
        continue;
      }
      const entity = parsed.data;

      // Resolve the effective group from the directory + declared field
      // (ADR-0012). The directory is canonical in the `groups/` namespace;
      // a disagreeing field there is a foot-gun we warn on rather than honor.
      const fieldGroup = readGroupField(entity);
      const { group: connId, mismatch } = resolveEntityGroup(dirGroup, origin, fieldGroup);
      if (mismatch) {
        log.warn(
          { file, dir, directoryGroup: dirGroup, declaredGroup: fieldGroup },
          "Entity declares a group that differs from its directory — honoring the directory (ADR-0012: directory is canonical)",
        );
      }
      if (!byConnection.has(connId)) byConnection.set(connId, new Set());
      const tables = byConnection.get(connId)!;

      // Extract table name (may include schema prefix like "public.users").
      // Normalize identifier quotes so `"user"` / `` `user` `` in the YAML
      // matches the unquoted name `node-sql-parser` returns from `FROM "user"`.
      const normalized = normalizeTableIdentifier(entity.table);
      const parts = normalized.split(".");
      tables.add(parts[parts.length - 1].toLowerCase());
      // Also add the full qualified name
      tables.add(normalized.toLowerCase());

      // Validate and collect cross-source joins separately from core entity parsing.
      // Invalid join entries are skipped individually without dropping the entity.
      const rawJoins = (raw as Record<string, unknown>).cross_source_joins;
      if (crossJoins && Array.isArray(rawJoins)) {
        for (let i = 0; i < rawJoins.length; i++) {
          const joinParsed = CrossSourceJoinShape.safeParse(rawJoins[i]);
          if (!joinParsed.success) {
            log.warn(
              { file, table: entity.table, index: i, err: joinParsed.error.message },
              "Skipping invalid cross_source_joins entry",
            );
            continue;
          }
          const j = joinParsed.data;
          crossJoins.push({
            fromSource: connId,
            fromTable: entity.table,
            toSource: j.source,
            toTable: j.target_table,
            on: j.on,
            relationship: j.relationship,
            description: j.description,
          });
        }
      }
    } catch (err) {
      log.warn({ file, err: err instanceof Error ? err.message : String(err) }, "Skipping entity file — failed to parse");
    }
  }
}

/**
 * Load entity YAMLs and partition tables by Connection group.
 *
 * Supports two directory layouts:
 * - **Flat (legacy):** `entitiesDir` points to a single directory of *.yml files
 *   (treated as the default group).
 * - **Group-scoped:** `semanticRoot` points to the semantic root containing
 *   `entities/` (default group), the canonical `groups/<group>/entities/`
 *   namespace, and legacy `<source>/entities/` subdirectories (ADR-0012).
 *
 * @param semanticRoot - Semantic layer root directory (scans subdirectories).
 * @param entitiesDir - Override for a single flat entities directory (DI for tests).
 */
interface LoadedTables {
  byConnection: Map<string, Set<string>>;
  /**
   * Namespaces whose directory scan failed during this load (see
   * {@link ScanNamespace}). A non-empty list means the partition decision is
   * unreliable and affected groups must fail closed — never drop to
   * shared-default mode (#3243).
   */
  failedScans: ScanNamespace[];
}

function loadTablesByConnection(
  semanticRoot?: string,
  entitiesDir?: string,
  crossJoins?: CrossSourceJoin[],
): LoadedTables {
  const byConnection = new Map<string, Set<string>>();

  // Legacy flat-directory path (existing tests use this) — the default group.
  if (entitiesDir) {
    loadEntitiesFromDir(entitiesDir, "default", "flat", byConnection, crossJoins);
    return { byConnection, failedScans: [] };
  }

  const root = semanticRoot ?? getDefaultSemanticRoot();

  const { dirs, failedScans } = getEntityDirs(root);
  if (failedScans.length > 0) {
    log.error(
      { root, failedScans },
      "Failed to scan semantic namespace(s) — per-group whitelist entries may be missing; affected groups fail closed (not dropped to shared-default)",
    );
  }

  for (const { dir, sourceName, origin } of dirs) {
    if (origin !== "flat") {
      log.info({ group: sourceName, dir, origin }, "Discovered per-group entities directory");
      // Seed an empty bucket so a discovered group/legacy directory is
      // recognized as its own non-default group even when empty or all-invalid.
      // The directory is the group boundary (ADR-0012), so an empty/broken
      // group must fail closed (empty whitelist → queries rejected) rather than
      // leaving partition mode off and silently inheriting the default group's
      // tables.
      if (!byConnection.has(sourceName)) byConnection.set(sourceName, new Set());
    }
    loadEntitiesFromDir(dir, sourceName, origin, byConnection, crossJoins);
  }

  const hasPartitioned = Array.from(byConnection.keys()).some((k) => k !== "default");
  if (hasPartitioned) {
    log.info({ groups: Array.from(byConnection.keys()) }, "Partitioned table whitelist mode");
  }

  return { byConnection, failedScans };
}

function getTablesByConnection(semanticRoot?: string, entitiesDir?: string): LoadedTables {
  if (!_tablesByConnection) {
    const crossJoins: CrossSourceJoin[] = [];
    const { byConnection, failedScans } = loadTablesByConnection(semanticRoot, entitiesDir, crossJoins);
    _tablesByConnection = byConnection;
    _scanFailedNamespaces = failedScans;
    _crossSourceJoins = crossJoins;
  }
  return { byConnection: _tablesByConnection, failedScans: _scanFailedNamespaces };
}

/**
 * Resolve the whitelist for one Connection group from a loaded by-connection
 * map, applying the fail-closed rule on scan failure (#3243).
 *
 * Partition mode (each group sees only its own tables) is normally inferred
 * from the presence of a non-default group. That inference is only trustworthy
 * when every directory scan SUCCEEDED — a failed `groups/`/legacy scan can hide
 * the very group that would have flipped the decision. So when any scan failed
 * we never drop to shared-default mode: the requested group resolves to its own
 * (possibly empty) set and fails closed, rather than silently inheriting the
 * default group's tables (a fail-toward-widening, validating against the WRONG
 * group). The empty-whitelist log distinguishes "scan failed (incomplete)" from
 * "no entities configured" — different operator situations.
 */
function resolveGroupTables(
  byConnection: Map<string, Set<string>>,
  connectionId: string,
  failedScans: ScanNamespace[],
): Set<string> {
  const scanFailed = failedScans.length > 0;
  const hasNonDefaultConnection = Array.from(byConnection.keys()).some((k) => k !== "default");

  // Shared-default (single-DB back-compat) ONLY when no non-default group
  // exists AND every scan succeeded. A failed scan makes "no non-default group"
  // untrustworthy, so we must not widen the lookup to the default whitelist.
  if (!hasNonDefaultConnection && !scanFailed) {
    return new Set(byConnection.get("default") ?? []);
  }

  const tables = new Set(byConnection.get(connectionId) ?? []);
  if (tables.size === 0) {
    if (scanFailed) {
      log.error(
        { connectionId, failedScans, knownConnections: Array.from(byConnection.keys()) },
        "Semantic layer scan failed — whitelist load incomplete; failing closed (all queries for this connection rejected). This is a scan failure, not an unconfigured group.",
      );
    } else {
      log.warn(
        { connectionId, knownConnections: Array.from(byConnection.keys()) },
        "No entities configured for connection — whitelist is empty; all queries will be rejected",
      );
    }
  }
  return tables;
}

/**
 * Get the set of whitelisted table names for a given Connection group.
 *
 * The system switches to partitioned mode (each group only sees its own
 * tables) when a non-default group exists — i.e. when either:
 * - an entity declares a non-default `group:`/`connection:`, or
 * - a `groups/<group>/entities/` (or legacy `<source>/entities/`) directory
 *   exists under the semantic root (ADR-0012).
 *
 * When neither trigger is present, all connections share the same table
 * set (identical to pre-v0.7 single-DB behavior).
 *
 * @param connectionId - Group to get tables for. Defaults to "default".
 * @param entitiesDir - Override for a single flat entities directory (DI for tests).
 * @param semanticRoot - Override for the semantic root directory (DI for tests).
 *   When provided, scans `root/entities/`, `root/groups/<group>/entities/`,
 *   and legacy `root/<source>/entities/` directories.
 */
export function getWhitelistedTables(
  connectionId: string = "default",
  entitiesDir?: string,
  semanticRoot?: string,
): Set<string> {
  // When using custom paths (tests), bypass the global cache
  if (entitiesDir || semanticRoot) {
    const { byConnection, failedScans } = loadTablesByConnection(semanticRoot, entitiesDir);
    const tables = resolveGroupTables(byConnection, connectionId, failedScans);
    // Merge plugin-provided entities even in custom-path mode
    const pluginTables = _pluginEntities.get(connectionId);
    if (pluginTables && pluginTables.size > 0) {
      for (const t of pluginTables) tables.add(t);
    }
    return tables;
  }

  const cached = _whitelists.get(connectionId);
  if (cached) return cached;

  // Resolve from the cached load, failing closed when a directory scan failed:
  // a swallowed FS error must never drop the partition decision to shared-default
  // mode (back-compat single-DB sharing applies only when every scan succeeded).
  const { byConnection, failedScans } = getTablesByConnection();
  const tables = resolveGroupTables(byConnection, connectionId, failedScans);

  // Merge plugin-provided entities for this connection
  const pluginTables = _pluginEntities.get(connectionId);
  if (pluginTables && pluginTables.size > 0) {
    for (const t of pluginTables) tables.add(t);
  }

  _whitelists.set(connectionId, tables);
  return tables;
}

/**
 * Get all cross-source join hints parsed from entity YAMLs.
 *
 * When called with a `semanticRoot`, loads fresh from disk and returns a new
 * array without affecting the global cache. When called without arguments,
 * uses the global cache populated by `getTablesByConnection`.
 */
export function getCrossSourceJoins(semanticRoot?: string): readonly CrossSourceJoin[] {
  if (semanticRoot) {
    const crossJoins: CrossSourceJoin[] = [];
    loadTablesByConnection(semanticRoot, undefined, crossJoins);
    return crossJoins;
  }
  // Ensure global cache is populated
  getTablesByConnection();
  return _crossSourceJoins ?? [];
}

/** Clears cached whitelists, table-by-connection mappings, cross-source joins, and semantic index. */
export function _resetWhitelists(): void {
  _whitelists.clear();
  _tablesByConnection = null;
  _scanFailedNamespaces = [];
  _crossSourceJoins = null;
  invalidateSemanticIndex();
}

/**
 * Register plugin-provided entity definitions into the table whitelist.
 *
 * Parses each entity's YAML content using the same validation as disk-based
 * entities. Tables are stored in a separate in-memory map that is merged
 * into the whitelist on read. No files are written to disk.
 *
 * @param connectionId - Connection ID the entities belong to (usually the plugin ID).
 * @param entities - Array of `{ name, yaml }` entity definitions.
 */
export function registerPluginEntities(
  connectionId: string,
  entities: Array<{ name: string; yaml: string }>,
): void {
  if (!_pluginEntities.has(connectionId)) {
    _pluginEntities.set(connectionId, new Set());
  }
  const tables = _pluginEntities.get(connectionId)!;

  let skippedCount = 0;
  for (const entity of entities) {
    try {
      const raw = yaml.load(entity.yaml);
      const parsed = EntityShape.safeParse(raw);
      if (!parsed.success) {
        log.warn(
          { connectionId, entity: entity.name, err: parsed.error.message },
          "Skipping plugin entity — failed to validate YAML",
        );
        skippedCount++;
        continue;
      }
      const tableName = normalizeTableIdentifier(parsed.data.table);
      const parts = tableName.split(".");
      tables.add(parts[parts.length - 1].toLowerCase());
      tables.add(tableName.toLowerCase());
    } catch (err) {
      log.warn(
        { connectionId, entity: entity.name, err: err instanceof Error ? err.message : String(err) },
        "Skipping plugin entity — failed to parse YAML",
      );
      skippedCount++;
    }
  }

  // Clear the merged whitelist cache so the next read picks up plugin entities
  _whitelists.clear();

  if (skippedCount === entities.length && entities.length > 0) {
    log.error(
      { connectionId, entityCount: entities.length, skippedCount, tableCount: tables.size },
      "All plugin entities failed to register",
    );
  } else {
    log.info(
      { connectionId, entityCount: entities.length, skippedCount, tableCount: tables.size },
      "Registered plugin entities",
    );
  }
}

/** Clears plugin-provided entity registrations. For testing. */
export function _resetPluginEntities(): void {
  _pluginEntities.clear();
  _whitelists.clear();
}

// ---------------------------------------------------------------------------
// Org-scoped whitelist (DB-backed)
// ---------------------------------------------------------------------------

/**
 * Per-org whitelist cache: Map<cacheKey, { tables, expiresAt }>.
 * Each mode gets a distinct cache key so the three result shapes (published
 * filter, developer overlay, no-mode legacy) can never be confused:
 *   - `${orgId}:published` — status = 'published'
 *   - `${orgId}:developer` — CTE overlay
 *   - `${orgId}` — legacy path, no mode supplied (all rows incl. tombstones)
 *
 * Cache entries expire after `_ORG_WHITELIST_TTL_MS`. Without a TTL,
 * out-of-band changes (manual SQL, cross-region replication, recovery
 * scripts) leave the API serving stale data forever — entity CRUD
 * invalidates only when it goes through our handlers. The TTL makes the
 * cache eventually consistent with the DB.
 */
interface CachedWhitelist {
  tables: Map<string, Set<string>>;
  expiresAt: number;
}
const _orgWhitelists = new Map<string, CachedWhitelist>();

const _ORG_WHITELIST_TTL_MS = (() => {
  const raw = process.env.ATLAS_ORG_WHITELIST_TTL_MS;
  if (!raw) return 60_000; // 60s default
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();

function whitelistCacheKey(orgId: string, mode?: "published" | "developer"): string {
  if (mode === "published") return `${orgId}:published`;
  if (mode === "developer") return `${orgId}:developer`;
  return orgId;
}

/**
 * Load the table whitelist for an org from the internal DB.
 *
 * Parses stored YAML content using the same EntityShape validation as
 * file-based loading. Results are cached per-org (keyed by org + mode).
 *
 * @param orgId - Organization ID to load entities for.
 * @param mode - Atlas mode. When "published", only published entities are
 *   included. When "developer", drafts are overlaid on published via the
 *   CTE in `listEntitiesWithOverlay` (drafts supersede, tombstones hide,
 *   archived-connection entities excluded). When omitted, behaves like
 *   developer mode without the overlay — returns all rows the DB has.
 * @returns Map of connectionId → Set<tableName>.
 */
export async function loadOrgWhitelist(orgId: string, mode?: "published" | "developer"): Promise<Map<string, Set<string>>> {
  const cacheKey = whitelistCacheKey(orgId, mode);
  const cached = _orgWhitelists.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.tables;
  if (cached) {
    // Expired entry — drop it so the load below repopulates with a fresh
    // expiresAt instead of mutating a stale entry's window.
    _orgWhitelists.delete(cacheKey);
  }

  const { listEntityRows, listEntitiesWithOverlay, listConnectionGroupMembers } =
    await import("@atlas/api/lib/semantic/entities");
  const rows = mode === "developer"
    ? await listEntitiesWithOverlay(orgId, "entity")
    : await listEntityRows(orgId, "entity", mode === "published" ? "published" : undefined);

  // Group membership resolution — `connection.group_id` from 0062's
  // backfill (#2340). An entity scoped to group `g_prod` is queryable
  // on every connection that belongs to that group. We populate the
  // whitelist under every accepted key (group_id + each member
  // connection id) so lookups by either form succeed without an extra
  // DB round-trip at query time. Best-effort: if the lookup fails
  // (transient DB blip, no internal DB), fall back to keying by the
  // entity's own row-level columns — single-connection orgs still
  // resolve, multi-member groups degrade gracefully.
  //
  // Reads via the entities module helper rather than pulling in
  // `db/internal` directly so partial-mock test fixtures that swap out
  // `@atlas/api/lib/semantic/entities` cover this lookup with their
  // existing mocks instead of breaking on the content-mode transitive
  // import chain.
  const groupMembers = new Map<string, string[]>();
  try {
    const memberRows = await listConnectionGroupMembers(orgId);
    for (const { group_id, id } of memberRows) {
      const list = groupMembers.get(group_id) ?? [];
      list.push(id);
      groupMembers.set(group_id, list);
    }
  } catch (err) {
    log.warn(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "loadOrgWhitelist: failed to resolve group memberships — falling back to per-row keys",
    );
  }

  const byConnection = new Map<string, Set<string>>();
  /**
   * Register the entity's tables under every key the whitelist should accept.
   *
   * In DB-backed orgs the row's `connection_group_id` is the **canonical**
   * scope (ADR-0012), so when it is set we key by it (plus every fellow group
   * member) and ignore the YAML `group:`/`connection:` field — a stale or
   * mismatched field must never widen a row's scope across groups. Only when
   * the row has no `connection_group_id` do we fall back to the YAML-declared
   * group (the canonical `group:` field, or the deprecated `connection:`
   * alias). Multiple registrations of the same key share the underlying Set,
   * so a second entity for the same group accretes onto the existing table set
   * (correct fan-in semantics).
   */
  function recordTables(row: typeof rows[number], parsedGroup: string | undefined, tableList: string[]): void {
    const keys = new Set<string>();
    if (row.connection_group_id) {
      keys.add(row.connection_group_id);
      for (const member of groupMembers.get(row.connection_group_id) ?? []) {
        keys.add(member);
      }
    } else if (parsedGroup) {
      keys.add(parsedGroup);
    }
    if (keys.size === 0) keys.add("default");

    for (const key of keys) {
      let bucket = byConnection.get(key);
      if (!bucket) {
        bucket = new Set();
        byConnection.set(key, bucket);
      }
      for (const t of tableList) bucket.add(t);
    }
  }

  let parseFailures = 0;
  for (const row of rows) {
    try {
      const raw = yaml.load(row.yaml_content);
      const parsed = EntityShape.safeParse(raw);
      if (!parsed.success) {
        parseFailures++;
        log.warn({ orgId, entity: row.name, err: parsed.error.message }, "Skipping org entity — failed to validate");
        continue;
      }
      const normalized = normalizeTableIdentifier(parsed.data.table);
      const parts = normalized.split(".");
      const tableList = [parts[parts.length - 1].toLowerCase(), normalized.toLowerCase()];
      recordTables(row, readGroupField(parsed.data), tableList);
    } catch (err) {
      parseFailures++;
      log.warn(
        { orgId, entity: row.name, err: err instanceof Error ? err.message : String(err) },
        "Skipping org entity — failed to parse YAML",
      );
    }
  }

  if (parseFailures === rows.length && rows.length > 0) {
    log.error({ orgId, entityCount: rows.length, parseFailures }, "All org entities failed to parse — whitelist is empty");
  }

  _orgWhitelists.set(cacheKey, { tables: byConnection, expiresAt: Date.now() + _ORG_WHITELIST_TTL_MS });
  const totalTables = Array.from(byConnection.values()).reduce((s, set) => s + set.size, 0);
  log.info({ orgId, mode: mode ?? "developer", entityCount: rows.length, parsedCount: rows.length - parseFailures, tableCount: totalTables, connections: Array.from(byConnection.keys()) }, "Loaded org whitelist from DB");
  return byConnection;
}

/**
 * Get whitelisted tables for an org + connection.
 *
 * Must be called after `loadOrgWhitelist(orgId, mode)` with the matching mode —
 * each mode has a distinct cache key (see `_orgWhitelists` and `whitelistCacheKey`),
 * so a published-mode load won't satisfy a developer-mode lookup. Returns an
 * empty set if the requested cache has not been loaded.
 *
 * @param mode - `"published"` → published-only cache; `"developer"` → overlay
 *   cache (drafts on published, tombstones hidden, archived-connection entities
 *   excluded); omitted → legacy cache built from `listEntityRows` with no status
 *   filter (includes tombstones and archived rows).
 */
export function getOrgWhitelistedTables(orgId: string, connectionId: string = "default", mode?: "published" | "developer"): Set<string> {
  const cacheKey = whitelistCacheKey(orgId, mode);
  const cached = _orgWhitelists.get(cacheKey);
  if (!cached) {
    log.warn({ orgId, connectionId, mode: mode ?? "developer" }, "Org whitelist not loaded — all tables will be rejected");
    return new Set();
  }
  const byConnection = cached.tables;

  // Single-connection orgs: callers default to "default", but demo stores
  // under "__demo__" and wizard orgs under user-chosen ids (#2142).
  let tables = new Set(byConnection.get(connectionId) ?? []);
  if (
    tables.size === 0 &&
    connectionId === "default" &&
    byConnection.size === 1 &&
    !byConnection.has("default")
  ) {
    const [storedKey] = byConnection.keys();
    const [onlyTables] = byConnection.values();
    tables = new Set(onlyTables);
    log.debug(
      { orgId, requestedConnectionId: connectionId, resolvedConnectionId: storedKey, mode: mode ?? "developer" },
      "getOrgWhitelistedTables: single-connection fallback",
    );
  }

  // Merge plugin-provided entities (same behavior as file-based getWhitelistedTables)
  const pluginTables = _pluginEntities.get(connectionId);
  if (pluginTables && pluginTables.size > 0) {
    for (const t of pluginTables) tables.add(t);
  }

  return tables;
}

/** Invalidate the cached whitelist for an org (call after entity CRUD). Clears every mode's cache entry. */
export function invalidateOrgWhitelist(orgId: string): void {
  _orgWhitelists.delete(orgId);
  _orgWhitelists.delete(`${orgId}:published`);
  _orgWhitelists.delete(`${orgId}:developer`);
  invalidateOrgSemanticIndex(orgId);
  invalidateOrgModeRoots(orgId);
}

/** Clear all org whitelist caches. For testing. */
export function _resetOrgWhitelists(): void {
  _orgWhitelists.clear();
}

// ---------------------------------------------------------------------------
// Org-scoped semantic index
// ---------------------------------------------------------------------------

/** Per-org semantic index cache. */
const _orgSemanticIndexes = new Map<string, string>();

/** Invalidate the cached semantic index for an org. */
export function invalidateOrgSemanticIndex(orgId: string): void {
  _orgSemanticIndexes.delete(orgId);
}

/**
 * Get or build the semantic index for an org.
 *
 * Reads from the persistent org directory at `{semanticRoot}/.orgs/{orgId}/`
 * maintained by the dual-write sync layer (`./sync.ts`). If the
 * directory is empty or missing, triggers a DB-to-disk sync first.
 *
 * On sync failure (e.g. transient DB outage), returns an uncached result
 * built from whatever is on disk — the next call will retry the sync.
 */
export async function getOrgSemanticIndex(orgId: string): Promise<string> {
  const cached = _orgSemanticIndexes.get(orgId);
  if (cached !== undefined) return cached;

  const { getSemanticRoot, syncAllEntitiesToDisk } = await import("@atlas/api/lib/semantic/sync");
  const orgRoot = getSemanticRoot(orgId);

  // Ensure the org directory exists on disk (may be first access after boot)
  const entitiesDir = path.join(orgRoot, "entities");
  let hasFiles = false;
  let syncFailed = false;
  try {
    const entries = fs.readdirSync(entitiesDir);
    hasFiles = entries.some((e) => e.endsWith(".yml"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(
        { orgId, err: err instanceof Error ? err.message : String(err) },
        "Unexpected error reading org entities directory",
      );
    }
  }

  if (!hasFiles) {
    // Rebuild from DB before building the index
    try {
      await syncAllEntitiesToDisk(orgId);
    } catch (err) {
      syncFailed = true;
      log.warn(
        { orgId, err: err instanceof Error ? err.message : String(err) },
        "Failed to sync org entities to disk for semantic index — returning uncached result",
      );
    }
  }

  const { buildSemanticIndex } = await import("@atlas/api/lib/semantic/search");
  const index = buildSemanticIndex(orgRoot);

  // Don't cache if sync failed — next call should retry
  if (!syncFailed) {
    _orgSemanticIndexes.set(orgId, index);
  }
  return index;
}

/** Clear all org semantic index caches. For testing. */
export function _resetOrgSemanticIndexes(): void {
  _orgSemanticIndexes.clear();
}
