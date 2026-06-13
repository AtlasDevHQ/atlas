-- 0132 — Platform-admin plan override window vs Stripe (#3427).
--
-- Platform admins set `plan_tier` directly (platform-admin.ts / admin-orgs.ts)
-- with no Stripe interaction. Before this column there was no precedence rule
-- between the two sources of truth, so an operator grant of `pro` was silently
-- overwritten by the next Stripe webhook for that org (a stray
-- `customer.subscription.updated`, a cancel, the reconciliation sweep, …).
--
-- `plan_override_until` records an OPERATOR-OWNED precedence window. When it is
-- non-NULL and in the future, the org's `plan_tier` was set by an operator and
-- the Stripe-webhook tier sync (`applyWorkspaceTier` in lib/auth/server.ts)
-- skips its write rather than clobbering the grant. NULL (or an expired
-- timestamp) means Stripe is authoritative again — the normal case.
--
-- Why a flag/expiry on the org rather than routing operator changes through
-- Stripe: an operator grant is frequently a SUPPORT action with no Stripe
-- counterpart (comp a customer, extend a trial, lock for ToS), so there is
-- often no Stripe object to mutate. A bounded expiry also auto-heals — once it
-- lapses, Stripe reasserts control with no operator cleanup needed.
--
-- This ALTERs the Better Auth `organization` table, so (like 0027/0126/0127/
-- 0131) it joins MANAGED_AUTH_MIGRATIONS in db/internal.ts and is skipped by the
-- runner in non-managed auth modes (where Better Auth never creates
-- `organization`). The `organization` table is NOT a Drizzle-managed table (not
-- in schema.ts), so there is no schema.ts mirror to update — its columns live
-- only in raw migrations (see 0027_organization_saas_columns.sql). Additive
-- column only (no drop), so no two-phase discipline applies.

DO $$ BEGIN
  -- Scope the existence check to the caller's search_path via to_regclass
  -- (same rationale as 0027 / 0131 — a sibling-schema match would pass
  -- information_schema then fail the ALTER).
  IF to_regclass('organization') IS NULL THEN
    RAISE EXCEPTION 'Atlas migration 0132 requires the "organization" table to exist. In managed auth mode, Better Auth migrations must run before Atlas migrations (#1472). Migration 0132 is registered in MANAGED_AUTH_MIGRATIONS so non-managed deploys skip it.';
  END IF;
END $$;

ALTER TABLE organization ADD COLUMN IF NOT EXISTS plan_override_until TIMESTAMPTZ;
