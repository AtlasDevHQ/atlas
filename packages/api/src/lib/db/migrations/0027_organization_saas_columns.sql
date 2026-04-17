-- Backfill SaaS columns on the Better Auth organization table.
--
-- Background (#1472): 0000_baseline.sql and 0020_plan_tier_rename.sql wrap
-- their organization-table ALTERs in `IF EXISTS (... table_name = 'organization')`.
-- On a fresh boot, Atlas migrations historically ran BEFORE Better Auth created
-- the organization table, so the conditional silently skipped and the migrations
-- were marked applied in __atlas_migrations — leaving workspace_status, plan_tier,
-- byot, stripe_customer_id, trial_ends_at, suspended_at, deleted_at, region, and
-- region_assigned_at permanently missing. checkResourceLimit() then 429'd every
-- request because getWorkspaceDetails could not select those columns.
--
-- This migration runs the ALTERs unconditionally. It runs after Better Auth
-- migrations in managed mode (see migrateAuthTables in lib/auth/migrate.ts), and
-- is skipped by the migration runner in non-managed modes where no organization
-- table exists. If the table is missing despite that, fail loudly so the boot
-- ordering bug surfaces immediately rather than silently re-creating the original
-- half-migrated state.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization') THEN
    RAISE EXCEPTION 'Atlas migration 0027 requires the "organization" table to exist. In managed auth mode, Better Auth migrations must run before Atlas migrations. See https://github.com/AtlasDevHQ/atlas/issues/1472.';
  END IF;
END $$;

ALTER TABLE organization ADD COLUMN IF NOT EXISTS workspace_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE organization ADD COLUMN IF NOT EXISTS plan_tier TEXT NOT NULL DEFAULT 'free';
ALTER TABLE organization ADD COLUMN IF NOT EXISTS byot BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS region_assigned_at TIMESTAMPTZ;

-- Constraints (idempotent — only added if not already present).
DO $$ BEGIN
  ALTER TABLE organization ADD CONSTRAINT chk_workspace_status
    CHECK (workspace_status IN ('active', 'suspended', 'deleted'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Drop legacy CHECK before re-adding (older installs may have the pre-rename version).
ALTER TABLE organization DROP CONSTRAINT IF EXISTS chk_plan_tier;

-- Rename legacy tier values that may exist on installs that ran 0020 before any
-- rows were inserted (idempotent — no-op if no rows match).
UPDATE organization SET plan_tier = 'starter' WHERE plan_tier = 'team';
UPDATE organization SET plan_tier = 'business' WHERE plan_tier = 'enterprise';

DO $$ BEGIN
  ALTER TABLE organization ADD CONSTRAINT chk_plan_tier
    CHECK (plan_tier IN ('free', 'trial', 'starter', 'pro', 'business'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_organization_workspace_status ON organization(workspace_status);
