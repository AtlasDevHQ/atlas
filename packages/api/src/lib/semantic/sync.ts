/**
 * Dual-write sync layer for org-scoped semantic layers.
 *
 * Maintains persistent per-org directories at `{semanticRoot}/.orgs/{orgId}/`
 * that mirror the `semantic_entities` DB table. The DB is the source of
 * truth; the disk is a persistent cache consumed by the explore tool
 * (the agent navigates the semantic layer via filesystem commands like
 * `ls`, `cat`, and `grep`).
 *
 * Two sync directions:
 * - DB → disk (#522): admin API entity CRUD writes DB first, then syncs to disk
 * - disk → DB (#523): `atlas init` / import writes disk first, then imports to DB
 *
 * File writes use atomic write-to-temp + rename to prevent partial reads.
 */

import * as fs from "fs";
import * as path from "path";
import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { loadYaml } from "./yaml";
import { getSemanticRoot as getBaseSemanticRoot } from "./files";
import { GROUPS_DIR } from "./scanner";

const log = createLogger("semantic-sync");

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the semantic root for a given org.
 *
 * - With orgId + mode: `{semanticRoot}/.orgs/{orgId}/modes/{mode}/` —
 *   mode-specific view built lazily by `ensureOrgModeSemanticRoot()`.
 *   Used by the agent's `explore` tool so published-mode users see only
 *   published entities and developer-mode users see the draft overlay.
 * - With orgId only: `{semanticRoot}/.orgs/{orgId}/` — the legacy
 *   all-content directory used by the CLI and write-path sync operations.
 * - Without orgId: the base semantic root (defaults to `{cwd}/semantic`,
 *   overridable via `ATLAS_SEMANTIC_ROOT`).
 *
 * Validates orgId against path traversal — rejects values containing
 * path separators or `..` components.
 */
export function getSemanticRoot(
  orgId?: string,
  mode?: import("@useatlas/types/auth").AtlasMode,
): string {
  const base = getBaseSemanticRoot();
  if (!orgId) return base;
  const safe = path.basename(orgId);
  if (safe !== orgId || orgId === "." || orgId === "..") {
    throw new Error(`Invalid orgId for semantic root: "${orgId}"`);
  }
  const orgRoot = path.join(base, ".orgs", safe);
  if (!mode) return orgRoot;
  return path.join(orgRoot, "modes", mode);
}

// ---------------------------------------------------------------------------
// Atomic file operations
// ---------------------------------------------------------------------------

/**
 * Write a file atomically: write to a temp file in the same directory,
 * then rename (atomic on POSIX — same filesystem). Prevents partial reads
 * by concurrent explore commands.
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${Date.now()}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmp, content, "utf-8");
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      await fs.promises.unlink(tmp);
    } catch {
      // Temp file may not exist if writeFile failed
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Entity type → directory mapping
// ---------------------------------------------------------------------------

type SemanticEntityType = "entity" | "metric" | "glossary" | "catalog";

/** Map entity type to its subdirectory within the semantic root. */
function entityTypeDir(type: SemanticEntityType): string {
  switch (type) {
    case "entity": return "entities";
    case "metric": return "metrics";
    case "glossary": return ""; // glossary files live at the root
    case "catalog": return ""; // catalog.yml lives at the root
  }
}

/** Sanitize a name for safe use in file paths (strip traversal chars). */
function safeName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/**
 * True when `value` is safe as a single path segment — no separators or `..`
 * traversal that could escape the semantic root. Mirrors the generator's
 * `assertSafePathSegment` (profiler.ts) but returns a boolean so the
 * best-effort DB→disk writers can skip an unsafe row rather than aborting the
 * whole rebuild.
 */
function isSafePathSegment(value: string): boolean {
  return (
    value === path.basename(value) &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

/**
 * Resolve an entity's path within `root`, honoring its Connection group
 * (ADR-0012, #3275). A non-default group is laid into the canonical
 * `groups/<group>/<subdir>/` namespace so same-stem entities in different
 * groups don't collide on a flat `<subdir>/<name>.yml` (whichever wrote last
 * used to win, silently dropping the other group's YAML from the explore view).
 * The default group (`null` / `undefined` / `"default"`) stays flat at the
 * root, unchanged.
 *
 * Returns `null` when the group is an unsafe path segment — the caller skips
 * the row rather than letting a crafted group escape `root`.
 */
function entityPathInRoot(
  root: string,
  name: string,
  type: SemanticEntityType,
  connectionGroupId?: string | null,
): string | null {
  const subdir = entityTypeDir(type);
  const fileName = `${safeName(name)}.yml`;
  const group =
    connectionGroupId && connectionGroupId !== "default" ? connectionGroupId : null;
  if (group && !isSafePathSegment(group)) return null;
  const base = group ? path.join(root, GROUPS_DIR, group) : root;
  return subdir ? path.join(base, subdir, fileName) : path.join(base, fileName);
}

/** Resolve the full file path for an entity on disk (group-aware, #3275). */
function entityFilePath(
  orgId: string,
  name: string,
  type: SemanticEntityType,
  connectionGroupId?: string | null,
): string | null {
  return entityPathInRoot(getSemanticRoot(orgId), name, type, connectionGroupId);
}

// ---------------------------------------------------------------------------
// Single-entity sync (DB → disk)
// ---------------------------------------------------------------------------

/**
 * Sync a single entity from DB to disk (atomic write).
 * Called from admin CRUD routes after a successful DB write.
 */
export async function syncEntityToDisk(
  orgId: string,
  name: string,
  type: SemanticEntityType,
  yamlContent: string,
  connectionGroupId?: string | null,
): Promise<void> {
  const filePath = entityFilePath(orgId, name, type, connectionGroupId);
  if (filePath === null) {
    log.error(
      { orgId, name, type, connectionGroupId },
      "Refusing to sync entity to disk — group is an unsafe path segment",
    );
    return;
  }
  try {
    await atomicWriteFile(filePath, yamlContent);
    log.debug({ orgId, name, type, filePath }, "Synced entity to disk");
  } catch (err) {
    log.error(
      { orgId, name, type, filePath, err: errorMessage(err) },
      "Failed to sync entity to disk — DB is authoritative, disk may be stale",
    );
    // Don't re-throw — DB write already succeeded, disk sync failure is
    // recoverable via boot reconciliation
  }
}

/**
 * Delete a single entity file from disk.
 * Called from admin CRUD routes after a successful DB delete.
 */
export async function syncEntityDeleteFromDisk(
  orgId: string,
  name: string,
  type: SemanticEntityType,
  connectionGroupId?: string | null,
): Promise<void> {
  const filePath = entityFilePath(orgId, name, type, connectionGroupId);
  if (filePath === null) {
    log.error(
      { orgId, name, type, connectionGroupId },
      "Refusing to delete entity from disk — group is an unsafe path segment",
    );
    return;
  }
  try {
    await fs.promises.unlink(filePath);
    log.debug({ orgId, name, type, filePath }, "Deleted entity from disk");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File already gone — that's fine
      return;
    }
    log.error(
      { orgId, name, type, filePath, err: errorMessage(err) },
      "Failed to delete entity from disk",
    );
  }
}

// ---------------------------------------------------------------------------
// Full org rebuild (DB → disk)
// ---------------------------------------------------------------------------

/**
 * Per-org mutex to prevent concurrent full rebuilds from interleaving
 * with each other. Single-file writes (syncEntityToDisk) are not
 * serialized by this lock — atomicWriteFile provides per-file safety.
 */
const _rebuildLocks = new Map<string, Promise<void>>();

/**
 * Rebuild the entire org directory from DB entities.
 * Used for boot reconciliation, import, and first-boot.
 *
 * Acquires a per-org lock to prevent interleaving with concurrent
 * single-file syncs.
 */
export async function syncAllEntitiesToDisk(orgId: string): Promise<number> {
  // Per-org mutex: wait for any in-progress rebuild, then start ours
  const existing = _rebuildLocks.get(orgId);
  if (existing) {
    await existing.catch((err) => {
      log.debug(
        { orgId, err: errorMessage(err) },
        "Prior rebuild for org failed — proceeding with fresh rebuild attempt",
      );
    });
  }

  let resolve: () => void;
  const lock = new Promise<void>((r) => { resolve = r; });
  _rebuildLocks.set(orgId, lock);

  try {
    return await _doSyncAllEntitiesToDisk(orgId);
  } finally {
    resolve!();
    _rebuildLocks.delete(orgId);
  }
}

async function _doSyncAllEntitiesToDisk(orgId: string): Promise<number> {
  const { listEntityRows } = await import("@atlas/api/lib/semantic/entities");
  const rows = await listEntityRows(orgId);

  const root = getSemanticRoot(orgId);

  // Ensure directories exist
  await Promise.all([
    fs.promises.mkdir(path.join(root, "entities"), { recursive: true }),
    fs.promises.mkdir(path.join(root, "metrics"), { recursive: true }),
  ]);

  // Build a set of expected files so we can clean up stale ones
  const expectedFiles = new Set<string>();

  let synced = 0;
  for (const row of rows) {
    const filePath = entityPathInRoot(
      root,
      row.name,
      row.entity_type as SemanticEntityType,
      row.connection_group_id,
    );
    if (filePath === null) {
      log.error(
        { orgId, name: row.name, type: row.entity_type, group: row.connection_group_id },
        "Skipping entity during full sync — group is an unsafe path segment",
      );
      continue;
    }
    expectedFiles.add(filePath);
    try {
      await atomicWriteFile(filePath, row.yaml_content);
      synced++;
    } catch (err) {
      log.error(
        { orgId, name: row.name, type: row.entity_type, err: errorMessage(err) },
        "Failed to write entity during full sync",
      );
    }
  }

  // Remove stale files that are no longer in DB
  await _cleanStaleFiles(root, expectedFiles);

  if (synced < rows.length) {
    log.warn(
      { orgId, synced, total: rows.length, failed: rows.length - synced },
      "Full sync completed with failures — some entities may not be visible to explore tool",
    );
  } else {
    log.info({ orgId, synced, total: rows.length }, "Full sync to disk complete");
  }
  return synced;
}

/**
 * Remove .yml files under the org root that aren't in the expected set.
 * Handles entities/ and metrics/ subdirs, plus root-level glossary/catalog.
 */
async function _cleanStaleFiles(root: string, expectedFiles: Set<string>): Promise<void> {
  const dirs = [
    path.join(root, "entities"),
    path.join(root, "metrics"),
    root, // for glossary.yml, catalog.yml
  ];

  // Group namespace (ADR-0012, #3275): each groups/<group>/ holds its own
  // entities/ + metrics/ subdirs plus a group-level glossary.yml/catalog.yml.
  // Scan them too, else a group entity removed from the DB would linger on
  // disk and keep shadowing the explore view after the rebuild.
  const groupsRoot = path.join(root, GROUPS_DIR);
  try {
    const groupEntries = await fs.promises.readdir(groupsRoot, { withFileTypes: true });
    for (const entry of groupEntries) {
      if (!entry.isDirectory()) continue;
      const groupDir = path.join(groupsRoot, entry.name);
      dirs.push(path.join(groupDir, "entities"), path.join(groupDir, "metrics"), groupDir);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn({ groupsRoot, err: errorMessage(err) }, "Failed to scan groups/ namespace for stale files");
    }
  }

  for (const dir of dirs) {
    try {
      const entries = await fs.promises.readdir(dir);
      for (const entry of entries) {
        if (!entry.endsWith(".yml")) continue;
        const fullPath = path.join(dir, entry);
        if (!expectedFiles.has(fullPath)) {
          try {
            await fs.promises.unlink(fullPath);
            log.debug({ path: fullPath }, "Removed stale entity file");
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
              log.warn({ path: fullPath, err: errorMessage(err) }, "Failed to remove stale file");
            }
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn({ dir, err: errorMessage(err) }, "Failed to scan directory for stale files");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Org directory cleanup
// ---------------------------------------------------------------------------

/**
 * Remove an org's entire semantic directory.
 * Called when an org is deleted.
 */
export async function cleanupOrgDirectory(orgId: string): Promise<void> {
  const root = getSemanticRoot(orgId);
  try {
    await fs.promises.rm(root, { recursive: true, force: true });
    log.info({ orgId, path: root }, "Cleaned up org semantic directory");
  } catch (err) {
    log.error(
      { orgId, path: root, err: errorMessage(err) },
      "Failed to clean up org directory",
    );
  }
}

// ---------------------------------------------------------------------------
// Mode-specific semantic root (agent isolation)
// ---------------------------------------------------------------------------

/**
 * Per-org, per-mode build locks so concurrent agent requests for the same
 * (orgId, mode) share a single build rather than rebuilding in parallel.
 */
const _modeBuildLocks = new Map<string, Promise<void>>();

/** Track which (orgId, mode) directories have already been built this process. */
const _modeBuilt = new Set<string>();

/**
 * Monotonic invalidation counter per (orgId, mode). Incremented by
 * `invalidateOrgModeRoots` so an in-flight build started before the
 * invalidation does NOT mark the now-stale content as fresh.
 */
const _modeInvalidationStamp = new Map<string, number>();

function modeKey(orgId: string, mode: import("@useatlas/types/auth").AtlasMode): string {
  return `${orgId}:${mode}`;
}

/**
 * Invalidate the cached mode-specific semantic roots for an org.
 * Called from entity CRUD paths so the next explore call rebuilds from DB.
 *
 * Increments the per-(org,mode) invalidation stamp so any currently-running
 * rebuild will not add its key to `_modeBuilt` after completion — the next
 * call rebuilds instead of serving stale files.
 */
export function invalidateOrgModeRoots(orgId: string): void {
  for (const mode of ["published", "developer"] as const) {
    const key = modeKey(orgId, mode);
    _modeBuilt.delete(key);
    _modeInvalidationStamp.set(key, (_modeInvalidationStamp.get(key) ?? 0) + 1);
  }
}

/**
 * Ensure the mode-specific semantic root exists on disk for the agent's
 * explore tool. Mode isolation guarantee: published-mode users see only
 * published entities, developer-mode users see the draft overlay (drafts
 * supersede published, tombstones hide targets, archived-connection entities
 * excluded) — same semantics as `loadOrgWhitelist`.
 *
 * Build is lazy: if the directory has not been populated this process (or
 * was invalidated by entity CRUD), rebuild from DB. Subsequent calls are a
 * no-op.
 *
 * Returns the resolved directory path.
 */
export async function ensureOrgModeSemanticRoot(
  orgId: string,
  mode: import("@useatlas/types/auth").AtlasMode,
): Promise<string> {
  const root = getSemanticRoot(orgId, mode);
  const key = modeKey(orgId, mode);
  if (_modeBuilt.has(key)) return root;

  // Coalesce concurrent builds. If another caller is already building, wait
  // and then re-check `_modeBuilt` — the in-flight build may have been
  // invalidated mid-flight or failed per-file writes, in which case the
  // waiter must itself rebuild instead of returning a stale root.
  const existing = _modeBuildLocks.get(key);
  if (existing) {
    await existing;
    if (_modeBuilt.has(key)) return root;
    return ensureOrgModeSemanticRoot(orgId, mode);
  }

  let resolve: () => void;
  const lock = new Promise<void>((r) => { resolve = r; });
  _modeBuildLocks.set(key, lock);

  // Capture the invalidation stamp before building. If it advances during the
  // build, an entity CRUD happened mid-build — the content we just wrote is
  // stale. Leave _modeBuilt unset so the next call rebuilds.
  const stampBefore = _modeInvalidationStamp.get(key) ?? 0;
  try {
    const result = await _buildOrgModeRoot(orgId, mode, root);
    const stampAfter = _modeInvalidationStamp.get(key) ?? 0;
    // Mark as built only if BOTH: (a) stamp did not advance (no CRUD raced),
    // and (b) every entity wrote successfully. Partial writes leave the
    // directory in an undefined state that must not be trusted.
    if (stampAfter === stampBefore && result.failed === 0) {
      _modeBuilt.add(key);
    } else {
      log.debug(
        { orgId, mode, stampBefore, stampAfter, failed: result.failed },
        "Mode-specific semantic root build incomplete — next call will rebuild",
      );
    }
  } finally {
    resolve!();
    _modeBuildLocks.delete(key);
  }

  return root;
}

/** Rebuild the mode-specific directory from DB using the mode-appropriate loader. */
async function _buildOrgModeRoot(
  orgId: string,
  mode: import("@useatlas/types/auth").AtlasMode,
  root: string,
): Promise<{ written: number; failed: number }> {
  const { listEntityRows, listEntitiesWithOverlay } = await import("@atlas/api/lib/semantic/entities");

  const rows = mode === "published"
    ? await listEntityRows(orgId, undefined, "published")
    : await listEntitiesWithOverlay(orgId);

  await Promise.all([
    fs.promises.mkdir(path.join(root, "entities"), { recursive: true }),
    fs.promises.mkdir(path.join(root, "metrics"), { recursive: true }),
  ]);

  const expectedFiles = new Set<string>();
  let written = 0;
  let failed = 0;
  for (const row of rows) {
    const filePath = entityPathInRoot(
      root,
      row.name,
      row.entity_type as SemanticEntityType,
      row.connection_group_id,
    );
    if (filePath === null) {
      failed++;
      log.error(
        { orgId, mode, name: row.name, type: row.entity_type, group: row.connection_group_id },
        "Skipping mode-specific entity file — group is an unsafe path segment",
      );
      continue;
    }
    expectedFiles.add(filePath);
    try {
      await atomicWriteFile(filePath, row.yaml_content);
      written++;
    } catch (err) {
      failed++;
      log.error(
        { orgId, mode, name: row.name, type: row.entity_type, err: errorMessage(err) },
        "Failed to write mode-specific entity file",
      );
    }
  }

  await _cleanStaleFiles(root, expectedFiles);

  // Knowledge Base OKF-native serving (#4208, ADR-0028 §3): mirror hosted
  // knowledge collections into `{root}/knowledge/` as a sibling of the entity
  // subtrees, using the SAME mode→status visibility. Folded into this build so
  // the shared lazy-build + invalidation machinery (`ensureOrgModeSemanticRoot`
  // / `invalidateOrgModeRoots`) covers knowledge too. Deliberately does NOT feed
  // the `failed` counter that gates `_modeBuilt`: knowledge is a separate,
  // descriptive-only subtree, so a knowledge-mirror failure must not force the
  // ENTITY mode-root to rebuild on every explore call (that would break the
  // build-coalescing the entity hot path relies on). A transient knowledge
  // failure is logged and self-heals on the next invalidation (any knowledge
  // mutation busts the cache). Dynamic import keeps the internal-DB + knowledge
  // graph out of this module's static load path (same posture as the loaders
  // above).
  try {
    const { mirrorKnowledgeToDisk } = await import("@atlas/api/lib/knowledge/mirror");
    await mirrorKnowledgeToDisk(orgId, mode, root);
  } catch (err) {
    // warn, not error: knowledge is descriptive-only and non-blocking, and this
    // degradation self-heals on the next invalidation — it must not trip
    // error-rate alerting the way an entity-serving failure should.
    log.warn(
      { orgId, mode, err: errorMessage(err) },
      "Failed to mirror knowledge collections — entity serving unaffected, knowledge subtree may be stale until the next rebuild",
    );
  }

  log.info(
    { orgId, mode, entityCount: rows.length, written, failed, path: root },
    "Built mode-specific semantic root",
  );

  return { written, failed };
}

/** @internal Clear the mode-built cache — for testing only. */
export function _resetModeBuildCache(): void {
  _modeBuilt.clear();
  _modeBuildLocks.clear();
  _modeInvalidationStamp.clear();
}

// ---------------------------------------------------------------------------
// Disk → DB import
// ---------------------------------------------------------------------------

interface ImportError {
  file: string;
  reason: string;
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors: ImportError[];
  total: number;
  /**
   * Entities that passed YAML validation but failed the DB upsert
   * (`entities.length - imported`). Distinct from `skipped`, which also folds in
   * benign YAML-parse errors and lower-precedence duplicate drops. Callers that
   * require an all-or-nothing import (the /use-demo seed, #3683) treat
   * `dbFailures > 0` as a hard failure instead of a clean partial. On the
   * transactional path this is always 0 — the first failure rolls the batch
   * back before `importFromDisk` returns.
   */
  dbFailures: number;
}

/**
 * A row staged for `bulkUpsertEntities`. At most one of `connectionId` /
 * `connectionGroupId` is set (never both); the PRESENCE of `connectionGroupId`
 * (even `null`) is what routes a row to the direct-group upsert. Flat default +
 * metrics/glossary carry `connectionId` (resolved to a group via the install-id
 * lookup) — frequently `undefined` for self-hosted, which resolves to the NULL
 * default group. Group-scoped entities (`groups/<group>/`, legacy `<source>/`)
 * carry their directory group directly in `connectionGroupId` (#3245, ADR-0012).
 */
type CollectedEntity = {
  entityType: SemanticEntityType;
  name: string;
  yamlContent: string;
  connectionId?: string;
  connectionGroupId?: string | null;
};

/**
 * Import YAML files from an org's disk directory into the DB.
 *
 * Scans `{orgRoot}/entities/*.yml`, `metrics/*.yml`, and
 * `glossary.yml`. Each file is validated, then upserted via
 * `bulkUpsertEntities()`. Invalid files are skipped with per-file
 * error reporting.
 *
 * Also accepts a `sourceDir` override for importing from a non-org
 * directory (e.g. self-hosted `semantic/` root during migration).
 */
export async function importFromDisk(
  orgId: string,
  options?: {
    connectionId?: string;
    sourceDir?: string;
    /**
     * Transaction-bound executor (from {@link withDemoSeedLock}) that threads
     * every entity upsert onto a single transaction connection so the import
     * commits atomically with the caller's other writes (the /use-demo seed,
     * #3683). Omit for the standalone pooled path (admin import, auth migrate),
     * where partial imports are tolerated and counted via `dbFailures`.
     */
    exec?: import("@atlas/api/lib/db/internal").InternalQueryExecutor;
    /**
     * Content-mode status for the imported rows. Defaults to `draft` (the
     * admin-import / auth-migrate "review-then-publish" workflow). The /use-demo
     * seed passes `published` so the curated, read-only demo layer is queryable
     * in published mode for a fresh signup (#3932).
     */
    status?: "draft" | "published";
  },
): Promise<ImportResult> {
  const { bulkUpsertEntities } = await import("@atlas/api/lib/semantic/entities");
  const { invalidateOrgWhitelist } = await import("@atlas/api/lib/semantic");

  const root = options?.sourceDir ?? getSemanticRoot(orgId);
  const errors: ImportError[] = [];
  const entities: CollectedEntity[] = [];

  // Scan entities across the full group-scoped layout (ADR-0012): the flat
  // default `entities/`, the canonical `groups/<group>/entities/` namespace,
  // and legacy `<source>/entities/`. Hardcoding `root/entities` skipped grouped
  // entities entirely, so the DB-backed whitelist/admin view was empty for
  // those groups even though the file-based whitelist read them (#3245).
  const { duplicateSkips } = await _scanEntityDirs(root, entities, errors, options?.connectionId);

  // Scan metrics/*.yml — metrics group-namespace traversal is out of scope
  // here (#3240), so metrics stay flat + scoped by the install id.
  const metricsDir = path.join(root, "metrics");
  await _scanYamlDir(metricsDir, "metric", entities, errors, options?.connectionId);

  // Scan glossary.yml at root
  const glossaryPath = path.join(root, "glossary.yml");
  try {
    const content = await fs.promises.readFile(glossaryPath, "utf-8");
    try {
      loadYaml(content); // validate parseable (undefined for an empty glossary, as in v4)
      entities.push({
        entityType: "glossary",
        name: "glossary",
        yamlContent: content,
        connectionId: options?.connectionId,
      });
    } catch (err) {
      errors.push({ file: "glossary.yml", reason: `Invalid YAML: ${errorMessage(err)}` });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push({ file: "glossary.yml", reason: errorMessage(err) });
    }
    // ENOENT is fine — glossary is optional
  }

  // `total` and `skipped` count every file the scan considered, including
  // lower-precedence duplicates dropped by `_scanEntityDirs` — otherwise a
  // canonical+legacy overlap would report `{ imported: 1, skipped: 0, total: 1 }`
  // despite two YAML files being scanned (CodeRabbit review).
  const total = entities.length + errors.length + duplicateSkips;

  if (entities.length === 0) {
    return { imported: 0, skipped: errors.length + duplicateSkips, errors, total, dbFailures: 0 };
  }

  let imported: number;
  try {
    // On the transactional path (`options.exec` set) this throws on the first
    // row failure so the enclosing transaction rolls back — `dbFailures` below
    // is then unreachable and always 0 on the value that does return (#3683).
    imported = await bulkUpsertEntities(orgId, entities, options?.exec, options?.status ?? "draft");
  } finally {
    // Always invalidate — partial writes may have occurred
    invalidateOrgWhitelist(orgId);
  }

  const dbFailures = entities.length - imported;
  if (dbFailures > 0) {
    log.warn(
      { orgId, dbFailures, imported, yamlErrors: errors.length },
      "Some entities passed YAML validation but failed DB upsert",
    );
  }

  const skipped = errors.length + dbFailures + duplicateSkips;
  log.info(
    { orgId, imported, skipped, duplicateSkips, total },
    "Imported semantic entities from disk to DB",
  );

  return {
    imported,
    skipped,
    errors,
    total,
    dbFailures,
  };
}

/** Scan a directory of .yml files and collect valid entities. */
async function _scanYamlDir(
  dir: string,
  entityType: SemanticEntityType,
  out: CollectedEntity[],
  errors: ImportError[],
  connectionId?: string,
): Promise<void> {
  let files: string[];
  try {
    files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".yml"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // dir doesn't exist — fine
    errors.push({ file: dir, reason: errorMessage(err) });
    return;
  }

  for (const file of files) {
    const filePath = path.join(dir, file);
    const name = file.replace(/\.yml$/, "");
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const parsed = loadYaml(content);

      // Validate entities have a table field
      if (entityType === "entity") {
        if (!parsed || typeof parsed !== "object" || !("table" in (parsed as Record<string, unknown>))) {
          errors.push({ file, reason: "Entity YAML must contain a 'table' field" });
          continue;
        }
      }

      out.push({ entityType, name, yamlContent: content, connectionId });
    } catch (err) {
      errors.push({ file, reason: errorMessage(err) });
    }
  }
}

/**
 * Scan every entity directory under a semantic root — the flat default
 * `entities/`, the canonical `groups/<group>/entities/` namespace, and legacy
 * `<source>/entities/` (ADR-0012) — collecting valid entity rows for import.
 *
 * Uses the same shared traversal (`getEntityDirs`) as the file-based whitelist
 * and entity loader so the DB-backed whitelist can't drift from the on-disk
 * one. The directory's group (resolved via {@link resolveEntityGroup}, with the
 * canonical directory authoritative and a disagreeing `group:`/`connection:`
 * field flagged) is carried into `connection_group_id` for group/legacy dirs.
 *
 * The flat default dir keeps the legacy install-id resolution path: its rows
 * carry `defaultConnectionId` (e.g. demo's `__demo__`) so existing demo/wizard
 * scoping is unchanged (#3245).
 */
async function _scanEntityDirs(
  root: string,
  out: CollectedEntity[],
  errors: ImportError[],
  defaultConnectionId?: string,
): Promise<{ duplicateSkips: number }> {
  let duplicateSkips = 0;
  const { getEntityDirs, resolveEntityGroup, readGroupField } = await import("./scanner");
  const { dirs, failedScans } = getEntityDirs(root);
  if (failedScans.length > 0) {
    // Surface a partial-scan failure as a per-namespace import error rather
    // than silently importing a subset — a failed groups/ scan means some
    // grouped entities may be missing from the DB whitelist.
    errors.push({
      file: root,
      reason: `Failed to scan semantic directory namespace(s): ${failedScans.join(", ")}`,
    });
  }

  // Track (group, name) pairs already collected from a group/legacy dir.
  // `getEntityDirs` orders canonical `groups/<group>/` BEFORE legacy
  // `<source>/`, so the canonical entry is seen first and a same-name/same-group
  // legacy duplicate (mid-migration overlap) is skipped — otherwise the stale
  // legacy YAML would upsert LAST into the shared
  // `(org, type, name, connection_group_id)` draft row and overwrite the
  // canonical file that should win (ADR-0012: directory canonical). Codex review.
  const seenGroupKeys = new Set<string>();

  for (const { dir, sourceName, origin } of dirs) {
    let files: string[];
    try {
      files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".yml"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // dir vanished — fine
      errors.push({ file: dir, reason: errorMessage(err) });
      continue;
    }

    for (const file of files) {
      const filePath = path.join(dir, file);
      const name = file.replace(/\.yml$/, "");
      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        const parsed = loadYaml(content);

        if (!parsed || typeof parsed !== "object" || !("table" in (parsed as Record<string, unknown>))) {
          errors.push({ file, reason: "Entity YAML must contain a 'table' field" });
          continue;
        }

        if (origin === "flat") {
          // Flat default group — preserve the install-id resolution path so
          // demo/wizard scoping is unchanged.
          out.push({ entityType: "entity", name, yamlContent: content, connectionId: defaultConnectionId });
        } else {
          // Group-scoped (canonical `groups/<group>/` or legacy `<source>/`):
          // the directory is the group, set connection_group_id directly.
          const fieldGroup = readGroupField(parsed as { group?: unknown; connection?: unknown });
          const { group, mismatch } = resolveEntityGroup(sourceName, origin, fieldGroup);
          if (mismatch) {
            log.warn(
              { file, dir, directoryGroup: sourceName, declaredGroup: fieldGroup },
              "Import: entity declares a group that differs from its directory — honoring the directory (ADR-0012)",
            );
          }
          // Use NUL as the separator — it can't appear in a group name or file
          // stem, so the key can't be forged by a crafted name.
          const groupKey = `${group}\0${name}`;
          if (seenGroupKeys.has(groupKey)) {
            duplicateSkips++;
            log.warn(
              { file, dir, group, name, origin },
              "Import: duplicate entity for the same group already collected from a higher-precedence directory — skipping (ADR-0012: canonical groups/ wins over legacy)",
            );
            continue;
          }
          seenGroupKeys.add(groupKey);
          out.push({ entityType: "entity", name, yamlContent: content, connectionGroupId: group });
        }
      } catch (err) {
        errors.push({ file, reason: errorMessage(err) });
      }
    }
  }

  return { duplicateSkips };
}

// ---------------------------------------------------------------------------
// Boot reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile all orgs: for each org with DB entities, ensure the disk
 * directory exists and is populated. Called at server boot.
 *
 * Non-blocking — logs errors but does not throw.
 */
export async function reconcileAllOrgs(): Promise<void> {
  try {
    const { hasInternalDB } = await import("@atlas/api/lib/db/internal");
    if (!hasInternalDB()) return;

    const { internalQuery } = await import("@atlas/api/lib/db/internal");
    let orgs: Array<{ org_id: string }>;
    try {
      orgs = await internalQuery<{ org_id: string }>(
        "SELECT DISTINCT org_id FROM semantic_entities",
      );
    } catch (err) {
      // @atlas-ok-ternary: msg is substring-matched on "does not exist" / "no such table"
      // — errorMessage() would scrub+truncate, altering match semantics.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("does not exist") || msg.includes("no such table")) {
        log.info("semantic_entities table not found — first boot before migration, skipping reconciliation");
        return;
      }
      throw err; // re-throw unexpected DB errors
    }

    if (orgs.length === 0) {
      // Check for first-boot auto-import: disk files exist but DB is empty.
      // This handles self-hosted → managed migration and atlas init before
      // the import endpoint existed.
      await _autoImportOrgsFromDisk();
      return;
    }

    log.info({ orgCount: orgs.length }, "Starting boot reconciliation for org semantic layers");

    // Always rebuild — `syncAllEntitiesToDisk` writes idempotent atomic
    // copies of every DB row AND runs `_cleanStaleFiles` to remove disk
    // YAMLs that no longer have a matching DB row. The previous
    // "skip if dir is populated" branch let orphan files (e.g. an early
    // `atlas init` against the internal DB whose entries were never
    // backfilled into `semantic_entities`) live on the mirror forever,
    // surfacing in the admin file tree as ghost duplicates of the real
    // DB-backed entities. Cost is bounded — atomic writes are cheap and
    // the loop is serial across orgs, so the DB pool isn't saturated.
    // Failures are scoped per-org — one bad org doesn't break the others.
    let okOrgs = 0;
    let failedOrgs = 0;
    for (const { org_id: orgId } of orgs) {
      try {
        const synced = await syncAllEntitiesToDisk(orgId);
        log.info({ orgId, synced }, "Boot reconciliation: rebuilt org directory (GC orphans + write DB rows)");
        okOrgs++;
      } catch (err) {
        failedOrgs++;
        log.error(
          { orgId, err: errorMessage(err) },
          "Boot reconciliation failed for org — explore may not work for this org until next restart",
        );
      }
    }
    log.info(
      { orgCount: orgs.length, okOrgs, failedOrgs },
      failedOrgs > 0
        ? "Boot reconciliation completed with failures — see per-org error logs above"
        : "Boot reconciliation complete",
    );
  } catch (err) {
    log.error(
      { err: errorMessage(err) },
      "Boot reconciliation failed — org semantic layers may be incomplete",
    );
  }
}

/**
 * First-boot auto-import: scan `{semanticRoot}/.orgs/` for directories that
 * have YAML files on disk but zero entities in the DB. Import them.
 *
 * Handles:
 * - `atlas init` ran before the import endpoint existed
 * - Self-hosted → managed migration (files copied to .orgs/ manually)
 */
async function _autoImportOrgsFromDisk(): Promise<void> {
  const orgsDir = path.join(getBaseSemanticRoot(), ".orgs");
  let orgDirs: string[];
  try {
    orgDirs = (await fs.promises.readdir(orgsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // no .orgs/ dir — nothing to import
    log.warn({ err: errorMessage(err) }, "Could not scan .orgs/ for auto-import — skipping");
    return;
  }

  const { countEntities } = await import("@atlas/api/lib/semantic/entities");
  const { getEntityDirs } = await import("./scanner");

  for (const orgId of orgDirs) {
    // Detect importable disk files across the full group-scoped layout, not
    // just the flat `entities/` dir — otherwise a purely-grouped org
    // (`groups/<group>/entities/` with no flat entities) would never trigger
    // the import and its grouped entities would stay missing from the DB
    // whitelist (#3245, ADR-0012).
    const orgRoot = path.join(orgsDir, orgId);
    const { dirs, failedScans } = getEntityDirs(orgRoot);
    let hasDiskEntities = false;
    for (const { dir } of dirs) {
      try {
        if ((await fs.promises.readdir(dir)).some((e) => e.endsWith(".yml"))) {
          hasDiskEntities = true;
          break;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn(
            { orgId, dir, err: errorMessage(err) },
            "Cannot read entities dir for auto-import — skipping dir",
          );
        }
        // ENOENT or read failure on one dir — keep checking the others.
      }
    }

    // Fail closed (#3243): a failed groups/ or legacy namespace scan returns a
    // dir list that is silently short, so a `hasDiskEntities === false` verdict
    // is unreliable — the org may be populated but unscannable. Don't treat it
    // as empty; attempt the import (which re-scans and surfaces the failure)
    // rather than silently skipping a possibly-populated org.
    if (failedScans.length > 0) {
      log.error(
        { orgId, failedScans },
        "Auto-import: semantic namespace scan failed — cannot confirm org is empty; attempting import (fail closed)",
      );
    } else if (!hasDiskEntities) {
      continue;
    }
    const dbCount = await countEntities(orgId);
    if (dbCount > 0) continue; // already imported

    try {
      const result = await importFromDisk(orgId);
      log.info(
        { orgId, imported: result.imported, skipped: result.skipped },
        "Auto-imported org semantic entities from disk (first boot)",
      );
    } catch (err) {
      log.error(
        { orgId, err: errorMessage(err) },
        "Auto-import from disk failed for org",
      );
    }
  }
}
