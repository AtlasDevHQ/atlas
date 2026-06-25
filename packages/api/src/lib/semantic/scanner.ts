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
import { loadYaml } from "./yaml";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("semantic-scanner");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Name of the dedicated namespace directory holding non-default Connection
 * groups: `semantic/groups/<group>/…` (ADR-0012). A standalone parent keeps
 * the root unambiguous and the legacy → canonical migration mechanical.
 */
export const GROUPS_DIR = "groups";

/**
 * Directories at the semantic root that are structural, not per-source.
 * Skipped when scanning for legacy `<source>/` subdirectories.
 *
 * - `entities` — default entity directory
 * - `metrics` — default metrics directory
 * - `.orgs` — org-scoped entity storage (dual-write sync)
 * - `groups` — the canonical per-group namespace (`groups/<group>/…`),
 *   scanned explicitly below; never treated as a legacy `<source>/` dir.
 */
export const RESERVED_DIRS = new Set(["entities", "metrics", ".orgs", GROUPS_DIR]);

// ---------------------------------------------------------------------------
// Directory discovery
// ---------------------------------------------------------------------------

/**
 * Where an entity directory sits in the on-disk layout, which determines how
 * its group is resolved (ADR-0012):
 *
 * - `flat`   — root `entities/`; the default group (NULL `connection_group_id`).
 * - `group`  — `groups/<group>/entities/`; the canonical per-group namespace,
 *   where the **directory is canonical**.
 * - `legacy` — `<source>/entities/`; the pre-ADR-0012 per-source layout, kept
 *   for back-compat (retains its historical field-wins precedence).
 */
export type EntityDirOrigin = "flat" | "group" | "legacy";

export interface EntityDir {
  /** Absolute path to the entities directory. */
  dir: string;
  /** Group name: `"default"` for root `entities/`, the directory name otherwise. */
  sourceName: string;
  /** On-disk layout this directory belongs to — drives group precedence. */
  origin: EntityDirOrigin;
}

/**
 * On-disk namespace whose directory scan can fail independently of the others:
 *
 * - `groups` — the canonical `groups/<group>/` namespace (ADR-0012);
 * - `legacy` — the pre-ADR-0012 per-source `<source>/` root scan.
 *
 * Naming the namespace (instead of collapsing both catch sites into one
 * boolean) lets the escalated error say WHICH scan failed, and lets consumers
 * reason about which groups may be missing (#3243).
 */
export type ScanNamespace = "groups" | "legacy";

export interface EntityDirResult {
  dirs: EntityDir[];
  /**
   * Namespaces whose directory scan FAILED with an unexpected FS error
   * (EACCES, ENOTDIR on a symlinked/non-dir path, EMFILE/ENFILE under fd
   * pressure, EIO/stalled network mount) — all distinct from "directory
   * absent", which is guarded by `existsSync` and is NOT a failure. Empty when
   * every scan that ran succeeded.
   *
   * A non-empty list means some group/source dirs may be missing, so the
   * partition decision downstream is unreliable: consumers MUST fail closed
   * (resolve the requested group to its own — possibly empty — set) rather than
   * infer "no non-default group exists" and drop to the shared-default
   * whitelist, which would validate a connection against the WRONG group
   * (#3243). Consumers escalate this to an error-level log.
   */
  failedScans: ScanNamespace[];
}

/**
 * A per-group directory resolved by {@link getGroupDirs}, layout-aware across
 * all three on-disk layouts (ADR-0012).
 */
export interface GroupDir {
  /**
   * Absolute path to the resolved directory: `<base>/<subdir>` when a `subdir`
   * was requested, or the per-group base itself when `subdir` is `null` (for
   * artifacts that live directly in the group root — `glossary.yml`,
   * `catalog.yml`).
   */
  dir: string;
  /** Group name resolved from the directory: `"default"` for the flat root, the directory name otherwise. */
  group: string;
  /** On-disk layout this directory belongs to — drives group precedence. */
  origin: EntityDirOrigin;
}

export interface GroupDirResult {
  dirs: GroupDir[];
  /** Same fail-closed semantics as {@link EntityDirResult.failedScans}. */
  failedScans: ScanNamespace[];
}

/**
 * The shared, layout-aware traversal of a semantic root — the single source of
 * truth for the discovery read paths it backs (the SQL whitelist via
 * {@link getEntityDirs}, the lookup helpers, admin discovery, and the boot-time
 * search index), so they can't drift on the layout (ADR-0012, #3240). Read
 * paths that don't route through here (e.g. the expert/`improve` context
 * loader) are deliberately root-only.
 *
 * Resolves, in precedence order, the per-group directory for a given `subdir`
 * across all three layouts:
 *   1. flat default root → group `"default"` (origin `"flat"`);
 *   2. canonical `groups/<group>/…` → group `"<group>"` (origin `"group"`);
 *   3. legacy `<source>/…` → group `"<source>"` (origin `"legacy"`).
 *
 * `subdir` is the per-group subdirectory to resolve (e.g. `"entities"`,
 * `"metrics"`); pass `null` for artifacts that live directly in the per-group
 * root (`glossary.yml`, `catalog.yml`), which returns the per-group base dir
 * itself. Only existing directories are returned — the per-group bases returned
 * for `subdir === null` are known to exist, so the caller only needs to check
 * for the specific file (`glossary.yml` / `catalog.yml`).
 *
 * The `groups/` namespace dir is never itself treated as a legacy `<source>/`
 * (it is in {@link RESERVED_DIRS}), so no artifact is ever attributed to a
 * source literally named "groups". Also reports whether either scan failed so
 * callers can escalate severity and fail closed (#3243).
 */
export function getGroupDirs(root: string, subdir: string | null): GroupDirResult {
  const dirs: GroupDir[] = [];
  const failedScans: ScanNamespace[] = [];

  // Resolve a per-group base to its target dir: the requested subdir under the
  // base, or the base itself when the artifact lives directly in the group root.
  const resolve = (base: string): string => (subdir === null ? base : path.join(base, subdir));

  // 1. Flat default root.
  const defaultDir = resolve(root);
  if (fs.existsSync(defaultDir)) {
    dirs.push({ dir: defaultDir, group: "default", origin: "flat" });
  }

  // 2. Canonical per-group namespace: semantic/groups/<group>/… (ADR-0012).
  const groupsRoot = path.join(root, GROUPS_DIR);
  if (fs.existsSync(groupsRoot)) {
    try {
      const groupEntries = fs.readdirSync(groupsRoot, { withFileTypes: true });
      for (const entry of groupEntries) {
        if (!entry.isDirectory()) continue;
        const target = resolve(path.join(groupsRoot, entry.name));
        if (fs.existsSync(target)) {
          dirs.push({ dir: target, group: entry.name, origin: "group" });
        }
      }
    } catch (err) {
      // The dir EXISTS (existsSync above) but could not be enumerated — a real
      // FS failure (EACCES/ENOTDIR/EMFILE/EIO), not "absent". Record the failed
      // namespace so the partition decision downstream fails closed (#3243).
      failedScans.push("groups");
      log.warn(
        { root: groupsRoot, subdir, err: err instanceof Error ? err.message : String(err) },
        "Failed to scan semantic groups/ namespace — affected groups fail closed",
      );
    }
  }

  // 3. Legacy per-source layout: semantic/<source>/… (pre-ADR-0012).
  if (fs.existsSync(root)) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || RESERVED_DIRS.has(entry.name)) continue;
        const target = resolve(path.join(root, entry.name));
        if (fs.existsSync(target)) {
          dirs.push({ dir: target, group: entry.name, origin: "legacy" });
        }
      }
    } catch (err) {
      failedScans.push("legacy");
      log.warn(
        { root, subdir, err: err instanceof Error ? err.message : String(err) },
        "Failed to scan semantic root for per-source directories — affected sources fail closed",
      );
    }
  }

  return { dirs, failedScans };
}

/**
 * Discover entity directories under a semantic root.
 *
 * Returns, in precedence order:
 *   1. the default `entities/` dir (flat default group), if it exists;
 *   2. the canonical `groups/<group>/entities/` dirs (ADR-0012);
 *   3. the legacy `<source>/entities/` dirs (back-compat).
 *
 * Thin projection over {@link getGroupDirs} (the shared traversal) into the
 * entity-specific shape — `group` is surfaced as `sourceName`. Also reports
 * whether either scan failed so callers can escalate severity.
 */
export function getEntityDirs(root: string): EntityDirResult {
  const { dirs, failedScans } = getGroupDirs(root, "entities");
  return {
    dirs: dirs.map(({ dir, group, origin }) => ({ dir, sourceName: group, origin })),
    failedScans,
  };
}

// ---------------------------------------------------------------------------
// Group resolution
// ---------------------------------------------------------------------------

/**
 * Read an entity's declared group from YAML — the canonical `group:` field,
 * falling back to the deprecated `connection:` alias (ADR-0012). Returns
 * `undefined` when neither is a non-empty string.
 */
export function readGroupField(raw: { group?: unknown; connection?: unknown }): string | undefined {
  if (typeof raw.group === "string" && raw.group) return raw.group;
  if (typeof raw.connection === "string" && raw.connection) return raw.connection;
  return undefined;
}

export interface ResolvedEntityGroup {
  /** Effective Connection group: `"default"` or the group name. */
  group: string;
  /**
   * True when a declared `group:`/`connection:` field disagrees with a
   * canonical per-group directory — a foot-gun the caller should warn on.
   * Only ever set when `origin === "group"`; the flat and legacy layouts
   * let the field win, so they never report a mismatch.
   */
  mismatch: boolean;
}

/**
 * Resolve an entity's effective Connection group from its on-disk directory
 * and any declared `group:`/`connection:` field (ADR-0012).
 *
 * - Flat default root: the field is the only group signal, so it **assigns**
 *   the group (this is the override path, and the back-compat `connection:`
 *   behavior).
 * - Canonical `groups/<group>/` namespace: the **directory is canonical**. A
 *   matching field is fine; a disagreeing field is a foot-gun → the directory
 *   wins and `mismatch` is flagged so the caller can warn (never silently
 *   honored backwards).
 * - Legacy `<source>/` namespace: retains the historical field-wins precedence
 *   for back-compat until migrated into `groups/`.
 */
export function resolveEntityGroup(
  dirGroup: string,
  origin: EntityDirOrigin,
  fieldGroup: string | undefined,
): ResolvedEntityGroup {
  if (fieldGroup === undefined) return { group: dirGroup, mismatch: false };
  // Flat default root + legacy layout: the field assigns/overrides the group.
  if (origin !== "group") return { group: fieldGroup, mismatch: false };
  // Canonical namespace: directory is authoritative.
  if (fieldGroup === dirGroup) return { group: dirGroup, mismatch: false };
  return { group: dirGroup, mismatch: true };
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
    // `loadYaml` returns undefined for a document-less file (v5 throws where v4
    // returned undefined); the `!raw` guard below maps that to null, silently.
    const raw = loadYaml(fs.readFileSync(filePath, "utf-8"));
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
  /** Group name: `"default"` for root `entities/`, the directory name otherwise. */
  sourceName: string;
  /** On-disk layout this entity belongs to (ADR-0012) — drives group precedence. */
  origin: EntityDirOrigin;
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
 * Handles the default `entities/` directory, the canonical
 * `groups/<group>/entities/` namespace, and legacy `<source>/entities/`
 * subdirectories (ADR-0012). Callers project what they need from `raw`.
 */
export function scanEntities(root: string): ScanResult {
  const entities: ScannedEntity[] = [];
  const warnings: string[] = [];

  const { dirs, failedScans } = getEntityDirs(root);
  if (failedScans.length > 0) {
    warnings.push(`Failed to read semantic directory namespace(s): ${failedScans.join(", ")}`);
  }

  for (const { dir, sourceName, origin } of dirs) {
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
      entities.push({ filePath, sourceName, origin, raw });
    }
  }

  return { entities, warnings };
}
