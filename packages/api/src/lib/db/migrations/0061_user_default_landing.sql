-- 0061 — Per-user default landing preference.
--
-- ALTERs the Better Auth-owned `user` table. In non-managed auth modes Better
-- Auth never creates `user`, so the migration runner skips this file via
-- MANAGED_AUTH_MIGRATIONS (see packages/api/src/lib/db/internal.ts). Boot
-- ordering in managed mode is enforced by migrateAuthTables — Better Auth
-- migrations run first, same pattern as 0027.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_name = 'user'
      AND table_schema = current_schema()
  ) THEN
    RAISE EXCEPTION 'Atlas migration 0061 requires the "user" table to exist in the current schema. In managed auth mode, Better Auth migrations must run before Atlas migrations.';
  END IF;
END $$;

ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS default_landing TEXT NOT NULL DEFAULT 'chat';

-- Pin the legal value set at the DB layer so a regression that writes an
-- unknown literal fails with 23514 instead of silently breaking the routing
-- decision. ADD CONSTRAINT IF NOT EXISTS arrives in Postgres 18 — until then,
-- the DO block makes re-runs idempotent.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'user'
      AND constraint_name = 'user_default_landing_check'
  ) THEN
    ALTER TABLE "user"
      ADD CONSTRAINT user_default_landing_check
      CHECK (default_landing IN ('chat', 'admin'));
  END IF;
END $$;
