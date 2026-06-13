-- 0131 — Distinguish billing-induced suspensions from operator/manual ones (#3424).
--
-- The payment-failure recovery ladder (lib/auth/server.ts) reuses the existing
-- `workspace_status = 'suspended'` state as the billing block (unpaid / 3+
-- failed attempts). Without a source marker, the recovery handler
-- (invoice.paid / status → active) would unsuspend ANY suspended workspace —
-- including one an operator suspended for a different reason (e.g. ToS abuse).
-- That is a correctness regression: a billing recovery could silently clear a
-- manual suspension.
--
-- This column records WHY a workspace is suspended so recovery can scope itself
-- to billing-induced suspensions only. It is NULL when the workspace is not
-- suspended, 'billing' when the delinquency ladder suspended it, and 'operator'
-- when an admin/platform operator suspended it manually.
--
-- This ALTERs the Better Auth `organization` table, so (like 0027/0126/0127) it
-- joins MANAGED_AUTH_MIGRATIONS in db/internal.ts and is skipped by the runner
-- in non-managed auth modes (where Better Auth never creates `organization`).
-- The `organization` table is NOT a Drizzle-managed table (not in schema.ts), so
-- there is no schema.ts mirror to update — its columns live only in raw
-- migrations (see 0027_organization_saas_columns.sql).

DO $$ BEGIN
  -- Scope the existence check to the caller's search_path via to_regclass
  -- (same rationale as 0027 / 0000_baseline.sql — a sibling-schema match would
  -- pass information_schema then fail the ALTER).
  IF to_regclass('organization') IS NULL THEN
    RAISE EXCEPTION 'Atlas migration 0131 requires the "organization" table to exist. In managed auth mode, Better Auth migrations must run before Atlas migrations (#1472). Migration 0131 is registered in MANAGED_AUTH_MIGRATIONS so non-managed deploys skip it.';
  END IF;
END $$;

ALTER TABLE organization ADD COLUMN IF NOT EXISTS suspension_source TEXT;

DO $$ BEGIN
  ALTER TABLE organization ADD CONSTRAINT chk_suspension_source
    CHECK (suspension_source IS NULL OR suspension_source IN ('billing', 'operator'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
