-- 0012_region_migrations.sql
--
-- Region migration requests. Phase 1: records the request with status
-- "pending" for manual fulfilment. Phase 2 will add automated data
-- movement and status transitions.

CREATE TABLE IF NOT EXISTS region_migrations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_region TEXT NOT NULL,
  target_region TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  requested_by TEXT,                         -- user ID of who requested the migration
  error_message TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_region_migrations_workspace ON region_migrations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_region_migrations_status ON region_migrations(status);

-- Enforce at most one active migration per workspace at the DB level
CREATE UNIQUE INDEX IF NOT EXISTS idx_region_migrations_one_active
  ON region_migrations(workspace_id)
  WHERE status IN ('pending', 'in_progress');
