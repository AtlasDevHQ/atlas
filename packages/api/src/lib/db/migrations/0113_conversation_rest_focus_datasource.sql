-- Migration 0113: per-conversation REST-only focus (#3067, S2b).
--
-- v0.0.4 Conversation Scope. A conversation can FOCUS a single REST
-- datasource so the agent targets it exclusively and SQL execution
-- (executeSQL) is SUSPENDED for that conversation — the "ask Stripe
-- only" case. Holds a single `workspace_plugins.install_id` value (the
-- id the scope picker surfaces, `GET /api/v1/me/connection-groups`).
--
-- NULL (the default) = not focused: SQL routing (routing_mode) and the
-- REST exclude-set (rest_excluded_datasource_ids, 0112) apply as normal.
-- When set, those two fields are inert but RETAINED, so clearing focus
-- (back to NULL) returns to the prior default-state scope. A focus id
-- that no longer matches any install falls back safely to default scope
-- at resolve time (the resolver yields no datasource → SQL stays active).
-- See ADR-0011.
--
-- Nullable text with no default — unlike the exclude-set there is no
-- NULL/[] ambiguity to avoid; NULL is the meaningful "not focused" state.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` is a no-op on re-run.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS rest_focus_datasource_id text;

COMMENT ON COLUMN conversations.rest_focus_datasource_id IS
  'Per-conversation REST-only focus (#3067). When set, holds the single workspace_plugins.install_id the conversation targets exclusively, suspending executeSQL. NULL = not focused (SQL routing + rest_excluded_datasource_ids apply). See ADR-0011.';
