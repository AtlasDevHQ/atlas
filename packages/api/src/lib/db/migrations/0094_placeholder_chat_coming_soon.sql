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
-- Idempotent + operator-intent-safe: the WHERE clause has FOUR terms,
-- each load-bearing:
--   1. `slug IN (...)` — scope to the 1.5.2 placeholder set only
--   2. `enabled = false` — pre-#2747 default state for these rows
--   3. `implementation_status = 'available'` — pre-#2747 default state
--   4. `updated_at = created_at` — row has NEVER been touched since
--      the seed wrote it. This is the operator-intent guard: a
--      self-host operator who disabled `discord` after slice-2 seeded
--      it (catalog upsert bumps `updated_at` via `NOW()` on every
--      write) keeps their `enabled = false` decision. Without this
--      clause we'd un-disable rows the operator deliberately
--      disabled — see PR-review feedback on #2782.
--
-- On self-host without these rows declared the migration is a no-op
-- (UPDATE affects 0 rows). On any subsequent operator action the
-- WHERE clause stops matching and re-runs are inert. Slices 10-16
-- (the individual chat-Platform install slices) flip their row's
-- `implementation_status` to `'available'` via the atlas.config.ts
-- edit + catalog seeder upsert — no further DB migration needed.

UPDATE plugin_catalog
SET enabled = true,
    implementation_status = 'coming_soon',
    updated_at = NOW()
WHERE slug IN ('teams', 'discord', 'gchat', 'telegram', 'whatsapp')
  AND enabled = false
  AND implementation_status = 'available'
  AND updated_at = created_at;
