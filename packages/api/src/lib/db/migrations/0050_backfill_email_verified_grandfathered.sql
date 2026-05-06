-- 0050 — Backfill emailVerified=true for users grandfathered before
-- ATLAS_REQUIRE_EMAIL_VERIFICATION was on.
--
-- Context: when `requireEmailVerification` is enabled, Better Auth's
-- /sign-in/email path rejects users whose `user.emailVerified` is false
-- with EMAIL_NOT_VERIFIED, regardless of whether they ever actually
-- proved control of the inbox. SaaS deployments that flipped this on
-- after launch ended up with a population of pre-existing users whose
-- row never set `emailVerified=true` because the original signup flow
-- didn't require it. With the same PR's `sendOnSignIn: true` change,
-- those users *would* get a fresh verification link on their next
-- attempt — but only if they happen to try signing in. Anyone holding
-- a still-valid session cookie has no signal anything is wrong until
-- the cookie expires, at which point they discover they can no longer
-- get back in. This migration unsticks them ahead of that boundary.
--
-- Heuristic: a user with at least one row in the `session` table has,
-- by definition, completed at least one sign-in (or a federated OAuth
-- flow that minted a session, or a magic-link verify). Under Atlas's
-- managed-auth config (see buildEmailAndPasswordConfig:
-- `autoSignIn = !requireEmailVerification`), a session row implies
-- one of:
--   - email/password sign-in — proves password, plus an
--     `emailVerified=true` precondition once requireEmailVerification
--     was on (so the only candidates left at `false` predate that flip)
--   - OAuth callback — federated identity proof; the provider also
--     sets `emailVerified` directly when it vouches
--   - magic-link verify — sets `emailVerified=true` at the same time,
--     so those rows are already filtered out by the WHERE clause
-- All three are at least as strong as the one-time inbox-token click
-- the normal verify flow consumes — promoting them is at worst neutral
-- and never weaker than the original signal.
--
-- This migration is `MANAGED_AUTH_MIGRATIONS`-gated in
-- packages/api/src/lib/db/internal.ts so it only runs against
-- deployments whose Better Auth `user`/`session` tables exist. The
-- scope of "session row implies inbox proof" is the SaaS deployment
-- (app.useatlas.dev) where requireEmailVerification has been on for
-- the relevant population — operators who flipped between modes
-- repeatedly should audit before re-enabling managed auth.
--
-- We deliberately do NOT backfill users with zero session rows: that
-- includes accounts created via signup that never completed verification
-- (the very population the gate exists to block from claiming an inbox
-- they don't control). Those accounts must still go through the regular
-- verification email path on their next sign-in attempt.
--
-- Idempotent. The WHERE clause skips already-verified rows so a re-run
-- is a no-op (no row churn, no replication chatter). Safe to leave in
-- the migration history forever — re-running on a fresh DB does
-- nothing because there are no qualifying users yet.

UPDATE "user" u
SET "emailVerified" = true
WHERE u."emailVerified" = false
  AND EXISTS (
    SELECT 1 FROM "session" s WHERE s."userId" = u.id
  );
