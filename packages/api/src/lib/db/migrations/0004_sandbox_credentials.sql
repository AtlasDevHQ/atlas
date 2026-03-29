-- 0004_sandbox_credentials.sql
--
-- Sandbox integration library: stores per-org BYOC sandbox provider
-- credentials (Vercel, E2B, Daytona). Platform-managed sidecar does
-- not use this table — it needs no customer credentials.

CREATE TABLE IF NOT EXISTS sandbox_credentials (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL,
  provider TEXT NOT NULL,          -- 'vercel' | 'e2b' | 'daytona'
  credentials JSONB NOT NULL,      -- provider-specific credential data (API keys, tokens)
  display_name TEXT,               -- e.g. Vercel team name, validated from API
  validated_at TIMESTAMPTZ,        -- when credentials were last verified
  connected_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_sandbox_credentials_org ON sandbox_credentials(org_id);
