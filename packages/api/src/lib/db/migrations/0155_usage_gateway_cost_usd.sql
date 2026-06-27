-- Migration 0155: at-cost gateway.cost capture (#4036, Structure B WS2).
--
-- Atlas resolves models through the Vercel AI Gateway, which returns the ACTUAL
-- charged cost per generation as providerMetadata.gateway.cost (USD decimal,
-- zero-markup). The Structure B billing model (2026-06-27) is designed to draw
-- the included usage credit and the overage meter against the SUM of this real
-- dollar cost (once #4038/#4039 land), so each agent turn records its gateway
-- cost alongside its token usage now.
--
-- This column stores the turn's total gateway cost in USD (summed across the
-- turn's steps[], since the AI-SDK top-level providerMetadata is final-step
-- only). It is added to BOTH usage tables:
--   - usage_events   — the billing/metering aggregate sums this per period.
--   - token_usage    — the per-turn record, kept in lockstep with usage_events
--                      so the demo/cost rollup reads cost from one row.
--
-- numeric(12, 6): up to 999,999.999999 USD with micro-dollar precision — a
-- single turn's cost is fractions of a dollar; a workspace's period sum stays
-- well under the ceiling. Nullable, no default: NULL means "no gateway cost
-- recorded" (non-gateway / BYOK-direct providers, or rows predating this
-- migration) — distinct from 0 ("cost was zero"). Aggregation reads
-- COALESCE(SUM(gateway_cost_usd), 0) so NULL rows simply don't contribute.
--
-- Mirrored in db/schema.ts (usageEvents.gatewayCostUsd, tokenUsage.gatewayCostUsd)
-- in the same PR per the schema-drift discipline. Pure-additive: the column is
-- summed into the period usage rollup for display, but no meter/enforcement
-- draws against it yet — the enforcement/meter re-denomination lands in later
-- Structure B slices (#4038/#4039).
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` is a no-op on re-run.

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS gateway_cost_usd numeric(12, 6);

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS gateway_cost_usd numeric(12, 6);

COMMENT ON COLUMN usage_events.gateway_cost_usd IS
  'Provider-cost USD for the turn from Vercel AI Gateway providerMetadata.gateway.cost, summed across steps (#4036, Structure B). NULL for non-gateway providers and rows predating this migration; billing aggregation reads COALESCE(SUM(gateway_cost_usd), 0).';

COMMENT ON COLUMN token_usage.gateway_cost_usd IS
  'Provider-cost USD for the turn from Vercel AI Gateway providerMetadata.gateway.cost, summed across steps (#4036, Structure B). NULL for non-gateway providers and rows predating this migration.';
