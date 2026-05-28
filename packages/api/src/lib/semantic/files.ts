/**
 * Shared semantic layer file utilities.
 *
 * Reads entity/metric/glossary YAML files from the semantic/ directory.
 * Used by both admin and public semantic API routes.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { scanEntities, getEntityDirs } from "./scanner";

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
  const content = fs.readFileSync(filePath, "utf-8");
  return yaml.load(content);
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
}

/**
 * Discover all entity YAML files from semantic/entities/ and
 * semantic/{source}/entities/. Entities in the top-level entities/
 * directory are tagged with source "default"; those under
 * semantic/{name}/entities/ use the subdirectory name as source.
 */
interface DiscoverEntitiesResult {
  entities: EntitySummary[];
  warnings: string[];
}

export function discoverEntities(root: string): DiscoverEntitiesResult {
  const { entities: scanned, warnings } = scanEntities(root);
  const entities: EntitySummary[] = [];

  for (const { sourceName, raw, filePath } of scanned) {
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
      typeof raw.name === "string" && raw.name ? raw.name : String(raw.table);
    entities.push({
      name: fileStem,
      displayName,
      table: String(raw.table),
      description: typeof raw.description === "string" ? raw.description : "",
      columnCount: dimensions.length,
      joinCount: Array.isArray(joins) ? joins.length : 0,
      measureCount: Array.isArray(measures) ? measures.length : 0,
      connection: typeof raw.connection === "string" ? raw.connection : null,
      type: typeof raw.type === "string" ? raw.type : null,
      source: sourceName,
    });
  }

  return { entities, warnings };
}

// ---------------------------------------------------------------------------
// Table discovery (with columns)
// ---------------------------------------------------------------------------

import type { TableInfo, TableColumn } from "@useatlas/types";
export type { TableInfo };

/**
 * Discover all entity YAML files and return a simplified table view
 * with column details. Used by the public `GET /api/v1/tables` endpoint.
 */
interface DiscoverTablesResult {
  tables: TableInfo[];
  warnings: string[];
}

export function discoverTables(root: string): DiscoverTablesResult {
  const { entities: scanned, warnings } = scanEntities(root);
  const tables: TableInfo[] = [];

  for (const { raw, filePath } of scanned) {
    if (!raw.table) {
      warnings.push(`Entity file missing required 'table' field: ${path.relative(root, filePath)}`);
      continue;
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
      table: String(raw.table),
      description: typeof raw.description === "string" ? raw.description : "",
      columns,
    });
  }

  return { tables, warnings };
}

/**
 * Find a specific entity YAML file by table name. Searches default
 * entities/ and all per-source subdirectories.
 * Caller must validate `name` with isValidEntityName() first.
 */
export function findEntityFile(root: string, name: string): string | null {
  for (const { dir } of getEntityDirs(root).dirs) {
    const file = path.join(dir, `${name}.yml`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}
