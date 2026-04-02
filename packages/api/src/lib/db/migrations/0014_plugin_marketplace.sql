-- 0014_plugin_marketplace.sql
--
-- Plugin marketplace tables. Platform admins manage a catalog of available
-- plugins; workspace admins install plugins from the catalog into their
-- workspace with per-installation config.

CREATE TABLE IF NOT EXISTS plugin_catalog (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('datasource', 'context', 'interaction', 'action', 'sandbox')),
  npm_package TEXT,
  icon_url TEXT,
  config_schema JSONB,
  min_plan TEXT NOT NULL DEFAULT 'team',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plugin_catalog_slug ON plugin_catalog(slug);
CREATE INDEX IF NOT EXISTS idx_plugin_catalog_type ON plugin_catalog(type);
CREATE INDEX IF NOT EXISTS idx_plugin_catalog_enabled ON plugin_catalog(enabled) WHERE enabled = true;

CREATE TABLE IF NOT EXISTS workspace_plugins (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  catalog_id TEXT NOT NULL REFERENCES plugin_catalog(id) ON DELETE CASCADE,
  config JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by TEXT,
  UNIQUE(workspace_id, catalog_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_plugins_workspace ON workspace_plugins(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_plugins_catalog ON workspace_plugins(catalog_id);
