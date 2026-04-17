-- 0018 — Dashboard auto-refresh: add scheduler pickup columns
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS last_refresh_at TIMESTAMPTZ;
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS next_refresh_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_dashboards_next_refresh
  ON dashboards (next_refresh_at)
  WHERE refresh_schedule IS NOT NULL AND deleted_at IS NULL;
