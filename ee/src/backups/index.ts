/**
 * Backup and disaster recovery — enterprise feature.
 *
 * Exports:
 * - createBackup() / listBackups() / getBackupById() — backup operations
 * - verifyBackup() — integrity verification
 * - requestRestore() / executeRestore() — restore with confirmation
 * - startScheduler() / stopScheduler() — automated cron backups
 * - getBackupConfig() / updateBackupConfig() — configuration
 * - purgeExpiredBackups() — retention enforcement
 *
 * Post-#2568 (slice 6/11 of #2017): these functions are also exposed
 * through the `BackupsManager` Tag via `BackupsManagerLive` aggregated
 * into `ee/src/layers.ts:EELayer`. The admin route
 * `api/routes/platform-backups.ts` reaches the implementation through
 * the Tag, not through a direct import.
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

export {
  createBackup,
  listBackups,
  getBackupById,
  getBackupConfig,
  updateBackupConfig,
  purgeExpiredBackups,
} from "./engine";

export { verifyBackup } from "./verify";

export { requestRestore, executeRestore } from "./restore";

export { startScheduler, stopScheduler } from "./scheduler";

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
});

export const BackupsManagerLive: Layer.Layer<BackupsManager> = Layer.sync(
  BackupsManager,
  makeBackupsManagerLive,
);
