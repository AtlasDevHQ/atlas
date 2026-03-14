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
export function discoverEntities(root: string): EntitySummary[] {
  const entities: EntitySummary[] = [];

  const defaultDir = path.join(root, "entities");
  if (fs.existsSync(defaultDir)) {
    loadEntitiesFromDir(defaultDir, "default", entities);
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
          loadEntitiesFromDir(subEntities, entry.name, entities);
        }
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), root }, "Failed to scan semantic root for per-source directories");
    }
  }

  return entities;
}

function loadEntitiesFromDir(dir: string, source: string, out: EntitySummary[]): void {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err : new Error(String(err)), dir, source }, "Failed to read entities directory");
    return;
  }

  for (const file of files) {
    try {
      const raw = readYamlFile(path.join(dir, file)) as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || !raw.table) continue;

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
export function discoverTables(root: string): TableInfo[] {
  const tables: TableInfo[] = [];

  const defaultDir = path.join(root, "entities");
  if (fs.existsSync(defaultDir)) {
    loadTablesFromDir(defaultDir, tables);
  }

  const RESERVED_DIRS = new Set(["entities", "metrics"]);
  if (fs.existsSync(root)) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || RESERVED_DIRS.has(entry.name)) continue;
        const subEntities = path.join(root, entry.name, "entities");
        if (fs.existsSync(subEntities)) {
          loadTablesFromDir(subEntities, tables);
        }
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err : new Error(String(err)), root }, "Failed to scan semantic root for tables");
    }
  }

  return tables;
}

function loadTablesFromDir(dir: string, out: TableInfo[]): void {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err : new Error(String(err)), dir }, "Failed to read entities directory for tables");
    return;
  }

  for (const file of files) {
    try {
      const raw = readYamlFile(path.join(dir, file)) as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || !raw.table) continue;

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
