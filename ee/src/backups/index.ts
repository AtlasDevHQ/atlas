/**
 * Backup and disaster recovery — enterprise feature.
 *
 * Exports:
 * - createBackup() / listBackups() / getBackupById() — backup operations
 * - createScheduledBackup() — window-claimed scheduled-path create (#4457)
 * - verifyBackup() — integrity verification
 * - requestRestore() / executeRestore() — restore with confirmation
 * - runScheduledBackupCycle() — one tick of the scheduled-backup fiber
 * - getBackupConfig() / updateBackupConfig() — configuration
 * - purgeExpiredBackups() — retention enforcement
 * - getBackupStorage() — the local/S3 artifact storage driver
 *
 * Post-#2568 (slice 6/11 of #2017): these functions are also exposed
 * through the `BackupsManager` Tag via `BackupsManagerLive` aggregated
 * into `ee/src/layers.ts:EELayer`. The admin route
 * `api/routes/platform-backups.ts` reaches the implementation through
 * the Tag, not through a direct import — and so does the
 * `scheduled_backup` periodic fiber in core `makeSchedulerLive` (#4457),
 * which calls `runScheduledBackupCycle` through the Tag so core never
 * imports `@atlas/ee` directly.
 */

import { Layer } from "effect";
import {
  BackupsManager,
  type BackupsManagerShape,
} from "@atlas/api/lib/effect/services";
import {
  createBackup,
  listBackups,
  getBackupById,
  getBackupConfig,
  updateBackupConfig,
  purgeExpiredBackups,
} from "./engine";
import { verifyBackup } from "./verify";
import { requestRestore, executeRestore } from "./restore";
import { runScheduledBackupCycle } from "./scheduler";

export {
  createBackup,
  createScheduledBackup,
  listBackups,
  getBackupById,
  getBackupConfig,
  updateBackupConfig,
  purgeExpiredBackups,
} from "./engine";

export { verifyBackup } from "./verify";

export { requestRestore, executeRestore } from "./restore";

export { runScheduledBackupCycle, type ScheduledBackupCycleResult } from "./scheduler";

export { getBackupStorage, type BackupStorage } from "./storage";

export const makeBackupsManagerLive = (): BackupsManagerShape => ({
  available: true,
  getBackupConfig,
  updateBackupConfig,
  createBackup,
  listBackups,
  getBackupById,
  purgeExpiredBackups,
  verifyBackup,
  requestRestore,
  executeRestore,
  runScheduledBackupCycle,
});

export const BackupsManagerLive: Layer.Layer<BackupsManager> = Layer.sync(
  BackupsManager,
  makeBackupsManagerLive,
);
