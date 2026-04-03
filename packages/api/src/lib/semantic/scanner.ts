/**
 * Shared semantic entity scanner.
 *
 * Centralizes directory discovery and YAML parsing for entity files.
 * Three modules (files.ts, whitelist.ts, search.ts) previously each
 * implemented their own traversal; this module provides the shared
 * infrastructure so callers only need to project what they need from
 * the parsed YAML.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("semantic-scanner");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Directories at the semantic root that are structural, not per-source.
 * Skipped when scanning for source-specific subdirectories.
 *
 * - `entities` — default entity directory
 * - `metrics` — default metrics directory
 * - `.orgs` — org-scoped entity storage (dual-write sync)
 */
export const RESERVED_DIRS = new Set(["entities", "metrics", ".orgs"]);

// ---------------------------------------------------------------------------
// Directory discovery
// ---------------------------------------------------------------------------

export interface EntityDir {
  /** Absolute path to the entities directory. */
  dir: string;
  /** Source name: `"default"` for root `entities/`, subdirectory name for per-source. */
  sourceName: string;
}

export interface EntityDirResult {
  dirs: EntityDir[];
  /** True when the root directory scan failed (per-source dirs may be missing). */
  rootScanFailed: boolean;
}

/**
 * Discover entity directories under a semantic root.
 *
 * Returns the default `entities/` dir (if it exists) and any per-source
 * `{source}/entities/` dirs found under the root. Also reports whether
 * the root scan failed so callers can escalate severity as appropriate.
 */
export function getEntityDirs(root: string): EntityDirResult {
  const dirs: EntityDir[] = [];
  let rootScanFailed = false;

  const defaultDir = path.join(root, "entities");
  if (fs.existsSync(defaultDir)) {
    dirs.push({ dir: defaultDir, sourceName: "default" });
  }

  if (fs.existsSync(root)) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || RESERVED_DIRS.has(entry.name)) continue;
        const subDir = path.join(root, entry.name, "entities");
        if (fs.existsSync(subDir)) {
          dirs.push({ dir: subDir, sourceName: entry.name });
        }
      }
    } catch (err) {
      rootScanFailed = true;
      log.warn(
        { root, err: err instanceof Error ? err.message : String(err) },
        "Failed to scan semantic root for per-source directories",
      );
    }
  }

  return { dirs, rootScanFailed };
}

// ---------------------------------------------------------------------------
// YAML parsing
// ---------------------------------------------------------------------------

/**
 * Read and parse a single entity YAML file.
 *
 * Returns the parsed object, or `null` if the file cannot be read or
 * does not contain a YAML mapping.
 */
export function readEntityYaml(
  filePath: string,
): Record<string, unknown> | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const raw = yaml.load(content);
    if (!raw || typeof raw !== "object") return null;
    return raw as Record<string, unknown>;
  } catch (err) {
    log.warn(
      { filePath, err: err instanceof Error ? err.message : String(err) },
      "Failed to read or parse entity YAML",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Full scan
// ---------------------------------------------------------------------------

export interface ScannedEntity {
  /** Absolute path to the .yml file. */
  filePath: string;
  /** Source name: `"default"` for root `entities/`, subdirectory name for per-source. */
  sourceName: string;
  /** Parsed YAML content. Callers project what they need. */
  raw: Record<string, unknown>;
}

export interface ScanResult {
  entities: ScannedEntity[];
  warnings: string[];
}

/**
 * Discover and parse all entity YAML files under a semantic root.
 *
 * Handles both the default `entities/` directory and per-source
 * `{source}/entities/` subdirectories. Callers project what they need
 * from `raw`.
 */
export function scanEntities(root: string): ScanResult {
  const entities: ScannedEntity[] = [];
  const warnings: string[] = [];

  const { dirs, rootScanFailed } = getEntityDirs(root);
  if (rootScanFailed) {
    warnings.push("Failed to read semantic root directory");
  }

  for (const { dir, sourceName } of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
    } catch (err) {
      log.warn(
        { dir, err: err instanceof Error ? err.message : String(err) },
        "Failed to read entities directory",
      );
      warnings.push(`Failed to read directory: ${path.relative(root, dir)}`);
      continue;
    }

    for (const file of files) {
      const filePath = path.join(dir, file);
      const raw = readEntityYaml(filePath);
      if (raw === null) {
        warnings.push(
          `Failed to parse entity: ${path.relative(root, filePath)}`,
        );
        continue;
      }
      entities.push({ filePath, sourceName, raw });
    }
  }

  return { entities, warnings };
}
