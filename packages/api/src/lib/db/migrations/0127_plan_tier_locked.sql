-- 0127: widen organization.chk_plan_tier with the 'locked' churn tier (#3421).
--
-- 'locked' is the SaaS landing tier when a subscription actually ends
-- (customer.subscription.deleted → onSubscriptionDeleted): zero
-- entitlements, resubscribe CTA. Pre-#3421 the churn hooks downgraded to
-- 'free', which on SaaS bypasses ALL enforcement (enforcement.ts treats
-- 'free' as the unlimited self-hosted tier) — scheduling a cancellation
-- would have granted unlimited usage permanently. One tier, three
-- consumers by design: this churn path, #3426's second-org-no-trial
-- policy, and #3424's `unpaid` delinquency step.
--
-- The constraint is dropped and re-added (not ALTERed) because Postgres
-- has no ALTER CONSTRAINT for CHECK predicates. No rows can hold 'locked'
-- yet, so the re-add never fails validation.
ALTER TABLE organization DROP CONSTRAINT IF EXISTS chk_plan_tier;
ALTER TABLE organization ADD CONSTRAINT chk_plan_tier
  CHECK (plan_tier IN ('free', 'trial', 'starter', 'pro', 'business', 'locked'));
