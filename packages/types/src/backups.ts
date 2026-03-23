/**
 * Backup and disaster recovery types.
 *
 * Used by the platform admin console for managing automated
 * backups of the internal PostgreSQL database.
 */

// ---------------------------------------------------------------------------
// Backup status
// ---------------------------------------------------------------------------

export const BACKUP_STATUSES = ["in_progress", "completed", "failed", "verified"] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

// ---------------------------------------------------------------------------
// Backup entry
// ---------------------------------------------------------------------------

export interface BackupEntry {
  id: string;
  createdAt: string;
  /** Compressed backup size in bytes. Null while in_progress. */
  sizeBytes: number | null;
  status: BackupStatus;
  /** Filesystem or S3 path where the backup is stored. */
  storagePath: string;
  /** When this backup will be auto-purged based on retention policy. */
  retentionExpiresAt: string;
  /** Error message if status is "failed". */
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Backup configuration
// ---------------------------------------------------------------------------

export interface BackupConfig {
  /** Cron expression for automated backups. Default: "0 3 * * *" (daily 03:00 UTC). */
  schedule: string;
  /** Number of days to retain backups before auto-purge. Default: 30. */
  retentionDays: number;
  /** Directory or S3 URI for backup storage. */
  storagePath: string;
}
