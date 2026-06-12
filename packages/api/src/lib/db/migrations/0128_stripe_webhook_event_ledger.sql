-- 0128: Stripe webhook event ledger (#3423).
--
-- The @better-auth/stripe plugin ACKs 200 even when Atlas's
-- onSubscription* hooks throw, and Stripe replays deliveries — so the
-- must-not-be-lost sync (plan-tier write + CRM conversion stamp) moved
-- into `onEvent`, where throws DO propagate as 400s and trigger Stripe's
-- retry. This table gives that path:
--   • idempotency — processed `event_id`s are recorded; replays no-op
--   • ordering    — `event_created` per `stripe_subscription_id` lets a
--     delayed older event be ignored instead of regressing status/plan
--     (last-applied-wins, not last-delivered-wins)
--
-- Rows are pruned by the reconciliation sweep after STRIPE_EVENT_LEDGER
-- retention (30 days) — Stripe's own retry horizon is ~3 weeks, so a
-- pruned event can no longer be replayed by Stripe itself.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  event_created TIMESTAMPTZ NOT NULL,
  stripe_subscription_id TEXT,
  -- Plan tier this event's sync actually WROTE to the org (NULL when the
  -- event applied no tier). The reconciliation sweep prefers the newest
  -- non-null value here over the plugin's `subscription.plan` column:
  -- the plugin writes its row last-DELIVERED-wins, so a stale older
  -- delivery can regress the row even though the ledger correctly
  -- skipped the Atlas-side sync — healing from the row would undo the
  -- ordering protection this ledger exists for.
  applied_plan_tier TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ordering lookups: newest applied event per subscription.
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_sub
  ON stripe_webhook_events (stripe_subscription_id, event_created DESC);

-- Retention pruning scans.
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_processed
  ON stripe_webhook_events (processed_at);
