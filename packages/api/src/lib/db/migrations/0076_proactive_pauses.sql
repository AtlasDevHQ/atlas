-- 0073 — Proactive chat three-layer kill switch + per-user opt-out
-- (PRD #2291, issue #2295).
--
-- Backs `PauseRegistry`. Four orthogonal layers, queried in a single
-- precedence-ordered scan:
--
--   layer = 'workspace-kill'   one row, channel_id IS NULL, user_id IS NULL.
--                              Admin "pause all proactive" — wins over
--                              everything below.
--   layer = 'admin-channel'    per-channel admin deny. channel_id NOT NULL,
--                              user_id IS NULL. Indefinite (expires_at NULL).
--   layer = 'user-optout'      DM `unsubscribe`. workspace-scoped per user;
--                              channel_id IS NULL, user_id NOT NULL.
--   layer = 'channel-24h'      In-channel `@atlas pause`. channel_id NOT NULL,
--                              user_id IS NULL, expires_at = now() + 24h.
--
-- Precedence (resolved in app-layer `decidePauseFromRows`):
--   workspace-kill > admin-channel > user-optout > channel-24h
--
-- Expired rows (expires_at <= now()) are ignored at read time so the
-- common case never needs a sweeper. A future maintenance job can prune;
-- the table is intentionally small enough that we don't need one at MVP.
--
-- /ee gating: writes happen through `requireEnterpriseEffect("proactive-chat")`
-- at the route + plugin host boundary. The table itself exists on every
-- tenant so a future plan upgrade can read pre-existing pauses without
-- a schema migration.

CREATE TABLE IF NOT EXISTS proactive_pauses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      TEXT NOT NULL,
  channel_id        TEXT,
  user_id           TEXT,
  layer             TEXT NOT NULL,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_proactive_pauses_layer
    CHECK (layer IN ('channel-24h', 'admin-channel', 'workspace-kill', 'user-optout'))
);

-- Lookup path: `(workspace, channel)` scan filtered by NOT-expired.
-- Composite + partial isn't worth it — the row count per workspace is
-- bounded (one workspace-kill + N channel rows + M user rows) and the
-- registry's `isPaused()` reads every row for the (workspace, channel,
-- user?) tuple in one query.
CREATE INDEX IF NOT EXISTS idx_proactive_pauses_lookup
  ON proactive_pauses (workspace_id, channel_id, expires_at);

-- Distinct index for the user-optout layer so DM-`unsubscribe` lookups
-- by (workspace_id, user_id) don't fall back to a workspace scan.
CREATE INDEX IF NOT EXISTS idx_proactive_pauses_user
  ON proactive_pauses (workspace_id, user_id)
  WHERE user_id IS NOT NULL;
