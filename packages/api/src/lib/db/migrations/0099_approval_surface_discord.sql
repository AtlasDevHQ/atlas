-- Migration 0099: Discord-related DB nudges for slice #2749.
--
-- Mirrors 0095 (Telegram, #2748) for the Discord platform — two
-- distinct one-time changes the catalog seeder + handler can't make
-- on their own, bundled because both fire on the same code release:
--
--   1. Add `discord` to the two approval-surface CHECK enums (extends
--      0095's Telegram-added set).
--   2. Promote the `discord` catalog row's `implementation_status` from
--      `coming_soon` (set by 0094 / #2747) to `available`. The catalog
--      seeder's upsert intentionally does NOT write the
--      `implementation_status` column (operator-only surface state per
--      ADR-0007), so without a one-time UPDATE the discord row stays
--      inert in the admin UI even though slice #2749 shipped the handler.
--
-- gchat / WhatsApp (the remaining Phase D static-bot platforms —
-- #2754 / #2753) will land analogous nudges in their own slices.
--
-- All four statements are idempotent — same shape as 0095.

-- ── Approval-surface enum extension ──────────────────────────────────

ALTER TABLE approval_rules DROP CONSTRAINT IF EXISTS chk_approval_rule_surface;
ALTER TABLE approval_rules
  ADD CONSTRAINT chk_approval_rule_surface
  CHECK (surface IN ('any', 'chat', 'mcp', 'scheduler', 'slack', 'teams', 'telegram', 'discord', 'webhook'));

ALTER TABLE approval_queue DROP CONSTRAINT IF EXISTS chk_approval_request_surface;
ALTER TABLE approval_queue
  ADD CONSTRAINT chk_approval_request_surface
  CHECK (surface IS NULL OR surface IN ('chat', 'mcp', 'scheduler', 'slack', 'teams', 'telegram', 'discord', 'webhook'));

COMMENT ON COLUMN approval_rules.surface IS
  'Origin surface this rule applies to. ''any'' fires for every request (pre-2072 default); ''chat'' / ''mcp'' / ''scheduler'' / ''slack'' / ''teams'' / ''telegram'' / ''discord'' / ''webhook'' scope to the named transport. See packages/api/src/lib/approvals/evaluate.ts (#2072; telegram added in #2748; discord added in #2749).';

-- ── Implementation-status promotion ──────────────────────────────────
-- Pre-condition: 0094 (#2747) flipped discord to `coming_soon`. The
-- WHERE clause makes either case a no-op if a deploy bypassed 0094.

UPDATE plugin_catalog
SET implementation_status = 'available',
    updated_at = NOW()
WHERE slug = 'discord'
  AND implementation_status = 'coming_soon';
