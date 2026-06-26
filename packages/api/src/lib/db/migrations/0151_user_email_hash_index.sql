-- 0151 — hashed-email existence index for the returning-user login front-door
-- (ADR-0024 §3, #3973).
--
-- The login front-door on app.useatlas.dev resolves email→region BEFORE any
-- session exists by fanning out a hashed-email existence probe to every
-- region. Each region answers "does a user with sha256(lower(email)) exist
-- here?" against its OWN `user` table — never the raw email, never a global
-- email→region store. To answer that from a hash without reversing it, the
-- region computes the same forward hash over its stored emails. `pgcrypto`'s
-- `digest()` is the only way to compute SHA-256 in-database; the functional
-- index turns the probe into an indexed lookup instead of a per-row seq scan.
--
-- The index expression MUST match the probe query expression verbatim
-- (`encode(digest(lower(email), 'sha256'), 'hex')`) for the planner to use it —
-- see `region-routing.ts`. All three functions (lower/digest/encode) are
-- IMMUTABLE, so the expression is index-eligible.
--
-- Like 0142 (normalizedEmail), this depends on the Better Auth-owned `user`
-- table existing (here a CREATE INDEX over it, plus CREATE EXTENSION), so it
-- joins MANAGED_AUTH_MIGRATIONS (db/internal.ts) and is skipped in non-managed
-- auth modes where Better Auth never creates `user`. The `user`
-- table is not a Drizzle pgTable in db/schema.ts (Better Auth owns it), so
-- there is no schema.ts mirror to add — same as 0142. scripts/
-- check-schema-drift.sh only diffs CREATE TABLE statements, so a CREATE INDEX
-- on a non-mirrored table is not drift.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_name = 'user'
      AND table_schema = current_schema()
  ) THEN
    RAISE EXCEPTION 'Atlas migration 0151 requires the "user" table to exist in the current schema. In managed auth mode, Better Auth migrations must run before Atlas migrations.';
  END IF;
END $$;

-- pgcrypto provides digest(); idempotent and harmless if already present.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Functional index on the hex SHA-256 of the lower-cased email. Must match the
-- probe query expression exactly so the planner can use it.
CREATE INDEX IF NOT EXISTS user_email_sha256_idx
  ON "user" (encode(digest(lower(email), 'sha256'), 'hex'));
