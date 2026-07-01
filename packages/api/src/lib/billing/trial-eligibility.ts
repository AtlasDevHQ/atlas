/**
 * One-trial-per-user eligibility (#3426, hardened by #3469/#3470).
 *
 * ── Policy (recorded on #3426, maintainer triage 2026-06-12) ─────────
 * Trial eligibility keys on the CREATING USER, not the org: a user's
 * first workspace gets the 14-day trial; every subsequent workspace
 * they create starts on the `'locked'` churn tier (#3421) with zero
 * entitlements and an upgrade path — never a fresh trial. There is NO
 * hard cap on org count (a hard `organizationLimit` would block
 * legitimate paid multi-org customers). Self-hosted is unaffected:
 * every caller gates on `deployMode === 'saas'` before consulting this
 * module.
 *
 * ── Eligibility key ──────────────────────────────────────────────────
 * The durable marker is a `user_trial_grants` row (#3470) — one row per
 * user, stamped at grant time, immune to membership/role changes and
 * org deletion. The legacy proxy (the user is an OWNER member of any
 * other organization whose `trial_ends_at` is set) is kept as an OR-arm:
 * it covers users who *received* ownership of a trialed org without
 * creating it — we deliberately fail toward no-second-trial.
 *
 * ── Atomicity ────────────────────────────────────────────────────────
 * The grant itself is claimed via {@link claimTrialGrant} — a single
 * `INSERT ... ON CONFLICT (user_id) DO NOTHING` (#3469), so two
 * concurrent first-workspace creations by the same user mint exactly
 * one trial; the loser's org lands `'locked'`. The check-then-claim
 * pair lives in `assignSaasTrial` (`lib/auth/server.ts`).
 *
 * The set-based mirror of the eligibility predicate lives in
 * `backfill-saas-trial.ts` (boot-time heal) — keep the two in sync.
 */

import { internalQuery } from "@atlas/api/lib/db/internal";
import { fullTrialEndsAtFrom, trialTierSql, unclaimedGraceHorizonFrom } from "./trial-state";

/**
 * Whether `userId` has already consumed a SaaS trial via some org other
 * than `excludeOrgId` (pass the just-created org so its own owner row —
 * inserted before `afterCreateOrganization` fires — and a crash-orphaned
 * grant pointing at it can't count against itself).
 *
 * Throws on query failure — the caller owns the failure posture
 * (`assignSaasTrial` logs and leaves the org on `'free'` for the boot
 * backfill to heal with the same eligibility rule).
 */
export async function userHasConsumedTrial(
  userId: string,
  excludeOrgId: string,
): Promise<boolean> {
  const rows = await internalQuery<{ consumed: number }>(
    `SELECT 1 AS consumed
      WHERE EXISTS (
              SELECT 1 FROM user_trial_grants g
               WHERE g.user_id = $1 AND g.org_id <> $2
            )
         OR EXISTS (
              SELECT 1
                FROM member m
                JOIN organization o ON o.id = m."organizationId"
               WHERE m."userId" = $1
                 AND m.role = 'owner'
                 AND o.id <> $2
                 AND o.trial_ends_at IS NOT NULL
            )`,
    [userId, excludeOrgId],
  );
  return rows.length > 0;
}

/**
 * Atomically claim the user's one trial for `orgId` (#3469). Returns
 * `true` when this org holds the user's grant — either this call
 * inserted it (won the claim) or a previous attempt for the SAME org
 * already had (idempotent retry after a crash between claim and the
 * tier write, which the boot backfill heals). Returns `false` when the
 * user's grant belongs to a different org — the caller must take the
 * locked arm.
 *
 * The PRIMARY KEY on `user_id` is what makes this race-free: under two
 * concurrent first-workspace creations, exactly one INSERT returns a
 * row. Locks nothing across users.
 *
 * Throws on query failure — same caller-owned posture as
 * {@link userHasConsumedTrial}.
 */
export async function claimTrialGrant(
  userId: string,
  orgId: string,
): Promise<boolean> {
  const inserted = await internalQuery<{ user_id: string }>(
    `INSERT INTO user_trial_grants (user_id, org_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING user_id`,
    [userId, orgId],
  );
  if (inserted.length > 0) return true;

  const existing = await internalQuery<{ org_id: string }>(
    `SELECT org_id FROM user_trial_grants WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  return existing[0]?.org_id === orgId;
}

/**
 * Start the full trial clock when a user *claims* their account (ADR-0018 /
 * #3651). Claiming = completing the web OTP interstitial, which fires Better
 * Auth's `emailVerification.afterEmailVerification` hook; that hook calls this
 * with the verifying user's id.
 *
 * Extends `trial_ends_at` to the full trial window (`trial-state`'s
 * {@link fullTrialEndsAtFrom}) for every `trial`-tier Workspace this user
 * OWNS that is still inside the short unclaimed-grace window — i.e. an
 * MCP-provisioned trial (`start_trial` narrowed it to the grace hours). The
 * `trial_ends_at <= graceHorizon` guard ({@link unclaimedGraceHorizonFrom})
 * makes this idempotent and scoped:
 *   - A normal web-signup trial already carries the full trial window
 *     (`assignSaasTrial` stamped it at org creation), so it is OUTSIDE the
 *     grace horizon and left untouched — its clock already started.
 *   - Once a grace trial is extended to the full window here, a re-fire of the
 *     verification hook (a later profile/credential update re-verifying) finds
 *     it outside the grace horizon and is a no-op — no free clock resets.
 *
 * Returns the ids of the Workspaces whose clock was started so the caller can
 * invalidate their plan cache. Throws on query failure — the caller
 * (`afterEmailVerification`) logs and leaves the grace window in place.
 */
export async function extendTrialOnClaim(userId: string): Promise<string[]> {
  const now = Date.now();
  const trialEndsAt = fullTrialEndsAtFrom(now);
  const graceHorizon = unclaimedGraceHorizonFrom(now);
  const rows = await internalQuery<{ id: string }>(
    `UPDATE organization o
        SET trial_ends_at = $2
       FROM member m
      WHERE m."organizationId" = o.id
        AND m."userId" = $1
        AND m.role = 'owner'
        AND ${trialTierSql("o")}
        AND o.trial_ends_at IS NOT NULL
        AND o.trial_ends_at <= $3
      RETURNING o.id`,
    [userId, trialEndsAt, graceHorizon],
  );
  return rows.map((r) => r.id);
}
