-- Migration 0152: output-equivalent (weighted) token accounting (#3989, WS2).
--
-- The "model-aware budget" is denominated in output-equivalent tokens: a turn's
-- raw input/output tokens are normalized by a per-model weight (reference model
-- = 1.0) at agent-step accounting time. This column stores that weighted value
-- ALONGSIDE the raw `quantity`, so period-usage summation and budget math can
-- sum the weighted token spend without re-deriving it (the model id needed to
-- weight a row is only in `metadata`, and back-deriving it per row at query
-- time would be both slow and lossy).
--
-- Scope: populated only for `event_type = 'token'` rows written after this
-- migration (the agent onFinish path supplies it). It is left NULL for:
--   - rows predating this migration (no weight was computed), and
--   - non-token events (`query`, `login`), which carry no token spend.
-- Budget/period summation therefore reads `COALESCE(weighted_quantity, quantity)`
-- so legacy token rows still contribute their raw count (a safe, slightly
-- conservative under-weighting) until they age out of the billing window.
--
-- Nullable, no default: NULL is meaningful here ("not weighted"), distinct from
-- 0 ("weighted to zero"). Mirrored in db/schema.ts (`usageEvents.weightedQuantity`)
-- in the same PR per the schema-drift discipline.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` is a no-op on re-run.

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS weighted_quantity integer;

COMMENT ON COLUMN usage_events.weighted_quantity IS
  'Output-equivalent (model-weighted) token count for token events (#3989). Raw tokens normalized by the per-model TokenWeighting table (reference model = 1.0). NULL for non-token events and for rows predating this migration; budget summation reads COALESCE(weighted_quantity, quantity).';
