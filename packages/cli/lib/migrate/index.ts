/**
 * Semantic layer snapshot and migration utilities.
 *
 * Re-exports everything from the snapshot module for convenient imports.
 */

export {
  type SnapshotTrigger,
  type SnapshotFile,
  type SnapshotEntry,
  type Snapshot,
  type Manifest,
  type DiffLine,
  type FileDiff,
  collectSemanticFiles,
  createSnapshot,
  loadSnapshot,
  getHistory,
  getLatestEntry,
  diffFiles,
  diffCurrentVsSnapshot,
  diffSnapshots,
  rollbackToSnapshot,
  currentHash,
  parseSnapshotEntities,
} from "./snapshot";
