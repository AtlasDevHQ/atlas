-- 0141_stripe_teardown_pending.sql
--
-- Atlas issue #3679 — durable Stripe teardown outbox.
--
-- Background: platform-admin workspace delete/purge cancels the org's
-- Stripe subscriptions (and, for a GDPR purge, deletes the Stripe
-- customer) BEFORE the DB cascade runs (see lib/billing/workspace-teardown.ts).
-- Those Stripe calls were "total" — a transient Stripe 5xx/timeout at that
-- instant was folded into a free-text `warnings[]` string and the cascade
-- proceeded regardless. Once the cascade ran, the local `subscription` rows
-- carrying the `stripeSubscriptionId` were gone, so the cancel target
-- survived only in the admin-action audit JSON. Net: a delete during a
-- Stripe outage left a live subscription invoicing a customer for a
-- workspace that no longer exists, and a GDPR purge could leave a billable
-- customer/PII linkage behind — recoverable only by manual dashboard cleanup.
--
-- This table is the durable outbox that closes that gap. Before the cascade,
-- any Stripe op that failed (or that drift detection found live in Stripe but
-- absent locally) is persisted here. A scheduler sweep
-- (lib/billing/reconcile-stripe-teardown.ts, the symmetric counterpart to
-- reconcile-plan-tiers.ts) retries `subscriptions.cancel` / `customers.del`
-- until success or `resource_missing`, then deletes the row.
--
-- Shape:
--   * `id` — uuid PK.
--   * `workspace_id` — the org/workspace whose teardown stranded this op.
--     TEXT, no FK: the workspace row is (or is about to be) gone — that is
--     the whole reason this outbox exists.
--   * `stripe_sub_id` / `stripe_customer_id` — the Stripe target of the op.
--     Exactly one is the operative id per `op` (enforced by the CHECK below).
--     `stripe_customer_id` is also carried on `cancel_subscription` rows for
--     operator context when present, but is not the conflict key there.
--   * `op` — `cancel_subscription` (retry `subscriptions.cancel`) or
--     `delete_customer` (retry `customers.del`).
--   * `attempts` — incremented by the sweep on each non-terminal failure;
--     surfaces a stuck op to operators via the sweep's structured log.
--   * `last_error` — most recent failure message (never a full secret;
--     Stripe ids are not secrets but are logged sparingly).
--   * `created_at` / `updated_at` — `updated_at` bumps on re-enqueue and on
--     each sweep attempt.
--
-- Idempotent enqueue: a Stripe id can only be pending once per op. The two
-- partial unique indexes below let the enqueue `ON CONFLICT ... DO UPDATE`
-- refresh `last_error`/`updated_at` instead of growing a duplicate row when
-- the same workspace teardown is retried.
--
-- Additive `CREATE TABLE IF NOT EXISTS` — N-1 deploy-safe, no two-phase drop
-- needed for the add. The legacy warnings-string path is intentionally left
-- in place (a manual-follow-up fallback); retiring it is an N+1 follow-up.

CREATE TABLE IF NOT EXISTS stripe_teardown_pending (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        TEXT NOT NULL,
  stripe_sub_id       TEXT,
  stripe_customer_id  TEXT,
  op                  TEXT NOT NULL,
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_stripe_teardown_pending_op
    CHECK (op IN ('cancel_subscription', 'delete_customer')),
  -- The op's operative id must be present: a cancel needs a subscription id,
  -- a customer delete needs a customer id.
  CONSTRAINT chk_stripe_teardown_pending_target
    CHECK (
      (op = 'cancel_subscription' AND stripe_sub_id IS NOT NULL)
      OR (op = 'delete_customer' AND stripe_customer_id IS NOT NULL)
    )
);

-- One pending cancel per Stripe subscription id (globally unique in Stripe).
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_teardown_pending_sub
  ON stripe_teardown_pending (stripe_sub_id)
  WHERE op = 'cancel_subscription';

-- One pending customer delete per Stripe customer id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_teardown_pending_customer
  ON stripe_teardown_pending (stripe_customer_id)
  WHERE op = 'delete_customer';

-- Sweep scans the whole (normally empty) table ordered by attempts; an index
-- on attempts keeps the oldest/least-tried rows cheap to surface first.
CREATE INDEX IF NOT EXISTS idx_stripe_teardown_pending_attempts
  ON stripe_teardown_pending (attempts, created_at);
