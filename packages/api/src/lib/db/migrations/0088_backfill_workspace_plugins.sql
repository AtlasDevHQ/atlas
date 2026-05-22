-- 0088_backfill_workspace_plugins.sql
--
-- Atlas issue #2655 (1.5.2 slice 7) — backfill `workspace_plugins` rows
-- for the internal Workspaces whose Slack bot tokens already live in
-- `chat_cache` (key prefix `slack:installation:`) but predate the catalog
-- install model (#2650, migration 0087).
--
-- The WorkspaceInstallGate (introduced in the same PR — see
-- `packages/api/src/lib/integrations/install/workspace-install-gate.ts`)
-- reads `workspace_plugins JOIN plugin_catalog` to decide whether a
-- per-event proactive flow should fire. Without a `workspace_plugins`
-- row the gate returns false, silencing the dogfood proactive flow
-- (maintainer's team + demo team). New OAuth installs after this PR
-- write the row themselves via `SlackOAuthInstallHandler` (slice 5 of
-- #2649); this migration plugs the historical gap for installs that
-- predate that handler.
--
-- Idempotent: `ON CONFLICT (workspace_id, catalog_id) DO NOTHING`.
-- Re-running the migration set does not duplicate or overwrite admin-
-- supplied state. The companion catalog INSERT is keyed on `slug` for
-- the same reason — the `CatalogSeeder` boot pass will overwrite
-- every non-id column from `atlas.config.ts` after this migration runs.
--
-- ## Catalog-seed timing
--
-- The boot-time `CatalogSeeder` runs AFTER migrations (gated on the
-- `Migration` Layer in `packages/api/src/lib/effect/layers.ts`). On
-- a fresh deploy that hasn't yet seen its first boot post-#2650, the
-- `catalog:slack` row may not exist when this migration runs, which
-- would fail the FK reference below. The first INSERT below ensures a
-- minimum-viable `catalog:slack` row exists; the `CatalogSeeder` then
-- overwrites every column except `id` on its normal boot pass
-- (`ON CONFLICT (slug) DO UPDATE SET ...`).
--
-- ## What is NOT done here
--
-- We do NOT validate that the bot token still works, that the org row
-- exists in `organization`, or that the workspace's `plan_tier` is high
-- enough to admit the integration. Those are runtime concerns owned by
-- the gate. This migration only ensures the historical install rows
-- exist so the gate has something to read.

-- Ensure the catalog row exists before the FK references it. Default
-- values match the catalog seeder's normal output for the Slack entry
-- (`type='chat'`, `install_model='oauth'`, `enabled=true`); the seeder
-- rewrites `name` / `description` / `icon_url` / `min_plan` /
-- `saas_eligible` from `atlas.config.ts` on the next boot pass. `id`
-- stays `catalog:slack` so any rows we INSERT below keep pointing at
-- the right catalog entry across seeds.
INSERT INTO plugin_catalog (id, name, slug, type, install_model, enabled)
VALUES ('catalog:slack', 'Slack', 'slack', 'chat', 'oauth', true)
ON CONFLICT (slug) DO NOTHING;

-- Backfill from existing `chat_cache:slack:installation:<teamId>` rows.
-- The 1.5.2 dogfood deploy carries 2 such rows (maintainer's team +
-- demo team); other environments may have zero, in which case this
-- INSERT is a clean no-op.
--
-- `substring(key FROM length('slack:installation:') + 1)` strips the
-- prefix so the config carries the raw `team_id`. We could also harvest
-- `bot_user_id` / `workspaceName` from `value` here, but they're not
-- needed for the gate; the next admin "Reconnect" pass via
-- `SlackOAuthInstallHandler` will rewrite the full config blob.
INSERT INTO workspace_plugins
  (id, workspace_id, catalog_id, config, enabled, installed_at)
SELECT
  gen_random_uuid()::text,
  cc.value ->> 'orgId',
  'catalog:slack',
  jsonb_build_object(
    'team_id', substring(cc.key FROM length('slack:installation:') + 1),
    'backfilled_at', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'backfilled_from', 'chat_cache (migration 0088)'
  ),
  true,
  COALESCE(
    (cc.value ->> 'installedAt')::timestamptz,
    NOW()
  )
FROM chat_cache cc
WHERE cc.key LIKE 'slack:installation:%'
  AND cc.value ->> 'orgId' IS NOT NULL
  AND cc.value ->> 'orgId' <> ''
ON CONFLICT (workspace_id, catalog_id) DO NOTHING;
