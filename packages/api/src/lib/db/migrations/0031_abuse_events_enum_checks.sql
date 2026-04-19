-- 0031 — Abuse-event enum CHECK constraints (#1653)
--
-- `abuse_events.level` and `trigger_type` are plain TEXT columns. PR #1647
-- made the admin wire schema strict-parse via `z.enum(ABUSE_LEVELS)` /
-- `z.enum(ABUSE_TRIGGERS)`, so a single drifted row would crash the whole
-- admin investigation page with a `schema_mismatch` banner. The server-side
-- coercion in `lib/security/abuse.ts::coerceAbuseEnums` is the soft
-- backstop; this migration is the hard one — future drift attempts are
-- rejected at INSERT time.
--
-- Ordering matters: the cleanup UPDATEs must run before the ADD CONSTRAINT,
-- otherwise a pre-drifted row would make the migration fail to apply.

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
