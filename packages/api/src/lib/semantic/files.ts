/**
 * Shared semantic layer file utilities.
 *
 * Reads entity/metric/glossary YAML files from the semantic/ directory.
 * Used by both admin and public semantic API routes.
 */

import * as fs from "fs";
import * as path from "path";
import { loadYaml } from "./yaml";
import { scanEntities, getEntityDirs, resolveEntityGroup, readGroupField } from "./scanner";

// ---------------------------------------------------------------------------
// Semantic layer root
// ---------------------------------------------------------------------------

/**
 * Resolve the semantic layer root directory.
 *
 * Defaults to `{cwd}/semantic`. Override with `ATLAS_SEMANTIC_ROOT` for
 * development, testing, or non-standard directory layouts.
 */
export function getSemanticRoot(): string {
  const envRoot = process.env.ATLAS_SEMANTIC_ROOT;
  if (envRoot !== undefined) {
    if (!envRoot) {
      throw new Error(
        "ATLAS_SEMANTIC_ROOT is set but empty — remove it to use the default, or provide a path",
      );
    }
    return path.resolve(envRoot);
  }
  return path.resolve(process.cwd(), "semantic");
}

// ---------------------------------------------------------------------------
// Path traversal guard
// ---------------------------------------------------------------------------

/** Reject entity names that could escape the semantic root. */
export function isValidEntityName(name: string): boolean {
  return !!(
    name &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..") &&
    !name.includes("\0")
  );
}

// ---------------------------------------------------------------------------
// YAML reading helpers
// ---------------------------------------------------------------------------

export function readYamlFile(filePath: string): unknown {
  // `loadYaml` preserves js-yaml v4's `undefined`-on-empty behavior (v5 throws
  // on a document-less file); callers treat the missing object as a no-op.
  return loadYaml(fs.readFileSync(filePath, "utf-8"));
}

export interface EntitySummary {
  /**
   * Storage key — the YAML file stem (`audit_log` for `audit_log.yml`).
   * This is the identifier the detail/edit/delete routes look up by
   * (`getAdminEntity` → `findEntityFile` on disk, `getEntity` against the
   * `semantic_entities.name` column in the DB). #2891: keeping this
   * distinct from `displayName` so URL routing can't drift from the
   * stored row whenever a YAML's `name:` field disagrees with its filename.
   */
  name: string;
  /**
   * Display label — the YAML `name:` field if present, otherwise the
   * `table:` value. Pre-#2891 this was the only "name" surfaced and
   * doubled as the URL routing key, which 404'd on every YAML whose
   * `name:` differed from the filename. Now strictly for rendering.
   */
  displayName: string;
  table: string;
  description: string;
  columnCount: number;
  joinCount: number;
  measureCount: number;
  connection: string | null;
  type: string | null;
  source: string;
  /**
   * Effective Connection group resolved via {@link resolveEntityGroup}
   * (ADR-0012): the canonical `groups/<group>/` directory is authoritative
   * (a disagreeing `group:`/`connection:` field is ignored and warned on by
   * the whitelist), while the flat default root and legacy `<source>/` layout
   * let the field assign the group. This is the SAME key the file-based
   * whitelist scopes by (and the importer's group/legacy path), so consumers
   * (e.g. the drift snapshot reader) match entities to a connection by group
   * here rather than the raw `connection`/`source` fields, which let a stale
   * field win over the directory (#3245). NOTE: the importer's flat default
   * path still scopes by install id, not this group, so for flat entities this
   * resolves the group but the DB row's scope comes from the install lookup.
   */
  group: string;
  /**
   * Absolute path to the entity's YAML file as discovered by the scanner.
   * Threaded out of `scanEntities` so consumers (e.g. the drift snapshot
   * reader) can locate the file from the layout-aware traversal instead of
   * reconstructing a path from `source`/`table` — which silently skipped
   * the canonical `groups/<group>/entities/` namespace and broke whenever a
   * YAML's filename differed from its `table` (#3245, ADR-0012).
   */
  filePath: string;
}

/**
 * Discover all entity YAML files across the group-scoped layout (ADR-0012):
 * the flat `semantic/entities/` root, the canonical
 * `semantic/groups/<group>/entities/` namespace, and legacy
 * `semantic/<source>/entities/` subdirectories. Entities in the flat root are
 * tagged with source "default"; those under a group/legacy directory use the
 * directory name as source.
 */
interface DiscoverEntitiesResult {
  entities: EntitySummary[];
  warnings: string[];
}

export function discoverEntities(root: string): DiscoverEntitiesResult {
  const { entities: scanned, warnings } = scanEntities(root);
  const entities: EntitySummary[] = [];

  for (const { sourceName, origin, raw, filePath } of scanned) {
    if (!raw.table) {
      warnings.push(`Entity file missing required 'table' field: ${path.relative(root, filePath)}`);
      continue;
    }

    const dimensions = raw.dimensions && typeof raw.dimensions === "object"
      ? Object.keys(raw.dimensions)
      : [];
    const joins = Array.isArray(raw.joins) ? raw.joins : (raw.joins && typeof raw.joins === "object" ? Object.keys(raw.joins) : []);
    const measures = Array.isArray(raw.measures) ? raw.measures : (raw.measures && typeof raw.measures === "object" ? Object.keys(raw.measures) : []);

    const fileStem = path.basename(filePath, ".yml");
    const displayName =
      typeof raw.name === "string" && raw.name ? raw.name : String(raw.table as string);
    // Resolve the effective group directory-canonically (ADR-0012) so it
    // matches the importer + file-based whitelist; the raw `connection`/`source`
    // fields are kept for display/back-compat but must not drive scoping.
    const group = resolveEntityGroup(sourceName, origin, readGroupField(raw)).group;
    entities.push({
      name: fileStem,
      displayName,
      table: String(raw.table as string),
      description: typeof raw.description === "string" ? raw.description : "",
      columnCount: dimensions.length,
      joinCount: Array.isArray(joins) ? joins.length : 0,
      measureCount: Array.isArray(measures) ? measures.length : 0,
      connection: typeof raw.connection === "string" ? raw.connection : null,
      type: typeof raw.type === "string" ? raw.type : null,
      source: sourceName,
      group,
      filePath,
    });
  }

  return { entities, warnings };
}

// ---------------------------------------------------------------------------
// Table discovery (with columns)
// ---------------------------------------------------------------------------

import type { TableInfo, TableColumn } from "@useatlas/types";
import { tableWhitelistKeys } from "./whitelist";
export type { TableInfo };

/**
 * Discover all entity YAML files and return a simplified table view
 * with column details. Used by the public `GET /api/v1/tables` endpoint.
 */
interface DiscoverTablesResult {
  tables: TableInfo[];
  warnings: string[];
}

/**
 * Discover entity tables (with column detail) from a semantic root.
 *
 * @param root - Semantic layer root to scan (flat + group/legacy namespaces).
 * @param allowed - When provided, the **single source of truth** for which
 *   tables are queryable on the resolved connection — the SAME whitelist set
 *   `validateSQL` / `executeSQL` enforce (`getWhitelistedTables` /
 *   `getOrgWhitelistedTables`). A discovered entity is included only when one
 *   of its {@link tableWhitelistKeys} appears in this set, so the advertised
 *   list can never disagree with the enforced one (#3898). Omit it to return
 *   every discovered table unfiltered — the correct behavior only when the
 *   table whitelist is globally disabled (`ATLAS_TABLE_WHITELIST=false`), where
 *   the enforcement layer itself allows any table.
 */
export function discoverTables(root: string, allowed?: ReadonlySet<string>): DiscoverTablesResult {
  const { entities: scanned, warnings } = scanEntities(root);
  const tables: TableInfo[] = [];

  for (const { raw, filePath } of scanned) {
    if (!raw.table) {
      warnings.push(`Entity file missing required 'table' field: ${path.relative(root, filePath)}`);
      continue;
    }

    // Whitelist filter (#3898): keep only entities whose table is queryable on
    // the resolved connection. Derive the entity's whitelist keys with the SAME
    // helper the whitelist loader uses (honoring `identifier_style: opaque` for
    // Elasticsearch indices) so a discovered table matches iff the enforcement
    // layer would also accept it — `/tables` becomes a view of the whitelist,
    // never a divergent advertisement.
    if (allowed) {
      // `raw` is already `Record<string, unknown>`, so `raw.identifier_style`
      // is `unknown` — no cast needed to compare it to the opaque marker.
      const opaque = raw.identifier_style === "opaque";
      const keys = tableWhitelistKeys(String(raw.table as string), { opaque });
      if (!keys.some((k) => allowed.has(k))) continue;
    }

    const columns: TableColumn[] = [];
    const dims = raw.dimensions;
    if (dims && typeof dims === "object") {
      if (Array.isArray(dims)) {
        for (const d of dims) {
          if (d && typeof d === "object" && typeof d.name === "string") {
            columns.push({
              name: d.name,
              type: typeof d.type === "string" ? d.type : "string",
              description: typeof d.description === "string" ? d.description : "",
            });
          }
        }
      } else {
        for (const [key, val] of Object.entries(dims)) {
          const dim = val as Record<string, unknown> | undefined;
          columns.push({
            name: key,
            type: typeof dim?.type === "string" ? dim.type : "string",
            description: typeof dim?.description === "string" ? dim.description : "",
          });
        }
      }
    }

    tables.push({
      table: String(raw.table as string),
      description: typeof raw.description === "string" ? raw.description : "",
      columns,
    });
  }

  return { tables, warnings };
}

/**
 * Find a specific entity YAML file by name. Searches the flat default
 * entities/, the canonical groups/<group>/entities/ namespace, and legacy
 * <source>/entities/ subdirectories (ADR-0012).
 * Caller must validate `name` with isValidEntityName() first.
 */
export function findEntityFile(root: string, name: string): string | null {
  for (const { dir } of getEntityDirs(root).dirs) {
    const file = path.join(dir, `${name}.yml`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}
