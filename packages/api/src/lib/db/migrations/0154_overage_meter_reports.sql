-- 0154: Overage-meter report ledger (#3992).
--
-- Idempotency + reconciliation for the `OverageMeter` reporter
-- (lib/billing/overage-meter.ts), which flushes each billing period's token
-- overage to Stripe Billing Meters (`meter_events`) on a scheduler tick.
--
-- One row per (org, billing period). `reported_tokens` is the CUMULATIVE
-- output-equivalent overage already reported to Stripe for that period. Each
-- tick computes `currentOverage - reported_tokens` (the delta), reports ONLY
-- that delta to the meter, then advances `reported_tokens` to the new
-- cumulative — so:
--   • idempotency  — the same delta reported twice bills once (the second tick
--     sees the advanced cumulative and computes a zero delta), backstopped by a
--     deterministic Stripe `meter_event` identifier within Stripe's 24h dedup
--     window for the crash-between-report-and-record gap.
--   • reconciliation — `reported_tokens` per (org, period) is the ledgered
--     record of what Stripe was told, cross-checkable against the meter sum.
--
-- The reporter advances the cumulative with GREATEST(existing, new) so a
-- late/retried tick can never REGRESS it (which would re-report — and so
-- double-bill — already-reported tokens). The CHECK keeps it non-negative.
--
-- NOT Better-Auth-dependent: no FK to the `organization`/`subscription`
-- tables (it holds only an org id + period + Stripe customer id), so it is
-- created in every auth mode, exactly like `stripe_webhook_events` (0128).
CREATE TABLE IF NOT EXISTS overage_meter_reports (
  org_id TEXT NOT NULL,
  -- Inclusive start of the billing period this row meters (the Stripe
  -- subscription period when active, else the UTC calendar month) — the same
  -- window `getCurrentPeriodUsage` returns. A new period gets a fresh row, so
  -- its cumulative resets to 0 and overage re-accrues from the new anchor.
  period_start TIMESTAMPTZ NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  -- Cumulative output-equivalent overage tokens reported to Stripe for this
  -- (org, period). Monotonic within a period (advanced via GREATEST).
  reported_tokens BIGINT NOT NULL DEFAULT 0,
  -- The last Stripe `meter_event` identifier sent for this row — observability
  -- + a breadcrumb for reconciliation against the meter.
  last_event_identifier TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, period_start),
  CONSTRAINT chk_overage_meter_reports_tokens_nonneg CHECK (reported_tokens >= 0)
);

-- Operational scans (recent reports / reconciliation sweeps).
CREATE INDEX IF NOT EXISTS idx_overage_meter_reports_updated
  ON overage_meter_reports (updated_at);
