-- 0115 — Organization activity timestamp for BYOT dormancy gating (#2377).
--
-- Adds `organization.last_active_at`, stamped (throttled) on every
-- authenticated chat turn via `markOrgActive` (lib/db/org-activity.ts). The
-- BYOT catalog refresh scheduler (lib/scheduler/byot-catalog-refresh.ts)
-- reads it to SKIP refreshing model catalogs for workspaces nobody has
-- touched in `ATLAS_BYOT_DORMANCY_DAYS` (default 30) — sparing upstream
-- provider rate limits and audit-log noise for dormant orgs. Before this,
-- the only dormancy proxy was the daily refresh TTL (a workspace nobody
-- touches still aged out once a day; see the deferral comment retired by
-- this change in byot-catalog-refresh.ts).
--
-- Better-Auth-managed table: this file is listed in MANAGED_AUTH_MIGRATIONS
-- (db/internal.ts), so it runs ONLY when managed auth created the
-- `organization` table. In every other auth mode (byot / simple-key / none)
-- the table is absent, the migration is skipped, and the dormancy gate
-- self-disables (see `detectAuthMode()` check in findStaleByotCatalogs) —
-- dormancy is a multi-tenant concern that does not apply single-tenant.
-- The guard below fails loudly if that ordering is ever violated (mirrors
-- 0090).
--
-- NOT NULL DEFAULT now(): existing rows backfill to migration time, so every
-- org reads as "active" for the first dormancy window post-deploy — the
-- legacy refresh-everything behavior is preserved until real activity data
-- accumulates. Better Auth's org INSERTs omit this column, so the default
-- populates it for new orgs automatically.
--
-- No index on `last_active_at`: the dormancy query reaches `organization`
-- via its primary key (joined from `workspace_model_config.org_id`), so
-- `last_active_at` is a post-lookup row filter, not a scan key. An index
-- would only add write amplification to the frequent `markOrgActive`
-- UPDATEs without speeding up any read.

DO $$ BEGIN
  -- Scope to caller's search_path via to_regclass — see 0000_baseline.sql
  -- comment + #2820 for the parallel-test-schema race this avoids.
  IF to_regclass('organization') IS NULL THEN
    RAISE EXCEPTION 'Atlas migration 0115 requires the "organization" table to exist. In managed auth mode, Better Auth migrations must run before Atlas migrations.';
  END IF;
END $$;

ALTER TABLE organization
  ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ NOT NULL DEFAULT now();
