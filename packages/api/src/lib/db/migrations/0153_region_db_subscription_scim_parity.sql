-- 0153 — region-DB schema parity: subscription + scim_group_mappings (#4019).
--
-- The EU/APAC prod region internal DBs were missing two tables the US DB has —
-- `subscription` and `scim_group_mappings`. `hardDeleteWorkspace` (the
-- GDPR-grade workspace purge SSOT in db/internal.ts) DELETEs from both inside a
-- single transaction. The `subscription` deletes are already to_regclass-probed
-- (the table only exists on Stripe deployments), so a MISSING `subscription` was
-- tolerated. But the `scim_group_mappings` DELETE was UNCONDITIONAL, so in
-- EU/APAC it hit `relation "scim_group_mappings" does not exist` and rolled the
-- whole purge back — a workspace stuck soft-deleted, never hard-purged. That is
-- a data-residency / GDPR-erasure failure for EU/APAC workspaces. (This PR also
-- adds a matching to_regclass probe to that scim DELETE in hardDeleteWorkspace,
-- so a region still missing `scim_group_mappings` skips it instead of aborting —
-- the same guard `subscription` already had.)
--
-- Why these two drifted (same root cause, two paths):
--   * `subscription` is the @better-auth/stripe plugin's table. Better Auth only
--     creates it in `ctx.runMigrations()` when the stripe plugin is registered,
--     and the plugin is registered only when STRIPE_SECRET_KEY is set
--     (auth/server.ts buildPlugins). Billing runs in US only per the
--     per-service env, so the passive EU/APAC Better Auth instances never
--     register the plugin and never create the table.
--   * `scim_group_mappings` ships in 0000_baseline.sql, but the already-
--     provisioned EU/APAC region DBs recorded the baseline as applied before it
--     materialized there, so it never landed. A forward `IF NOT EXISTS` re-
--     assert closes that drift the normal migration way (acceptance criterion:
--     "applied via the normal migration path, not ad-hoc DDL").
--
-- Ordering / idempotency: this migration is a no-op wherever the tables already
-- exist. On US, Better Auth's `runMigrations()` (boot step 1) creates
-- `subscription` BEFORE Atlas migrations (step 2) run, so the `IF NOT EXISTS`
-- here simply confirms it; the migration only *materializes* the tables on the
-- passive regions (and on self-hosted non-managed installs, where they are
-- harmless empty tables the existing `subscription` probe in hardDeleteWorkspace
-- already tolerated).
--
-- The `subscription` DDL below MUST mirror what @better-auth/stripe v1.6.x makes
-- on US, so the BA-created (US) and migration-created (EU/APAC) tables converge
-- to one shape. Better Auth's Postgres migrator (better-auth/db/get-migration)
-- maps field types: string→text, date→timestamptz, number→integer,
-- boolean→boolean, the `id` primary key→text, `required: false`→nullable, and
-- does NOT emit a SQL DEFAULT for non-date `defaultValue`s (those are applied in
-- app code). Column names stay camelCase, so they are quoted here.
--
-- NOT in MANAGED_AUTH_MIGRATIONS (db/internal.ts): neither table has a foreign
-- key to a Better Auth table, so both CREATEs succeed without the `user` /
-- `organization` tables present. Keeping it out of the skip set means it runs in
-- every mode — `scim_group_mappings` keeps its baseline always-create behavior,
-- and `subscription` materializes everywhere. migrate-pg.test.ts runs the set
-- with `skip: MANAGED_AUTH_MIGRATIONS` (the non-managed path, where Better Auth
-- has NOT pre-created `subscription`) — a strict superset of the passive EU/APAC
-- region where `subscription` is likewise absent, so the parity assertion there
-- proves 0153 alone supplies the table. `subscription` gets a Drizzle mirror in
-- db/schema.ts so scripts/check-schema-drift.sh stays green.

-- @better-auth/stripe `subscription` table — see header for the field→column
-- type mapping this mirrors.
CREATE TABLE IF NOT EXISTS subscription (
  "id" TEXT PRIMARY KEY,
  "plan" TEXT NOT NULL,
  "referenceId" TEXT NOT NULL,
  "stripeCustomerId" TEXT,
  "stripeSubscriptionId" TEXT,
  "status" TEXT NOT NULL,
  "periodStart" TIMESTAMPTZ,
  "periodEnd" TIMESTAMPTZ,
  "trialStart" TIMESTAMPTZ,
  "trialEnd" TIMESTAMPTZ,
  "cancelAtPeriodEnd" BOOLEAN,
  "cancelAt" TIMESTAMPTZ,
  "canceledAt" TIMESTAMPTZ,
  "endedAt" TIMESTAMPTZ,
  "seats" INTEGER,
  "billingInterval" TEXT,
  "stripeScheduleId" TEXT
);

-- EE SCIM group mappings — re-asserts the 0000_baseline.sql definition verbatim
-- so the passive regions converge to the same shape (inline UNIQUE constraint).
CREATE TABLE IF NOT EXISTS scim_group_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  scim_group_name TEXT NOT NULL,
  role_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, scim_group_name)
);
