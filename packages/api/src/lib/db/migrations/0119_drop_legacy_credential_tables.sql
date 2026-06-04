-- 0119 — Drop the four legacy static-bot credential tables (#3161).
--
-- `teams_installations`, `telegram_installations`, `gchat_installations`, and
-- `whatsapp_installations` predate the unified install pipeline (ADR-0007).
-- Since the cap-gated static-bot installs landed (#3141–#3144, umbrella #2994),
-- every static-bot install persists its routing identifier to
-- `workspace_plugins.config` and the inbound resolvers in
-- `lib/chat-plugin/executeQuery.ts` read exclusively from `workspace_plugins`.
-- These four tables are no longer written by any install path nor read by any
-- routing path — they are vestigial. With #3154 GAP 1 routing disconnect
-- through the unified `WorkspaceInstaller.uninstall` (a `workspace_plugins`
-- DELETE), the legacy per-platform disconnect endpoints that targeted these
-- tables are removed in the same change, so nothing references them.
--
-- `discord_installations` is intentionally NOT dropped: it still backs the
-- self-hosted Discord BYOT bot-token path (admin-integrations.ts
-- `POST /discord/byot` → `saveDiscordInstallation`).
--
-- Plain DROP TABLE (no Better Auth tables touched), so this migration needs no
-- MANAGED_AUTH_MIGRATIONS entry. CASCADE drops the attached `idx_*_org`
-- indexes; no FKs reference these tables.

DROP TABLE IF EXISTS teams_installations CASCADE;
DROP TABLE IF EXISTS telegram_installations CASCADE;
DROP TABLE IF EXISTS gchat_installations CASCADE;
DROP TABLE IF EXISTS whatsapp_installations CASCADE;
