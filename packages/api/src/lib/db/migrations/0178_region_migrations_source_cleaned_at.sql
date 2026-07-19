-- 0178_region_migrations_source_cleaned_at.sql
-- #4458 — Phase 4 source-data cleanup execution.
--
-- `source_cleaned_at` records when the `region_migration_source_cleanup`
-- periodic fiber resolved this migration's source-region residue: either the
-- grace-period delete ran to completion, or the cleanup was permanently
-- skipped because the workspace is homed back in the source region (the
-- cutover guard — see lib/residency/cleanup.ts). NULL = cleanup still owed.
-- The sweep's due query filters on `source_cleaned_at IS NULL`, which is what
-- makes a partially-failed cleanup retry-safe: the stamp is written in the
-- same transaction as the deletes, so a rollback leaves the row due again.
ALTER TABLE region_migrations
  ADD COLUMN IF NOT EXISTS source_cleaned_at TIMESTAMPTZ;
