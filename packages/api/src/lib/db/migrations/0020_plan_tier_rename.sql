-- Rename legacy plan tiers to new per-seat pricing tiers.
-- team → starter, enterprise → business.
UPDATE organization SET plan_tier = 'starter' WHERE plan_tier = 'team';
UPDATE organization SET plan_tier = 'business' WHERE plan_tier = 'enterprise';

-- Update CHECK constraint to new tier values.
ALTER TABLE organization DROP CONSTRAINT IF EXISTS chk_plan_tier;

DO $$ BEGIN
  ALTER TABLE organization ADD CONSTRAINT chk_plan_tier
    CHECK (plan_tier IN ('free', 'trial', 'starter', 'pro', 'business'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
