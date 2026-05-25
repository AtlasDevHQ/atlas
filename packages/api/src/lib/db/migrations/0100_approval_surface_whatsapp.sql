-- Migration 0100: WhatsApp-related DB nudges for slice #2753.
--
-- Mirrors 0099 (Discord, #2749) for the WhatsApp platform — two
-- distinct one-time changes the catalog seeder + handler can't make on
-- their own, bundled because both fire on the same code release:
--
--   1. Add `whatsapp` to the two approval-surface CHECK enums (extends
--      0099's Discord-added set).
--   2. Promote the `whatsapp` catalog row's `implementation_status`
--      from `coming_soon` (set by 0094 / #2747) to `available`. The
--      catalog seeder's upsert intentionally does NOT write the
--      `implementation_status` column (operator-only surface state per
--      ADR-0007), so without a one-time UPDATE the whatsapp row stays
--      inert in the admin UI even though slice #2753 shipped the handler.
--
-- gchat (the remaining Phase D static-bot platform — #2754) will land
-- analogous nudges in its own slice.
--
-- All statements are idempotent — same shape as 0095 / 0099.

-- ── Approval-surface enum extension ──────────────────────────────────

ALTER TABLE approval_rules DROP CONSTRAINT IF EXISTS chk_approval_rule_surface;
ALTER TABLE approval_rules
  ADD CONSTRAINT chk_approval_rule_surface
  CHECK (surface IN ('any', 'chat', 'mcp', 'scheduler', 'slack', 'teams', 'telegram', 'discord', 'whatsapp', 'webhook'));

ALTER TABLE approval_queue DROP CONSTRAINT IF EXISTS chk_approval_request_surface;
ALTER TABLE approval_queue
  ADD CONSTRAINT chk_approval_request_surface
  CHECK (surface IS NULL OR surface IN ('chat', 'mcp', 'scheduler', 'slack', 'teams', 'telegram', 'discord', 'whatsapp', 'webhook'));

COMMENT ON COLUMN approval_rules.surface IS
  'Origin surface this rule applies to. ''any'' fires for every request (pre-2072 default); ''chat'' / ''mcp'' / ''scheduler'' / ''slack'' / ''teams'' / ''telegram'' / ''discord'' / ''whatsapp'' / ''webhook'' scope to the named transport. See packages/api/src/lib/approvals/evaluate.ts (#2072; telegram added in #2748; discord added in #2749; whatsapp added in #2753).';

-- ── Implementation-status promotion ──────────────────────────────────
-- Pre-condition: 0094 (#2747) flipped whatsapp to `coming_soon`. The
-- WHERE clause makes either case a no-op if a deploy bypassed 0094.

UPDATE plugin_catalog
SET implementation_status = 'available',
    updated_at = NOW()
WHERE slug = 'whatsapp'
  AND implementation_status = 'coming_soon';
