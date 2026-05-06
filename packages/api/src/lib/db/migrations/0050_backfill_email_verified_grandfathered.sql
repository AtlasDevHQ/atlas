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
-- by definition, completed at least one sign-in. Better Auth only
-- inserts a session row after the credential check passes — meaning
-- the user proved (a) the email exists, (b) they know the password, and
-- (c) some prior version of the auth config let them through. That is
-- a strictly stronger signal than the one-time email-token click that
-- normally flips emailVerified, so promoting them to verified is at
-- worst neutral and never weaker than the original signal.
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
