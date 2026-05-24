-- 0094_placeholder_chat_coming_soon.sql
--
-- 1.5.3 slice 9 (#2747 / PRD #2738 / ADR-0007) — one-time DB nudge for
-- the five chat-Platform placeholders shipped as `enabled=false` in
-- 1.5.2's catalog declaration (Teams / Discord / gchat / Telegram /
-- WhatsApp). Slice 9 promotes them to `enabled=true,
-- implementation_status='coming_soon'` so they render as visible,
-- inert "Coming soon" cards in `/admin/integrations` per the slice-9
-- UX deliverable.
--
-- Why a migration instead of letting the catalog seeder do it: the
-- seeder's `planCatalogSeed` planner contains a "preserve-disabled"
-- branch (DB `enabled=false` beats config `enabled=true`) intended to
-- protect operator emergency-disables. Without this migration the
-- placeholder rows would stay stuck at `enabled=false` on next boot
-- even after deploy/api/atlas.config.ts flips to `enabled=true`,
-- because the planner can't distinguish "config history said false"
-- from "ops just disabled this".
--
-- Idempotent: only updates rows that match the placeholder set AND
-- still hold the pre-#2747 state (`enabled = false AND
-- implementation_status = 'available'`). On self-host without these
-- rows declared the migration is a no-op (UPDATE affects 0 rows).
-- On a subsequent operator emergency-disable, the seeder's
-- preserve-disabled branch takes over and the migration doesn't
-- re-fire (the WHERE clause excludes already-promoted rows).
--
-- Slices 10-16 (the individual chat-Platform install slices) flip
-- their row's `implementation_status` to `'available'` via the
-- atlas.config.ts edit + catalog seeder upsert — no further DB
-- migration needed.

UPDATE plugin_catalog
SET enabled = true,
    implementation_status = 'coming_soon',
    updated_at = NOW()
WHERE slug IN ('teams', 'discord', 'gchat', 'telegram', 'whatsapp')
  AND enabled = false
  AND implementation_status = 'available';
