/**
 * Semantic layer snapshot library.
 *
 * Captures, stores, and restores point-in-time snapshots of the semantic layer
 * (entities, glossary, metrics). Snapshots are stored as JSON files in
 * `semantic/.history/` with a manifest for ordered history.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as yaml from "js-yaml";

// ── Types ─────────────────────────────────────────────────────────

export type SnapshotTrigger = "manual" | "improve" | "init" | "interactive" | "rollback";

export interface SnapshotFile {
  /** Relative path from semantic root (e.g. "entities/orders.yml") */
  readonly path: string;
  /** Raw file content */
  readonly content: string;
}

export interface SnapshotEntry {
  /** Short hash (first 8 chars of SHA-256 of the snapshot content) */
  readonly hash: string;
  /** ISO 8601 timestamp */
  readonly timestamp: string;
  /** User-provided message (optional) */
  readonly message: string;
  /** What triggered this snapshot */
  readonly trigger: SnapshotTrigger;
  /** Snapshot filename (e.g. "20260405T123456Z-abcd1234.json") */
  readonly filename: string;
}

export interface Snapshot {
  readonly hash: string;
  readonly timestamp: string;
  readonly message: string;
  readonly trigger: SnapshotTrigger;
  readonly files: readonly SnapshotFile[];
}

export interface Manifest {
  readonly version: 1;
  readonly entries: readonly SnapshotEntry[];
}

export interface DiffLine {
  readonly type: "added" | "removed" | "context";
  readonly content: string;
}

export interface FileDiff {
  readonly path: string;
  readonly status: "added" | "removed" | "modified" | "unchanged";
  readonly lines: readonly DiffLine[];
}

// ── Constants ─────────────────────────────────────────────────────

const HISTORY_DIR_NAME = ".history";
const MANIFEST_FILE = "manifest.json";

// ── Helpers ───────────────────────────────────────────────────────

function historyDir(semanticRoot: string): string {
  return path.join(semanticRoot, HISTORY_DIR_NAME);
}

function manifestPath(semanticRoot: string): string {
  return path.join(historyDir(semanticRoot), MANIFEST_FILE);
}

function ensureHistoryDir(semanticRoot: string): void {
  const dir = historyDir(semanticRoot);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readManifest(semanticRoot: string): Manifest {
  const mp = manifestPath(semanticRoot);
  if (!fs.existsSync(mp)) {
    return { version: 1, entries: [] };
  }
  const raw = fs.readFileSync(mp, "utf-8");
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      throw new Error("Invalid manifest structure — expected { version, entries[] }");
    }
    return parsed as unknown as Manifest;
  } catch (err) {
    throw new Error(
      `Corrupt manifest at ${mp}: ${err instanceof Error ? err.message : String(err)}. ` +
      `Delete ${mp} to reset snapshot history.`,
      { cause: err },
    );
  }
}

function writeManifest(semanticRoot: string, manifest: Manifest): void {
  ensureHistoryDir(semanticRoot);
  fs.writeFileSync(
    manifestPath(semanticRoot),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Validate that a relative path is safe (no traversal, stays within root).
 * Returns the resolved absolute path, or throws on traversal attempt.
 */
function safePath(semanticRoot: string, relativePath: string): string {
  const resolved = path.resolve(semanticRoot, relativePath);
  const rootResolved = path.resolve(semanticRoot);
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    throw new Error(`Path traversal detected in snapshot: ${relativePath}`);
  }
  return resolved;
}

/**
 * Collect all YAML files from the semantic layer directory.
 * Walks entities/, metrics/, and root-level YAML files (glossary.yml, catalog.yml).
 * Skips .history/, .orgs/, and node_modules/ directories.
 */
export function collectSemanticFiles(semanticRoot: string): SnapshotFile[] {
  const files: SnapshotFile[] = [];
  const skipDirs = new Set([".history", ".orgs", "node_modules"]);

  function walk(dir: string, prefix: string): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.isFile() && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const content = fs.readFileSync(path.join(dir, entry.name), "utf-8");
        files.push({ path: relPath, content });
      }
    }
  }

  walk(semanticRoot, "");
  return files.toSorted((a, b) => a.path.localeCompare(b.path));
}

/**
 * Compute a SHA-256 hash of a snapshot's content.
 * The hash is deterministic: files are sorted by path, then each path and
 * content are fed into the hasher with null-byte delimiters.
 */
function computeHash(files: readonly SnapshotFile[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const hasher = crypto.createHash("sha256");
  for (const f of sorted) {
    hasher.update(f.path);
    hasher.update("\0");
    hasher.update(f.content);
    hasher.update("\0");
  }
  return hasher.digest("hex").slice(0, 8);
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Create a new snapshot of the current semantic layer state.
 * Returns the created snapshot entry, or null if nothing changed since the last snapshot.
 * Throws if the semantic layer directory contains no YAML files.
 */
export function createSnapshot(
  semanticRoot: string,
  options: {
    readonly message?: string;
    readonly trigger?: SnapshotTrigger;
    readonly force?: boolean;
  } = {},
): SnapshotEntry | null {
  const files = collectSemanticFiles(semanticRoot);
  if (files.length === 0) {
    throw new Error("No YAML files found in semantic layer directory");
  }

  const hash = computeHash(files);
  const manifest = readManifest(semanticRoot);

  // Skip if identical to the last snapshot (unless forced)
  if (!options.force && manifest.entries.length > 0) {
    const last = manifest.entries[manifest.entries.length - 1];
    if (last.hash === hash) {
      return null;
    }
  }

  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const filename = `${ts}-${hash}.json`;
  const trigger = options.trigger ?? "manual";

  const snapshot: Snapshot = {
    hash,
    timestamp: now.toISOString(),
    message: options.message ?? "",
    trigger,
    files,
  };

  ensureHistoryDir(semanticRoot);
  fs.writeFileSync(
    path.join(historyDir(semanticRoot), filename),
    JSON.stringify(snapshot, null, 2) + "\n",
    "utf-8",
  );

  const entry: SnapshotEntry = {
    hash,
    timestamp: now.toISOString(),
    message: options.message ?? "",
    trigger,
    filename,
  };

  const updated: Manifest = { version: 1, entries: [...manifest.entries, entry] };
  writeManifest(semanticRoot, updated);

  return entry;
}

/**
 * Load a snapshot by hash (prefix match).
 * Returns null if no matching entry exists or the snapshot file is missing from disk.
 * Throws if the snapshot file exists but is corrupt.
 */
export function loadSnapshot(semanticRoot: string, hashPrefix: string): Snapshot | null {
  const manifest = readManifest(semanticRoot);
  const entry = manifest.entries.find((e) => e.hash.startsWith(hashPrefix));
  if (!entry) return null;

  const filePath = path.join(historyDir(semanticRoot), entry.filename);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.files)) {
      throw new Error("Invalid snapshot structure — expected { hash, files[] }");
    }
    return parsed as unknown as Snapshot;
  } catch (err) {
    throw new Error(
      `Corrupt snapshot file ${entry.filename}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Get the manifest (snapshot history).
 */
export function getHistory(semanticRoot: string): Manifest {
  return readManifest(semanticRoot);
}

/**
 * Get the latest snapshot entry, or null if no snapshots exist.
 */
export function getLatestEntry(semanticRoot: string): SnapshotEntry | null {
  const manifest = readManifest(semanticRoot);
  if (manifest.entries.length === 0) return null;
  return manifest.entries[manifest.entries.length - 1];
}

/**
 * Compute a file-level diff between two sets of snapshot files, classifying each
 * as added, removed, modified, or unchanged. Modified files include an LCS-based
 * line-level diff.
 */
export function diffFiles(
  before: readonly SnapshotFile[],
  after: readonly SnapshotFile[],
): FileDiff[] {
  const beforeMap = new Map(before.map((f) => [f.path, f.content]));
  const afterMap = new Map(after.map((f) => [f.path, f.content]));
  const allPaths = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const diffs: FileDiff[] = [];

  for (const p of [...allPaths].sort()) {
    const bContent = beforeMap.get(p);
    const aContent = afterMap.get(p);

    if (bContent === undefined && aContent !== undefined) {
      diffs.push({
        path: p,
        status: "added",
        lines: aContent.split("\n").map((l) => ({ type: "added" as const, content: l })),
      });
    } else if (bContent !== undefined && aContent === undefined) {
      diffs.push({
        path: p,
        status: "removed",
        lines: bContent.split("\n").map((l) => ({ type: "removed" as const, content: l })),
      });
    } else if (bContent !== undefined && aContent !== undefined) {
      if (bContent === aContent) {
        diffs.push({ path: p, status: "unchanged", lines: [] });
      } else {
        diffs.push({
          path: p,
          status: "modified",
          lines: computeLineDiff(bContent, aContent),
        });
      }
    }
  }

  return diffs;
}

/**
 * Simple line-level diff using LCS (longest common subsequence).
 * Returns context + added + removed lines.
 */
function computeLineDiff(before: string, after: string): DiffLine[] {
  const bLines = before.split("\n");
  const aLines = after.split("\n");

  // Build LCS table
  const m = bLines.length;
  const n = aLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = bLines[i - 1] === aLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to build diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && bLines[i - 1] === aLines[j - 1]) {
      result.push({ type: "context", content: bLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: "added", content: aLines[j - 1] });
      j--;
    } else {
      result.push({ type: "removed", content: bLines[i - 1] });
      i--;
    }
  }

  return result.reverse();
}

/**
 * Compute the diff between the current semantic layer and a snapshot.
 * Returns null if no snapshots exist, if the target hash is not found,
 * or if the snapshot file is missing from disk.
 */
export function diffCurrentVsSnapshot(
  semanticRoot: string,
  targetHash?: string,
): { diffs: FileDiff[]; snapshotEntry: SnapshotEntry } | null {
  const manifest = readManifest(semanticRoot);
  if (manifest.entries.length === 0) return null;

  let entry: SnapshotEntry | undefined;
  if (targetHash) {
    entry = manifest.entries.find((e) => e.hash.startsWith(targetHash));
  } else {
    entry = manifest.entries[manifest.entries.length - 1];
  }
  if (!entry) return null;

  const snapshot = loadSnapshot(semanticRoot, entry.hash);
  if (!snapshot) return null;

  const currentFiles = collectSemanticFiles(semanticRoot);
  return {
    diffs: diffFiles(snapshot.files, currentFiles),
    snapshotEntry: entry,
  };
}

/**
 * Diff between two snapshots by hash prefix.
 */
export function diffSnapshots(
  semanticRoot: string,
  fromHash: string,
  toHash: string,
): { diffs: FileDiff[]; from: SnapshotEntry; to: SnapshotEntry } | null {
  const manifest = readManifest(semanticRoot);
  const fromEntry = manifest.entries.find((e) => e.hash.startsWith(fromHash));
  const toEntry = manifest.entries.find((e) => e.hash.startsWith(toHash));
  if (!fromEntry || !toEntry) return null;

  const fromSnap = loadSnapshot(semanticRoot, fromEntry.hash);
  const toSnap = loadSnapshot(semanticRoot, toEntry.hash);
  if (!fromSnap || !toSnap) return null;

  return {
    diffs: diffFiles(fromSnap.files, toSnap.files),
    from: fromEntry,
    to: toEntry,
  };
}

/**
 * Restore the semantic layer to a previous snapshot state.
 * Creates a pre-rollback snapshot first, then removes all current YAML files
 * and restores files from the target snapshot. The restore is not atomic —
 * if it fails partway, the pre-rollback snapshot provides a recovery path.
 */
export function rollbackToSnapshot(
  semanticRoot: string,
  hashPrefix: string,
): { restored: SnapshotEntry; preRollback: SnapshotEntry | null } {
  const snapshot = loadSnapshot(semanticRoot, hashPrefix);
  if (!snapshot) {
    throw new Error(`Snapshot not found: ${hashPrefix}`);
  }

  // Validate all snapshot paths before any destructive operations
  for (const f of snapshot.files) {
    safePath(semanticRoot, f.path);
  }

  // Auto-snapshot current state before rolling back
  const preRollback = createSnapshot(semanticRoot, {
    message: `Pre-rollback snapshot (rolling back to ${hashPrefix})`,
    trigger: "rollback",
  });

  // Remove all existing YAML files from semantic root (except .history/ and .orgs/)
  const currentFiles = collectSemanticFiles(semanticRoot);
  for (const f of currentFiles) {
    const fullPath = path.join(semanticRoot, f.path);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  }

  // Clean up empty directories left behind (entities/, metrics/)
  cleanEmptyDirs(semanticRoot, new Set([".history", ".orgs", "node_modules"]));

  // Restore files from snapshot
  try {
    for (const f of snapshot.files) {
      const fullPath = safePath(semanticRoot, f.path);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, f.content, "utf-8");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Rollback failed during file restoration: ${msg}. ` +
      `Your semantic layer may be in an inconsistent state. ` +
      (preRollback
        ? `A pre-rollback snapshot was saved as ${preRollback.hash}. Run 'atlas migrate rollback ${preRollback.hash}' to restore your previous state.`
        : `Check ${path.join(semanticRoot, ".history/")} for recoverable snapshots.`),
      { cause: err },
    );
  }

  // Find the entry for the restored snapshot
  const manifest = readManifest(semanticRoot);
  const entry = manifest.entries.find((e) => e.hash.startsWith(hashPrefix));
  if (!entry) {
    throw new Error(`Manifest entry not found for hash: ${hashPrefix}`);
  }

  return { restored: entry, preRollback };
}

/**
 * Compute hash of current semantic layer files (for status comparison).
 */
export function currentHash(semanticRoot: string): string {
  const files = collectSemanticFiles(semanticRoot);
  return computeHash(files);
}

// ── Internal helpers ──────────────────────────────────────────────

function cleanEmptyDirs(dir: string, skipDirs: Set<string>): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (skipDirs.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    cleanEmptyDirs(fullPath, skipDirs);

    // Remove if now empty
    const remaining = fs.readdirSync(fullPath);
    if (remaining.length === 0) {
      fs.rmdirSync(fullPath);
    }
  }
}

/**
 * Parse entity YAML files from a snapshot and return structured content.
 * Designed for use by the web semantic editor to read the snapshot format.
 * Skips non-entity files and logs unparseable entities via console.debug.
 */
export function parseSnapshotEntities(
  snapshot: Snapshot,
): Map<string, Record<string, unknown>> {
  const entities = new Map<string, Record<string, unknown>>();
  for (const f of snapshot.files) {
    if (f.path.startsWith("entities/") && (f.path.endsWith(".yml") || f.path.endsWith(".yaml"))) {
      try {
        const parsed = yaml.load(f.content) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          const name = path.basename(f.path, path.extname(f.path));
          entities.set(name, parsed);
        }
      } catch (err) {
        // Malformed YAML in snapshot — skip but log for debugging
        console.debug(
          `Skipped unparseable entity in snapshot: ${f.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return entities;
}
