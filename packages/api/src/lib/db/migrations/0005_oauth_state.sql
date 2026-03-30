-- 0005_oauth_state.sql
--
-- OAuth CSRF nonces for Teams, Discord, and future integration
-- OAuth flows. Stored in DB so that multi-instance deployments
-- can validate callbacks that arrive on a different instance
-- than the one that initiated the flow.

CREATE TABLE IF NOT EXISTS oauth_state (
  nonce TEXT PRIMARY KEY,
  org_id TEXT,
  provider TEXT NOT NULL,              -- 'teams' | 'discord' | future providers
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_state_expires ON oauth_state(expires_at);
