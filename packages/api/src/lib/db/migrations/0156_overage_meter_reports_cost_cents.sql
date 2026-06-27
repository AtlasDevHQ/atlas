-- Migration 0156: re-denominate the overage-meter ledger from output-equivalent
-- TOKENS to at-cost CENTS (#4039, Structure B WS2 — S4).
--
-- Structure B (#4034) bills usage overage at provider COST (zero markup), so the
-- `OverageMeter` reporter (lib/billing/overage-meter.ts) now flushes each paid
-- workspace's at-cost dollar overage — `costUsd − includedCredit` (#4038's
-- `computeOverageDollars`) — to a NEW dollar-denominated Stripe Billing Meter,
-- in place of the token deltas it reported to the old `atlas_token_overage`
-- meter (#3992).
--
-- ## Unit decision: INTEGER CENTS (the issue left this to the implementer)
--
-- The meter event `value`, this ledger column, and the delta math are ALL in
-- integer cents. Cents (not fractional dollars) because:
--   • Lossless: Stripe sums meter-event values; integers carry no float drift,
--     and the baseline-keyed crash-window dedup stays exact (no rounding seam
--     between the stored baseline and the reported delta).
--   • The Stripe overage price is `unit_amount = 1` (1 cent / metered unit), so
--     `cents reported × $0.01 = the at-cost dollars` — billed 1:1, at cost.
--   • Reuses this table's existing BIGINT + non-negative-CHECK shape unchanged
--     (just renamed + re-semantic'd), so the migration surface is minimal.
-- The column is named `reported_cost_cents` (not the issue's suggested
-- `reported_cost_usd`) so the name states the actual stored unit.
--
-- ## Expand-contract phase 1 of 2 (two-phase column swap)
--
-- This is the EXPAND phase: it ADDs `reported_cost_cents` and the reporter
-- switches its reads/writes to it in this same release. The old
-- `reported_tokens` column is LEFT IN PLACE — its `NOT NULL DEFAULT 0` means
-- inserts that no longer mention it still satisfy the constraint, so the N-1↔N
-- deploy-overlap window never hits a missing column. The CONTRACT phase (drop
-- `reported_tokens` + its CHECK, and remove the schema.ts mirror) ships in a
-- later release (N+1), once no running code reads or writes it. Tracked as the
-- #4039 follow-up.
--
-- ## No backfill — the new meter starts fresh, on purpose
--
-- `reported_tokens` and `reported_cost_cents` are DIFFERENT units (tokens vs
-- cents) with no per-row cost basis to convert between them, AND they track
-- cumulative-reported against DIFFERENT Stripe meters (`atlas_token_overage`
-- vs the new at-cost cents meter). The new meter has been told nothing yet, so
-- its cumulative legitimately starts at 0 — a fresh `DEFAULT 0` column is the
-- CORRECT baseline, not a data loss. (Operationally the old token meter/prices
-- are deactivated at cutover so the same period is never billed on both; on the
-- pre-customer sandbox/staging this overlap carries no real overage.)
--
-- Mirrored in db/schema.ts (overageMeterReports.reportedCents) in the same PR
-- per the schema-drift discipline; `reported_tokens`/`reportedTokens` stay
-- mirrored until the N+1 contract drop. NOT Better-Auth-dependent (no FK to a
-- BA table), so it runs in every auth mode like 0154 itself.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` is a no-op on re-run; the CHECK uses
-- drop-then-add (Postgres has no `ADD CONSTRAINT IF NOT EXISTS`) — the migration
-- is recorded in __atlas_migrations so it runs exactly once regardless.

ALTER TABLE overage_meter_reports
  ADD COLUMN IF NOT EXISTS reported_cost_cents BIGINT NOT NULL DEFAULT 0;

ALTER TABLE overage_meter_reports
  DROP CONSTRAINT IF EXISTS chk_overage_meter_reports_cost_cents_nonneg;

ALTER TABLE overage_meter_reports
  ADD CONSTRAINT chk_overage_meter_reports_cost_cents_nonneg
    CHECK (reported_cost_cents >= 0);

COMMENT ON COLUMN overage_meter_reports.reported_cost_cents IS
  'Cumulative at-cost overage CENTS reported to the Stripe at-cost overage meter for this (org, period). Monotonic within a period (advanced via GREATEST). Integer cents bill 1:1 against the unit_amount=1 metered price (#4039, Structure B). Supersedes reported_tokens (dropped in a later release).';
