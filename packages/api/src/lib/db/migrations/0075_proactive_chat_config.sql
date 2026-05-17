-- 0073 — Proactive chat admin config (PRD #2291, issue #2294).
--
-- Two tables back the workspace-level admin opt-in surface for proactive
-- chat. The reaction-first tracer (#2292) hard-coded a single env-var
-- channel allowlist; this migration replaces it with persisted state so
-- admins can flip behavior in the console without a restart.
--
-- workspace_proactive_config  — 1 row per workspace, holds the master
--                                toggle and the workspace-default
--                                sensitivity / classifier mode.
-- channel_proactive_config    — N rows per workspace, holds per-channel
--                                overrides (deny-list + optional
--                                per-channel sensitivity).
--
-- /ee gating: writes are refused for non-enterprise tenants at the route
-- layer (`requireEnterpriseEffect("proactive-chat")` → 403). Tables exist
-- on every tenant so a future plan upgrade can read pre-existing config
-- without a schema migration, but rows only get written through the
-- enterprise-gated admin surface.
--
-- Content Mode System opt-out (CLAUDE.md §Content Mode System):
--   `workspace_proactive_config` and `channel_proactive_config` are
--   per-workspace operational config (kill switch, sensitivity, monthly
--   cap, per-channel allow/deny) — NOT shared draft content that ships
--   through the `/api/v1/admin/publish` pipeline. They tune live agent
--   behaviour the moment an admin saves, and there is no "draft a kill
--   switch and publish it later" workflow that would make a `status`
--   column meaningful. Carving out from the mode system intentionally;
--   if a future feature wants draft → publish for these tables, retrofit
--   `status` + register the table in `CONTENT_MODE_TABLES` then.

CREATE TABLE IF NOT EXISTS workspace_proactive_config (
  workspace_id              TEXT PRIMARY KEY,
  enabled                   BOOLEAN NOT NULL DEFAULT FALSE,
  sensitivity               TEXT NOT NULL DEFAULT 'balanced',
  classifier_mode           TEXT NOT NULL DEFAULT 'regex-prefilter',
  announcement_channel_id   TEXT,
  monthly_classifier_cap    INTEGER,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_workspace_proactive_sensitivity
    CHECK (sensitivity IN ('cautious', 'balanced', 'eager')),
  CONSTRAINT chk_workspace_proactive_classifier_mode
    CHECK (classifier_mode IN ('regex-prefilter', 'classify-all')),
  CONSTRAINT chk_workspace_proactive_monthly_cap_nonneg
    CHECK (monthly_classifier_cap IS NULL OR monthly_classifier_cap >= 0)
);

CREATE TABLE IF NOT EXISTS channel_proactive_config (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              TEXT NOT NULL,
  channel_id                TEXT NOT NULL,
  allow                     BOOLEAN NOT NULL,
  sensitivity               TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_channel_proactive_sensitivity
    CHECK (sensitivity IS NULL OR sensitivity IN ('cautious', 'balanced', 'eager')),
  CONSTRAINT uq_channel_proactive_workspace_channel
    UNIQUE (workspace_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_proactive_workspace
  ON channel_proactive_config (workspace_id);
