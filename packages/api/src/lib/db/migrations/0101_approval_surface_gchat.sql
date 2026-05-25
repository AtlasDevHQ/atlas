-- Migration 0101: Google Chat-related DB nudges for slice #2754.
--
-- Mirrors 0095 (Telegram, #2748), 0099 (Discord, #2749), and 0100
-- (WhatsApp, #2753) for the Google Chat platform — two distinct
-- one-time changes the catalog seeder + handler can't make on their
-- own, bundled because both fire on the same code release:
--
--   1. Add `gchat` to the two approval-surface CHECK enums (extends
--      0100's WhatsApp-added set).
--   2. Promote the `gchat` catalog row's `implementation_status` from
--      `coming_soon` (set by 0094 / #2747) to `available`. The catalog
--      seeder's upsert intentionally does NOT write the
--      `implementation_status` column (operator-only surface state per
--      ADR-0007), so without a one-time UPDATE the gchat row stays
--      inert in the admin UI even though slice #2754 shipped the handler.
--
-- With #2754 + #2753 both merged, Phase E (#2755) closes the milestone.
--
-- All statements are idempotent — same shape as 0095 / 0099 / 0100.

-- ── Approval-surface enum extension ──────────────────────────────────

ALTER TABLE approval_rules DROP CONSTRAINT IF EXISTS chk_approval_rule_surface;
ALTER TABLE approval_rules
  ADD CONSTRAINT chk_approval_rule_surface
  CHECK (surface IN ('any', 'chat', 'mcp', 'scheduler', 'slack', 'teams', 'telegram', 'discord', 'whatsapp', 'gchat', 'webhook'));

ALTER TABLE approval_queue DROP CONSTRAINT IF EXISTS chk_approval_request_surface;
ALTER TABLE approval_queue
  ADD CONSTRAINT chk_approval_request_surface
  CHECK (surface IS NULL OR surface IN ('chat', 'mcp', 'scheduler', 'slack', 'teams', 'telegram', 'discord', 'whatsapp', 'gchat', 'webhook'));

COMMENT ON COLUMN approval_rules.surface IS
  'Origin surface this rule applies to. ''any'' fires for every request (pre-2072 default); ''chat'' / ''mcp'' / ''scheduler'' / ''slack'' / ''teams'' / ''telegram'' / ''discord'' / ''whatsapp'' / ''gchat'' / ''webhook'' scope to the named transport. See packages/api/src/lib/approvals/evaluate.ts (#2072; telegram added in #2748; discord added in #2749; whatsapp added in #2753; gchat added in #2754).';

-- ── Implementation-status promotion ──────────────────────────────────
-- The WHERE clause makes this UPDATE both idempotent (re-runs skip
-- already-promoted rows) AND safe on deploys that bypassed 0094
-- (#2747) — when the row never had `coming_soon`, the WHERE doesn't
-- match and the UPDATE is a no-op.

UPDATE plugin_catalog
SET implementation_status = 'available',
    updated_at = NOW()
WHERE slug = 'gchat'
  AND implementation_status = 'coming_soon';
