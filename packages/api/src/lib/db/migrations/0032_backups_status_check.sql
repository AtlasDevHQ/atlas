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
-- Same UPDATE-before-CHECK ordering rationale + idempotency pattern as
-- 0031_abuse_events_enum_checks.sql — see that migration's header.
-- Originating issue: #1679. Related context: schemas phase 3 (#1678).
-- ── 1. Coerce any pre-drifted rows to the safe default ───────────────
-- Emit a RAISE NOTICE with the coerced row count so operators have a
-- post-mortem breadcrumb instead of silent rewrites (0031 shipped
-- without this — don't repeat that gap).
DO $$
DECLARE
  coerced_count INTEGER;
BEGIN
  UPDATE backups
  SET status = 'failed'
  WHERE status NOT IN ('in_progress', 'completed', 'failed', 'verified');
  GET DIAGNOSTICS coerced_count = ROW_COUNT;
  IF coerced_count > 0 THEN
    RAISE NOTICE 'backups.status drift: coerced % row(s) to ''failed''', coerced_count;
  END IF;
END $$;

-- ── 2. Add CHECK constraint (idempotent) ─────────────────────────────
DO $$ BEGIN
  ALTER TABLE backups ADD CONSTRAINT chk_backups_status
    CHECK (status IN ('in_progress', 'completed', 'failed', 'verified'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
