-- 0087_plugin_catalog_install_model.sql
--
-- Atlas issue #2650 (1.5.2 slice 2) — extend `plugin_catalog` with
-- the columns the `CatalogSeeder` needs to seed from `atlas.config.ts`
-- and that the admin-UI install dispatch needs at runtime.
--
-- New columns:
--   * `install_model` — discriminates the install-handler family per
--     CONTEXT.md "Install models":
--       - `oauth`      — OAuth dance against operator-owned App
--                        Registration (Slack, Salesforce, Jira, GitHub
--                        Apps, Linear OAuth in 1.5.3)
--       - `form`       — customer fills credentials form (Email,
--                        Webhook, Obsidian, GitHub PAT, Linear API-key
--                        in 1.5.3)
--       - `static-bot` — operator-shared bot + per-Workspace routing id
--                        (Teams, Discord, gchat, Telegram, WhatsApp —
--                        not installable until 1.5.3)
--     CHECK constraint pins the enum at the DB layer so a typo in a
--     future seed can't land an un-dispatchable row.
--   * `saas_eligible` — gate on per-deploy-mode visibility. False rows
--     are hidden from SaaS admin UI but remain installable on self-
--     host. Canonical case: GitHub PAT mode (per-user token tied to one
--     employee — unsafe in B2B SaaS, fine on a self-host single-tenant).
--
-- Default for `install_model` is intentionally `'oauth'` so the column
-- can be added NOT NULL without backfilling — the only existing row
-- shape pre-#2650 is the dogfood Slack catalog entry, which IS OAuth.
-- The `CatalogSeeder` boot pass will overwrite per-slug values from
-- atlas.config.ts on next boot anyway, so a transient default lasting
-- one boot is fine. `saas_eligible` defaults to `true` (safe default —
-- visible unless explicitly hidden) for the same reason.

ALTER TABLE plugin_catalog
  ADD COLUMN IF NOT EXISTS install_model TEXT NOT NULL DEFAULT 'oauth';

ALTER TABLE plugin_catalog
  ADD COLUMN IF NOT EXISTS saas_eligible BOOLEAN NOT NULL DEFAULT true;

-- CHECK at the DB layer so a future seed regression (typo, wrong
-- value) fails at INSERT/UPDATE time rather than silently landing a
-- row the install dispatch can't route. Mirrors the existing
-- `chk_plugin_catalog_type` pattern.
ALTER TABLE plugin_catalog
  DROP CONSTRAINT IF EXISTS chk_plugin_catalog_install_model;
ALTER TABLE plugin_catalog
  ADD CONSTRAINT chk_plugin_catalog_install_model
  CHECK (install_model IN ('oauth', 'form', 'static-bot'));

-- Expand `type` to admit the new admin-UI groupings introduced by the
-- catalog declaration (`chat` for chat Platforms, `integration` for
-- everything else customer-installable). The pre-#2650 values
-- (`datasource`, `context`, `interaction`, `action`, `sandbox`) stay
-- accepted so existing rows from older seeds aren't invalidated.
-- Postgres requires DROP + ADD to widen a CHECK enum; ALTER CONSTRAINT
-- can't broaden a predicate.
ALTER TABLE plugin_catalog
  DROP CONSTRAINT IF EXISTS plugin_catalog_type_check;
ALTER TABLE plugin_catalog
  DROP CONSTRAINT IF EXISTS chk_plugin_catalog_type;
ALTER TABLE plugin_catalog
  ADD CONSTRAINT chk_plugin_catalog_type
  CHECK (type IN ('datasource', 'context', 'interaction', 'action', 'sandbox', 'chat', 'integration'));

-- Lookup index for the catalog query the chat plugin's AdapterRegistry
-- and the admin-UI listing both run (`WHERE type = $1 AND install_model
-- = $2 AND enabled = true`). Partial on `enabled = true` keeps the
-- index narrow.
CREATE INDEX IF NOT EXISTS idx_plugin_catalog_install_model
  ON plugin_catalog (type, install_model)
  WHERE enabled = true;
