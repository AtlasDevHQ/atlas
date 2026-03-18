/**
 * Shared semantic layer file utilities.
 *
 * Reads entity/metric/glossary YAML files from the semantic/ directory.
 * Used by both admin and public semantic API routes.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("semantic-files");

// ---------------------------------------------------------------------------
// Semantic layer root
// ---------------------------------------------------------------------------

/**
 * Resolve the semantic layer root directory.
 *
 * ATLAS_SEMANTIC_ROOT is a test-only env var; in production the semantic
 * root is always resolved from cwd.
 */
export function getSemanticRoot(): string {
  return process.env.ATLAS_SEMANTIC_ROOT ?? path.resolve(process.cwd(), "semantic");
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
  const entities: EntitySummary[] = [];
  const warnings: string[] = [];

  const defaultDir = path.join(root, "entities");
  if (fs.existsSync(defaultDir)) {
    loadEntitiesFromDir(defaultDir, "default", root, entities, warnings);
  }

  // Per-source subdirectories (e.g. semantic/warehouse/entities/)
  const RESERVED_DIRS = new Set(["entities", "metrics"]);
  if (fs.existsSync(root)) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || RESERVED_DIRS.has(entry.name)) continue;
        const subEntities = path.join(root, entry.name, "entities");
        if (fs.existsSync(subEntities)) {
          loadEntitiesFromDir(subEntities, entry.name, root, entities, warnings);
        }
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), root }, "Failed to scan semantic root for per-source directories");
      warnings.push("Failed to read semantic root directory");
    }
  }

  return { entities, warnings };
}

function loadEntitiesFromDir(dir: string, source: string, root: string, out: EntitySummary[], warnings: string[]): void {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err : new Error(String(err)), dir, source }, "Failed to read entities directory");
    warnings.push(`Failed to read directory: ${path.relative(root, dir)}`);
    return;
  }

  for (const file of files) {
    try {
      const raw = readYamlFile(path.join(dir, file)) as Record<string, unknown>;
      if (!raw || typeof raw !== "object") continue;
      if (!raw.table) {
        warnings.push(`Entity file missing required 'table' field: ${path.relative(root, path.join(dir, file))}`);
        continue;
      }

      const dimensions = raw.dimensions && typeof raw.dimensions === "object"
        ? Object.keys(raw.dimensions)
        : [];
      const joins = Array.isArray(raw.joins) ? raw.joins : (raw.joins && typeof raw.joins === "object" ? Object.keys(raw.joins) : []);
      const measures = Array.isArray(raw.measures) ? raw.measures : (raw.measures && typeof raw.measures === "object" ? Object.keys(raw.measures) : []);

      out.push({
        table: String(raw.table),
        description: typeof raw.description === "string" ? raw.description : "",
        columnCount: dimensions.length,
        joinCount: Array.isArray(joins) ? joins.length : 0,
        measureCount: Array.isArray(measures) ? measures.length : 0,
        connection: typeof raw.connection === "string" ? raw.connection : null,
        type: typeof raw.type === "string" ? raw.type : null,
        source,
      });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), file, dir, source }, "Failed to parse entity YAML file");
      warnings.push(`Failed to parse entity: ${path.relative(root, path.join(dir, file))}`);
    }
  }
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
  const tables: TableInfo[] = [];
  const warnings: string[] = [];

  const defaultDir = path.join(root, "entities");
  if (fs.existsSync(defaultDir)) {
    loadTablesFromDir(defaultDir, root, tables, warnings);
  }

  const RESERVED_DIRS = new Set(["entities", "metrics"]);
  if (fs.existsSync(root)) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || RESERVED_DIRS.has(entry.name)) continue;
        const subEntities = path.join(root, entry.name, "entities");
        if (fs.existsSync(subEntities)) {
          loadTablesFromDir(subEntities, root, tables, warnings);
        }
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), root }, "Failed to scan semantic root for tables");
      warnings.push("Failed to read semantic root directory");
    }
  }

  return { tables, warnings };
}

function loadTablesFromDir(dir: string, root: string, out: TableInfo[], warnings: string[]): void {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err : new Error(String(err)), dir }, "Failed to read entities directory for tables");
    warnings.push(`Failed to read directory: ${path.relative(root, dir)}`);
    return;
  }

  for (const file of files) {
    try {
      const raw = readYamlFile(path.join(dir, file)) as Record<string, unknown>;
      if (!raw || typeof raw !== "object") continue;
      if (!raw.table) {
        warnings.push(`Entity file missing required 'table' field: ${path.relative(root, path.join(dir, file))}`);
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

      out.push({
        table: String(raw.table),
        description: typeof raw.description === "string" ? raw.description : "",
        columns,
      });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), file, dir }, "Failed to parse entity YAML for tables");
      warnings.push(`Failed to parse entity: ${path.relative(root, path.join(dir, file))}`);
    }
  }
}

/**
 * Find a specific entity YAML file by table name. Searches default
 * entities/ and all per-source subdirectories.
 * Caller must validate `name` with isValidEntityName() first.
 */
export function findEntityFile(root: string, name: string): string | null {
  const defaultDir = path.join(root, "entities");
  const defaultFile = path.join(defaultDir, `${name}.yml`);
  if (fs.existsSync(defaultFile)) return defaultFile;

  // Search per-source subdirectories
  const RESERVED_DIRS = new Set(["entities", "metrics"]);
  if (fs.existsSync(root)) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || RESERVED_DIRS.has(entry.name)) continue;
        const subFile = path.join(root, entry.name, "entities", `${name}.yml`);
        if (fs.existsSync(subFile)) return subFile;
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), root, name }, "Failed to scan subdirectories for entity file");
    }
  }

  return null;
}
