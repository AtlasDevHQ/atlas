-- 0142 — normalizedEmail column for business-email-only signup (#3650).
--
-- ALTERs the Better Auth-owned `user` table to add the `normalizedEmail`
-- column the `better-auth-harmony` `emailHarmony` plugin writes (lower-cased,
-- `+alias`/dot-collapsed address). The unique index is what restores teeth to
-- the one-trial-per-user bound: `+alias`/dot/case variants collapse to one
-- normalized value, so a duplicate signup trips a 23505 instead of minting a
-- second trial. See ADR-0018.
--
-- In managed mode Better Auth's own migrator (`ctx.runMigrations()`) normally
-- materializes this column from the plugin's schema declaration and runs FIRST
-- (the server entry calls runBootMigrations before MigrationLive — see
-- auth/migrate.ts) — so the ADD COLUMN below is idempotent, and the named
-- UNIQUE INDEX pins the constraint deterministically regardless of how the
-- plugin's auto-migration spells it. The `user`-table existence guard below is
-- NOT decorative belt-and-suspenders: it is the primary safety net for the
-- degenerate case where that ordering did not hold — it fails loud rather than
-- silently ADDing a column to a non-existent table.
--
-- In non-managed auth modes Better Auth never creates `user`, so the migration
-- runner skips this file via MANAGED_AUTH_MIGRATIONS (see
-- packages/api/src/lib/db/internal.ts). The Better Auth `user` table is not a
-- Drizzle pgTable in db/schema.ts (Better Auth owns it), so there is no
-- schema.ts mirror to add — same as 0061 (default_landing). scripts/
-- check-schema-drift.sh only diffs CREATE TABLE statements, so an ALTER on a
-- non-mirrored table is not drift.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_name = 'user'
      AND table_schema = current_schema()
  ) THEN
    RAISE EXCEPTION 'Atlas migration 0142 requires the "user" table to exist in the current schema. In managed auth mode, Better Auth migrations must run before Atlas migrations.';
  END IF;
END $$;

ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "normalizedEmail" TEXT;

-- Unique on the normalized address. NULLs are distinct in a Postgres unique
-- index, so legacy rows that predate the column (NULL normalizedEmail) never
-- collide with each other or with new signups.
CREATE UNIQUE INDEX IF NOT EXISTS user_normalized_email_unique
  ON "user" ("normalizedEmail");
