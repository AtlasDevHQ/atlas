/**
 * One-trial-per-user eligibility (#3426).
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
 * "Has this user already consumed a trial?" = the user is an OWNER
 * member of any other organization whose `trial_ends_at` is set.
 * `assignSaasTrial` stamps `trial_ends_at` the moment a trial is
 * granted (and the locked-at-birth branch stamps it too), and nothing
 * ever clears it — paid conversions keep the stamp — so the column
 * doubles as a durable "trial consumed" marker. Owner membership is the
 * closest queryable proxy for "creator": Better Auth inserts the
 * creator as `member.role = 'owner'` and stores no separate creator
 * column. A user who *received* ownership of a trialed org without
 * creating it is treated as having consumed a trial — we deliberately
 * fail toward no-second-trial rather than tracking creators in a new
 * column.
 *
 * The set-based mirror of this predicate lives in
 * `backfill-saas-trial.ts` (boot-time heal) — keep the two in sync.
 */

import { internalQuery } from "@atlas/api/lib/db/internal";

/**
 * Whether `userId` has already consumed a SaaS trial via some org other
 * than `excludeOrgId` (pass the just-created org so its own owner row —
 * inserted before `afterCreateOrganization` fires — can't count).
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
       FROM member m
       JOIN organization o ON o.id = m."organizationId"
      WHERE m."userId" = $1
        AND m.role = 'owner'
        AND o.id <> $2
        AND o.trial_ends_at IS NOT NULL
      LIMIT 1`,
    [userId, excludeOrgId],
  );
  return rows.length > 0;
}
