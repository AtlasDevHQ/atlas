-- Migration 0095: Telegram-related DB nudges for slice #2748.
--
-- Two distinct one-time changes the catalog seeder + handler can't make
-- on their own, bundled because both fire on the same code release:
--
--   1. Add `telegram` to the two approval-surface CHECK enums (extends
--      0052's set).
--   2. Promote the `telegram` catalog row's `implementation_status` from
--      `coming_soon` (set by 0094 / #2747) to `available`. The catalog
--      seeder's upsert intentionally does NOT write the
--      `implementation_status` column (the column is operator-only
--      surface state per ADR-0007), so without a one-time UPDATE the
--      telegram row stays inert in the admin UI even though slice #2748
--      shipped the handler.
--
-- Discord / gchat / WhatsApp (the remaining Phase D static-bot
-- platforms — #2749 / #2754 / #2753) will land analogous nudges in
-- their own slices: an enum-bump here for their slug + an UPDATE that
-- promotes their `implementation_status`. Landing them per-slice keeps
-- the PR scope honest and the rollback story clean.
--
-- All four statements are idempotent:
--   • DROP CONSTRAINT IF EXISTS + ADD with the new body — Postgres has
--     no `ALTER CHECK`, and `IF NOT EXISTS` on `ADD CONSTRAINT` only
--     guards against re-runs (it doesn't detect a different constraint
--     body). The drops are NO-OP-safe via `IF EXISTS`.
--   • UPDATE with a WHERE that includes the pre-state — re-running
--     after a row has already been promoted is a no-op (0 rows
--     affected).

-- ── Approval-surface enum extension ──────────────────────────────────

ALTER TABLE approval_rules DROP CONSTRAINT IF EXISTS chk_approval_rule_surface;
ALTER TABLE approval_rules
  ADD CONSTRAINT chk_approval_rule_surface
  CHECK (surface IN ('any', 'chat', 'mcp', 'scheduler', 'slack', 'teams', 'telegram', 'webhook'));

ALTER TABLE approval_queue DROP CONSTRAINT IF EXISTS chk_approval_request_surface;
ALTER TABLE approval_queue
  ADD CONSTRAINT chk_approval_request_surface
  CHECK (surface IS NULL OR surface IN ('chat', 'mcp', 'scheduler', 'slack', 'teams', 'telegram', 'webhook'));

COMMENT ON COLUMN approval_rules.surface IS
  'Origin surface this rule applies to. ''any'' fires for every request (pre-2072 default); ''chat'' / ''mcp'' / ''scheduler'' / ''slack'' / ''teams'' / ''telegram'' / ''webhook'' scope to the named transport. See packages/api/src/lib/approvals/evaluate.ts (#2072, telegram added in #2748).';

-- ── Implementation-status promotion ──────────────────────────────────
-- Pre-condition: 0094 (#2747) flipped telegram to `coming_soon`. If
-- an earlier deploy somehow skipped 0094 the row may still be
-- `available`; the WHERE clause makes either case a no-op.

UPDATE plugin_catalog
SET implementation_status = 'available',
    updated_at = NOW()
WHERE slug = 'telegram'
  AND implementation_status = 'coming_soon';
