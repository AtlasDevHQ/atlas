-- 0120_static_bot_routing_id_unique.sql
--
-- #3167 — close the static-bot routing-id concurrent-install race.
--
-- Background. The five static-bot install handlers (Telegram, Discord,
-- Teams, WhatsApp, Google Chat) each run a cross-workspace ownership
-- PRE-CHECK before persisting — a read-only
-- `SELECT … WHERE config->>'<routing_id>' = $1 AND workspace_id <> $2`
-- (`assert*UnboundElsewhere`, #3154/#3163). That pre-check is NOT
-- transactionally fused with the cap-gate UPSERT: the gate's advisory
-- lock (`checkChatIntegrationLimitAndInstall`) is keyed by `workspace_id`,
-- and `workspace_plugins_singleton` is unique only on
-- `(workspace_id, catalog_id)`. So two DIFFERENT workspaces installing the
-- SAME routing id concurrently can both observe no conflicting row and
-- both UPSERT. The read-side resolvers in `lib/chat-plugin/executeQuery.ts`
-- then fail-close on `rows.length > 1` for BOTH workspaces — no data leak,
-- but an availability/griefing outage until an admin disconnects one side.
--
-- Fix. A partial UNIQUE index on the per-platform routing key, scoped to
-- enabled chat-pillar installs. The DB now rejects the second concurrent
-- writer with a `unique_violation` (23505); the handlers catch it and
-- surface the SAME actionable "already connected elsewhere" error their
-- pre-check returns (see `routing-id-conflict.ts` + the per-handler catch
-- branches). DB-enforced uniqueness needs no extra lock contention.
--
-- Why a CASE expression rather than five indexes: every platform stores
-- its routing id under a different JSONB key (Telegram `chat_id`, Discord
-- `guild_id`, Teams `tenant_id`, WhatsApp `phone_number_id`, gchat
-- `workspace_id`). One expression index keyed on `catalog_id` maps each
-- catalog to its key and keeps the routing-key contract in a single place
-- that mirrors the per-handler `*InstallConfig` shapes. The leading
-- `catalog_id` column scopes routing values per platform, so a Telegram
-- `chat_id` of "123" never collides with a Discord `guild_id` of "123".
--
-- Carve-outs (all expressed as the CASE yielding NULL — Postgres treats
-- NULLs as DISTINCT in a unique index by default, so NULL-keyed rows never
-- conflict with each other):
--   * gchat `my_customer` — a caller-relative self-install alias, not a
--     global customer id. `NULLIF(config->>'workspace_id', 'my_customer')`
--     drops it out of the constraint so every admin's "my own tenant"
--     self-install stays allowed.
--   * Slack (and any future chat catalog not in the CASE) — has no key in
--     the CASE, so the expression is NULL and the row is exempt. Slack
--     routes on `team_id` via its own path and is intentionally untouched
--     here. A new static-bot platform must add its key to BOTH this CASE
--     and the matching `uniqueIndex("workspace_plugins_chat_routing_id_unique")`
--     CASE expression in db/schema.ts (kept in lockstep).
--   * disabled installs — `WHERE enabled = true` matches the pre-check's
--     `enabled = true` filter, so a disconnected (disabled) row frees its
--     routing id for another workspace exactly as the pre-check intends.
--
-- Existing-duplicate assumption. Pre-#3154 two workspaces could bind the
-- same routing id; any such pair is ALREADY non-functional because the
-- read-side resolver fail-closes on `rows.length > 1`. The static-bot
-- install path is brand-new (#2994 umbrella, #3141–#3144) and Atlas is
-- pre-launch with no live multi-tenant chat installs, so no enabled-row
-- routing-id duplicates are expected. If one did exist this `CREATE UNIQUE
-- INDEX` would fail loudly at deploy (correct fail-closed behaviour) —
-- naming the conflicting index — rather than silently shipping a broken
-- guard. Plain (non-CONCURRENTLY) creation: the migration runner wraps
-- every file in a single transaction under an advisory lock, and
-- CONCURRENTLY cannot run inside a transaction block.
--
-- Plain CREATE UNIQUE INDEX (no Better Auth tables touched) → no
-- MANAGED_AUTH_MIGRATIONS entry. Idempotent via IF NOT EXISTS.

CREATE UNIQUE INDEX IF NOT EXISTS workspace_plugins_chat_routing_id_unique
  ON workspace_plugins (
    catalog_id,
    (CASE catalog_id
       WHEN 'catalog:telegram' THEN config->>'chat_id'
       WHEN 'catalog:discord'  THEN config->>'guild_id'
       WHEN 'catalog:teams'    THEN config->>'tenant_id'
       WHEN 'catalog:whatsapp' THEN config->>'phone_number_id'
       WHEN 'catalog:gchat'    THEN NULLIF(config->>'workspace_id', 'my_customer')
     END)
  )
  WHERE enabled = true AND pillar = 'chat';
