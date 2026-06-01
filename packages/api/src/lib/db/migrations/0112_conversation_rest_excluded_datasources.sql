-- Migration 0112: per-conversation REST datasource exclude-set (#3066, S2a).
--
-- v0.0.4 Conversation Scope. REST datasources are in scope by default;
-- a conversation can EXCLUDE specific ones so the agent stops querying
-- them. The set holds `workspace_plugins.install_id` values — the id the
-- scope picker surfaces (`GET /api/v1/me/connection-groups`). Empty
-- (`'{}'`, the default) means nothing is excluded: every in-scope REST
-- datasource is queryable, so a newly-installed datasource is reachable
-- with no action. SQL routing (Auto/Pin/All on `routing_mode`) is
-- unaffected. Authoritative per-conversation; the web sticky preference
-- only seeds NEW chats. See ADR-0011.
--
-- NOT NULL DEFAULT '{}' so every existing row reads as "all in scope"
-- without a backfill. The resolver treats an absent set as empty, but the
-- not-null default keeps the row shape honest (no NULL/[] ambiguity).
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` is a no-op on re-run.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS rest_excluded_datasource_ids text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN conversations.rest_excluded_datasource_ids IS
  'Per-conversation REST datasource exclude-set (#3066). Holds workspace_plugins.install_id values the agent must NOT query for this conversation. Empty = every in-scope REST datasource is queryable. SQL routing (routing_mode) unaffected. See ADR-0011.';
