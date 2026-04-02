-- 0013_region_migration_cancelled.sql
--
-- Add 'cancelled' as a valid migration status. Previously, cancelled
-- migrations were stored as 'failed' with error_message 'Cancelled by admin',
-- conflating intentional cancellation with actual failures.

-- Drop and recreate the CHECK constraint to include 'cancelled'
ALTER TABLE region_migrations DROP CONSTRAINT IF EXISTS region_migrations_status_check;
ALTER TABLE region_migrations ADD CONSTRAINT region_migrations_status_check
  CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled'));

-- Update the partial unique index to also exclude 'cancelled' migrations
-- (only one active migration per workspace)
DROP INDEX IF EXISTS idx_region_migrations_one_active;
CREATE UNIQUE INDEX idx_region_migrations_one_active
  ON region_migrations(workspace_id)
  WHERE status IN ('pending', 'in_progress');
