/**
 * Dual-write sync layer for org-scoped semantic layers.
 *
 * Maintains persistent per-org directories at `semantic/.orgs/{orgId}/`
 * that mirror the `semantic_entities` DB table. The DB is the source of
 * truth; the disk is a persistent cache consumed by the explore tool
 * (the agent navigates the semantic layer via filesystem commands like
 * `ls`, `cat`, and `grep`).
 *
 * Currently implements DB → disk: admin API entity CRUD writes DB first,
 * then syncs to disk. The reverse direction (disk → DB, for `atlas init`
 * / import) is planned in #523.
 *
 * File writes use atomic write-to-temp + rename to prevent partial reads.
 */

import * as fs from "fs";
import * as path from "path";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("semantic-sync");

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Base semantic root (process-level, never changes). */
const SEMANTIC_BASE = path.resolve(process.cwd(), "semantic");

/**
 * Resolve the semantic root for a given org.
 *
 * - With orgId: `semantic/.orgs/{orgId}/`
 * - Without orgId: `semantic/` (self-hosted fallback)
 *
 * Validates orgId against path traversal — rejects values containing
 * path separators or `..` components.
 */
export function getSemanticRoot(orgId?: string): string {
  if (!orgId) return SEMANTIC_BASE;
  const safe = path.basename(orgId);
  if (safe !== orgId || orgId === "." || orgId === "..") {
    throw new Error(`Invalid orgId for semantic root: "${orgId}"`);
  }
  return path.join(SEMANTIC_BASE, ".orgs", safe);
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

/** Resolve the full file path for an entity on disk. */
function entityFilePath(orgId: string, name: string, type: SemanticEntityType): string {
  const root = getSemanticRoot(orgId);
  const subdir = entityTypeDir(type);
  const fileName = `${safeName(name)}.yml`;
  return subdir ? path.join(root, subdir, fileName) : path.join(root, fileName);
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
): Promise<void> {
  const filePath = entityFilePath(orgId, name, type);
  try {
    await atomicWriteFile(filePath, yamlContent);
    log.debug({ orgId, name, type, filePath }, "Synced entity to disk");
  } catch (err) {
    log.error(
      { orgId, name, type, filePath, err: err instanceof Error ? err.message : String(err) },
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
): Promise<void> {
  const filePath = entityFilePath(orgId, name, type);
  try {
    await fs.promises.unlink(filePath);
    log.debug({ orgId, name, type, filePath }, "Deleted entity from disk");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File already gone — that's fine
      return;
    }
    log.error(
      { orgId, name, type, filePath, err: err instanceof Error ? err.message : String(err) },
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
        { orgId, err: err instanceof Error ? err.message : String(err) },
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
  const { listEntities } = await import("@atlas/api/lib/db/semantic-entities");
  const rows = await listEntities(orgId);

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
    const filePath = entityFilePath(orgId, row.name, row.entity_type as SemanticEntityType);
    expectedFiles.add(filePath);
    try {
      await atomicWriteFile(filePath, row.yaml_content);
      synced++;
    } catch (err) {
      log.error(
        { orgId, name: row.name, type: row.entity_type, err: err instanceof Error ? err.message : String(err) },
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
              log.warn({ path: fullPath, err: err instanceof Error ? err.message : String(err) }, "Failed to remove stale file");
            }
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn({ dir, err: err instanceof Error ? err.message : String(err) }, "Failed to scan directory for stale files");
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
      { orgId, path: root, err: err instanceof Error ? err.message : String(err) },
      "Failed to clean up org directory",
    );
  }
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
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("does not exist") || msg.includes("no such table")) {
        log.info("semantic_entities table not found — first boot before migration, skipping reconciliation");
        return;
      }
      throw err; // re-throw unexpected DB errors
    }

    if (orgs.length === 0) {
      log.debug("No org semantic entities in DB — skipping boot reconciliation");
      return;
    }

    log.info({ orgCount: orgs.length }, "Starting boot reconciliation for org semantic layers");

    for (const { org_id: orgId } of orgs) {
      const root = getSemanticRoot(orgId);
      const entitiesDir = path.join(root, "entities");

      // Check if the directory exists and has files
      let needsRebuild = false;
      try {
        const entries = await fs.promises.readdir(entitiesDir);
        needsRebuild = !entries.some((e) => e.endsWith(".yml"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          needsRebuild = true;
        } else {
          log.warn(
            { orgId, err: err instanceof Error ? err.message : String(err) },
            "Unexpected error reading org entities directory — attempting rebuild",
          );
          needsRebuild = true;
        }
      }

      if (needsRebuild) {
        try {
          const synced = await syncAllEntitiesToDisk(orgId);
          log.info({ orgId, synced }, "Boot reconciliation: rebuilt org directory");
        } catch (err) {
          log.error(
            { orgId, err: err instanceof Error ? err.message : String(err) },
            "Boot reconciliation failed for org — explore may not work for this org until next restart",
          );
        }
      } else {
        log.debug({ orgId }, "Boot reconciliation: org directory exists and has entities — skipping");
      }
    }
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Boot reconciliation failed — org semantic layers may be incomplete",
    );
  }
}
