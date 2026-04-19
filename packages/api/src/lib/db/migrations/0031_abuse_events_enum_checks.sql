-- Enforce abuse_events.level / trigger_type enums at the DB layer. The
-- canonical tuples live in `packages/types/src/abuse.ts` — keep the values
-- here in sync.
--
-- Ordering is load-bearing: the cleanup UPDATEs must run before the ADD
-- CONSTRAINT, otherwise a pre-drifted row would block the migration from
-- applying.

-- ── 1. Coerce any pre-drifted rows to safe defaults ───────────────────
UPDATE abuse_events
SET level = 'none'
WHERE level NOT IN ('none', 'warning', 'throttled', 'suspended');

UPDATE abuse_events
SET trigger_type = 'manual'
WHERE trigger_type NOT IN ('query_rate', 'error_rate', 'unique_tables', 'manual');

-- ── 2. Add CHECK constraints (idempotent) ─────────────────────────────
DO $$ BEGIN
  ALTER TABLE abuse_events ADD CONSTRAINT chk_abuse_events_level
    CHECK (level IN ('none', 'warning', 'throttled', 'suspended'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE abuse_events ADD CONSTRAINT chk_abuse_events_trigger_type
    CHECK (trigger_type IN ('query_rate', 'error_rate', 'unique_tables', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
