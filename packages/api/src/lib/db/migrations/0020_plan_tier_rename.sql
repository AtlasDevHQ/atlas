-- Rename legacy plan tiers to new per-seat pricing tiers.
-- team → starter, enterprise → business.
--
-- The plan_tier column is added conditionally in 0000_baseline.sql (inside an
-- IF EXISTS block). If the organization table was created by Better Auth AFTER
-- the baseline ran, the column won't exist yet. Add it first.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization') THEN
    -- Ensure all baseline columns exist (may have been skipped by baseline's conditional block
    -- if organization table was created by Better Auth AFTER baseline migration ran)
    ALTER TABLE organization ADD COLUMN IF NOT EXISTS workspace_status TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE organization ADD COLUMN IF NOT EXISTS plan_tier TEXT NOT NULL DEFAULT 'free';
    ALTER TABLE organization ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
    ALTER TABLE organization ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE organization ADD COLUMN IF NOT EXISTS byot BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE organization ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
    ALTER TABLE organization ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
    ALTER TABLE organization ADD COLUMN IF NOT EXISTS region TEXT;
    ALTER TABLE organization ADD COLUMN IF NOT EXISTS region_assigned_at TIMESTAMPTZ;

    -- Ensure baseline constraints + index
    BEGIN
      ALTER TABLE organization ADD CONSTRAINT chk_workspace_status CHECK (workspace_status IN ('active', 'suspended', 'deleted'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    CREATE INDEX IF NOT EXISTS idx_organization_workspace_status ON organization(workspace_status);

    -- Drop old CHECK before updating values (old constraint rejects new tier names)
    ALTER TABLE organization DROP CONSTRAINT IF EXISTS chk_plan_tier;

    -- Rename legacy tier values
    UPDATE organization SET plan_tier = 'starter' WHERE plan_tier = 'team';
    UPDATE organization SET plan_tier = 'business' WHERE plan_tier = 'enterprise';

    -- Add new CHECK constraint with updated tier names
    BEGIN
      ALTER TABLE organization ADD CONSTRAINT chk_plan_tier
        CHECK (plan_tier IN ('free', 'trial', 'starter', 'pro', 'business'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;
