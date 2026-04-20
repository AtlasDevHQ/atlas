-- Enforce backups.status enum at the DB layer. The canonical tuple lives in
-- `packages/types/src/backups.ts` (BACKUP_STATUSES) and is pinned in the
-- Zod schema at `packages/schemas/src/backup.ts` since #1648. Without a
-- matching DB CHECK, a direct SQL write could persist drift that the API
-- would later reject at read-time — or worse, surface with validation
-- errors to operators.
--
-- Drift policy: coerce any pre-existing out-of-tuple rows to `failed`.
-- `failed` is the safe default because the only way a row with a rogue
-- status made it into the table is via an interrupted backup run or a
-- direct SQL write — both of which map semantically to "this backup is
-- not trustworthy." We prefer coercion over aborting the migration so
-- self-hosted deploys don't get stuck on historical junk data.
--
-- Ordering is load-bearing: the cleanup UPDATE must run before the ADD
-- CONSTRAINT, otherwise a pre-drifted row would block the migration from
-- applying.
--
-- Mirrors the idempotency pattern from 0031_abuse_events_enum_checks.sql.
-- Related: #1679, #1680, #1678.
-- ── 1. Coerce any pre-drifted rows to the safe default ───────────────
UPDATE backups
SET status = 'failed'
WHERE status NOT IN ('in_progress', 'completed', 'failed', 'verified');

-- ── 2. Add CHECK constraint (idempotent) ─────────────────────────────
DO $$ BEGIN
  ALTER TABLE backups ADD CONSTRAINT chk_backups_status
    CHECK (status IN ('in_progress', 'completed', 'failed', 'verified'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
