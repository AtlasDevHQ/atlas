-- 0017 — Dashboards: persistent collections of query result cards
CREATE TABLE IF NOT EXISTS dashboards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  share_token VARCHAR(64),
  share_expires_at TIMESTAMPTZ,
  share_mode VARCHAR(10) NOT NULL DEFAULT 'public',
  refresh_schedule TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT chk_dashboard_share_mode CHECK (share_mode IN ('public', 'org'))
);

CREATE INDEX IF NOT EXISTS idx_dashboards_org ON dashboards (org_id);
CREATE INDEX IF NOT EXISTS idx_dashboards_owner ON dashboards (owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboards_share_token ON dashboards (share_token) WHERE share_token IS NOT NULL;

-- Dashboard cards: individual query result snapshots within a dashboard
CREATE TABLE IF NOT EXISTS dashboard_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  sql TEXT NOT NULL,
  chart_config JSONB,
  cached_columns JSONB,
  cached_rows JSONB,
  cached_at TIMESTAMPTZ,
  connection_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dashboard_cards_dashboard ON dashboard_cards (dashboard_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_cards_position ON dashboard_cards (dashboard_id, position);
