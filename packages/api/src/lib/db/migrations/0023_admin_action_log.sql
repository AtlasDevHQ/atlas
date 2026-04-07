-- 0023 — Admin action audit log
--
-- Persistent log for all admin mutations (platform + workspace).
-- These records are kept indefinitely — no deleted_at column.

CREATE TABLE IF NOT EXISTS admin_action_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id      TEXT        NOT NULL,
  actor_email   TEXT        NOT NULL,
  scope         TEXT        NOT NULL DEFAULT 'workspace',
  org_id        TEXT,
  action_type   TEXT        NOT NULL,
  target_type   TEXT        NOT NULL,
  target_id     TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'success',
  metadata      JSONB,
  ip_address    TEXT,
  request_id    TEXT        NOT NULL
);

-- Constraint: scope must be 'platform' or 'workspace'
DO $$ BEGIN
  ALTER TABLE admin_action_log ADD CONSTRAINT chk_admin_action_scope
    CHECK (scope IN ('platform', 'workspace'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Constraint: status must be 'success' or 'failure'
DO $$ BEGIN
  ALTER TABLE admin_action_log ADD CONSTRAINT chk_admin_action_status
    CHECK (status IN ('success', 'failure'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_admin_action_log_timestamp   ON admin_action_log (timestamp);
CREATE INDEX IF NOT EXISTS idx_admin_action_log_actor_id    ON admin_action_log (actor_id);
CREATE INDEX IF NOT EXISTS idx_admin_action_log_org_id      ON admin_action_log (org_id);
CREATE INDEX IF NOT EXISTS idx_admin_action_log_action_type ON admin_action_log (action_type);
CREATE INDEX IF NOT EXISTS idx_admin_action_log_target_type ON admin_action_log (target_type);
CREATE INDEX IF NOT EXISTS idx_admin_action_log_org_ts      ON admin_action_log (org_id, timestamp);
