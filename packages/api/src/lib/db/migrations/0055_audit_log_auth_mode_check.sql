-- 0055 — CHECK constraint on audit_log.auth_mode (#2184).
--
-- The TS-side AuthMode union (packages/types/src/auth.ts) is closed:
--   'none' | 'simple-key' | 'managed' | 'byot'
--
-- The DB-side audit_log.auth_mode column has been TEXT NOT NULL with
-- no CHECK. #2182's first commit silently wrote the literal 'mcp' into
-- this column; the regression was caught by a human reviewer, not the
-- DB. Pin the canonical four values so the next regression of this
-- shape fails at write time with PostgreSQL 23514 instead of polluting
-- the audit log.
--
-- Mirrors the chk_audit_log_actor_kind pattern from migration 0049,
-- but without the NULL escape hatch — auth_mode is NOT NULL and every
-- writer already supplies one of the four canonical values.

-- Defensive backfill: any pre-existing non-canonical row would block
-- the ALTER. Rewrite to 'managed' (the SaaS default; the only path
-- that legitimately writes any other value is self-host simple-key,
-- which would already have been canonical). RAISE NOTICE so an
-- operator running migrations sees the rewrite count if it's non-zero.
DO $$
DECLARE
  rewrite_count INTEGER;
BEGIN
  UPDATE audit_log
  SET auth_mode = 'managed'
  WHERE auth_mode NOT IN ('none', 'simple-key', 'managed', 'byot');
  GET DIAGNOSTICS rewrite_count = ROW_COUNT;
  IF rewrite_count > 0 THEN
    RAISE NOTICE 'Rewrote % audit_log row(s) with non-canonical auth_mode to managed', rewrite_count;
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE audit_log
    ADD CONSTRAINT chk_audit_log_auth_mode
    CHECK (auth_mode IN ('none', 'simple-key', 'managed', 'byot'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
