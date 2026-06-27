-- 0158 — `origin` marker column on the Better Auth-owned `session` table
-- (ADR-0026 / #4043).
--
-- The `atlas login` device-authorization flow issues a fresh Better Auth
-- session (internalAdapter.createSession) that the CLI uses as a bearer. To
-- key-scope that credential, the session is stamped `origin = 'cli'` by the
-- `session.create.before` hook (server.ts) when it originates from
-- /device/token; managed-auth role resolution then withholds the user-level
-- role for cli sessions (org-role-only — ADR-0026 §2). The marker is declared
-- as a Better Auth session `additionalField` (`origin`) so it rides every
-- getSession with no extra query.
--
-- ALTERs the Better Auth-owned `session` table. In non-managed auth modes
-- Better Auth never creates `session`, so the runner skips this file via
-- MANAGED_AUTH_MIGRATIONS (see packages/api/src/lib/db/internal.ts). Boot
-- ordering in managed mode is enforced by migrateAuthTables — Better Auth
-- migrations run first, same pattern as 0061.
--
-- Nullable, no default: a normal-login session leaves it NULL; only the
-- device-flow hook writes 'cli'. Adding a nullable column is expand-only and
-- single-release safe.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_name = 'session'
      AND table_schema = current_schema()
  ) THEN
    RAISE EXCEPTION 'Atlas migration 0158 requires the "session" table to exist in the current schema. In managed auth mode, Better Auth migrations must run before Atlas migrations.';
  END IF;
END $$;

ALTER TABLE "session"
  ADD COLUMN IF NOT EXISTS origin TEXT;

COMMENT ON COLUMN "session".origin IS
  'Agent origin that minted this session. NULL for normal web/login sessions; ''cli'' for sessions issued by the atlas-login device-authorization flow (ADR-0026 / #4043), which managed-auth role resolution treats as org-role-only.';
