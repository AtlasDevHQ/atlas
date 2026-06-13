-- 0129: Tombstones for Stripe subscriptions erased by GDPR purge (#3468).
--
-- `purgeStripeBillingForWorkspace` cancels the org's subscriptions and
-- `hardDeleteWorkspace` removes the local `subscription` +
-- `stripe_webhook_events` rows — but those cancellations themselves
-- generate `customer.subscription.deleted` webhooks that arrive AFTER
-- the purge transaction. The webhook path records events in
-- `stripe_webhook_events` keyed on the Stripe subscription id even when
-- no org resolves, so a completed purge immediately regrew ledger rows.
-- A purge must be terminal: `hardDeleteWorkspace` stamps a tombstone per
-- purged subscription id inside the purge transaction, and
-- `classifyStripeEvent` skips (and never records) deliveries for
-- tombstoned ids.
--
-- Bounded surface: rows carry only the Stripe subscription id (no tenant
-- data) and are pruned by the reconciliation sweep after 30 days —
-- Stripe's own retry horizon is ~3 weeks, so no post-purge delivery for
-- the id can outlive its tombstone.
CREATE TABLE IF NOT EXISTS stripe_purged_subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  purged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retention pruning scans.
CREATE INDEX IF NOT EXISTS idx_stripe_purged_subscriptions_purged_at
  ON stripe_purged_subscriptions (purged_at);
