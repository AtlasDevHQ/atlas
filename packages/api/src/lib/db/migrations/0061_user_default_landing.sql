-- 0061 — Per-user default landing preference (#2022).
--
-- Adds `default_landing` to the Better Auth `user` table so we can route a
-- fresh signed-in user to the chat surface by default, with an admin opt-out.
-- The chat-first front door is the "first impression is agent, not Workday"
-- gate documented in 1.4.3 (#2022). Self-hosted developers who lean into the
-- admin console can flip the preference in Settings → Profile and keep their
-- existing entry point.
--
-- Why this migration ALTERs a Better Auth table (and how the runner handles
-- it): see the comment block above `MANAGED_AUTH_MIGRATIONS` in
-- packages/api/src/lib/db/internal.ts. In non-managed auth modes Better Auth
-- never creates `user`, so the migration runner skips this file via the
-- managed-only allowlist. Boot ordering in managed mode is enforced by
-- migrateAuthTables (Better Auth migrations run first), same pattern as 0027.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user') THEN
    RAISE EXCEPTION 'Atlas migration 0061 requires the "user" table to exist. In managed auth mode, Better Auth migrations must run before Atlas migrations. See https://github.com/AtlasDevHQ/atlas/issues/2022.';
  END IF;
END $$;

ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS default_landing TEXT NOT NULL DEFAULT 'chat';

-- Pin the legal value set at the DB layer so a regression that writes an
-- unknown literal fails with 23514 (check_violation) instead of silently
-- breaking the routing decision. ADD CONSTRAINT IF NOT EXISTS lands in
-- Postgres 18 — until then, guard with a DO block so re-runs are idempotent.
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
