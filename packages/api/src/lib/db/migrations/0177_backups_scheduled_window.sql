-- 0177 — scheduled-backup cadence-window claim (#4457)
--
-- Adds `scheduled_window` to `backups`: NULL for manual backups; for
-- fiber-scheduled ones it holds the deterministic cadence-window key
-- (`backupWindowKey` in lib/backups/cadence.ts). The partial UNIQUE index
-- is the cross-replica concurrency claim — the scheduled-backup fiber's
-- `INSERT … ON CONFLICT (scheduled_window) WHERE scheduled_window IS NOT
-- NULL DO NOTHING` makes exactly one backup run per region per window no
-- matter how many replicas tick (the #4650 re-storm class).
--
-- The ee engine's `ensureTable()` also applies both statements idempotently
-- at runtime for deployments whose `backups` table predates this migration
-- (same pattern as verify_level / expected_table_count). Additive only —
-- no expand-contract phase needed.

ALTER TABLE backups ADD COLUMN IF NOT EXISTS scheduled_window TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_backups_scheduled_window
  ON backups (scheduled_window) WHERE scheduled_window IS NOT NULL;
