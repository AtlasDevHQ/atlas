/**
 * Idempotent boot-time backfill: flip SaaS workspaces stuck on
 * `plan_tier='free'` onto `'trial'` with a fresh 14-day window — or onto
 * `'locked'` when an owner has already consumed a trial elsewhere
 * (#3426, one trial per user).
 *
 * Pairs with the signup-time `assignSaasTrial` hook (#2465). New orgs
 * created after the hook lands take the happy path; this module retires
 * the legacy `'free'` rows the hook didn't run for, and heals orgs whose
 * hook invocation errored. It applies the SAME one-trial-per-user rule
 * as the hook (`trial-eligibility.ts` holds the recorded policy): if the
 * heal blindly promoted every free org to trial, a hook failure followed
 * by a reboot would mint the second trial the hook refused.
 *
 * Guarded on `deployMode === 'saas'` because self-hosted's free tier is
 * the legitimate free product — clobbering it would lock self-hosted
 * users into a trial they never asked for.
 *
 * Idempotent via the `WHERE trial_ends_at IS NULL` clause: subsequent
 * boots find zero candidates (the locked arm stamps `trial_ends_at`
 * too). Uses `NOW() + 14d` (not `createdAt + 14d`) so existing 'free'
 * workspaces get a fresh window rather than landing pre-expired the
 * moment this code deploys.
 *
 * Three statements, lock-first: orgs with a trial-consumed owner are
 * demoted to 'locked' before the promote statement runs, so the promote
 * (`plan_tier = 'free'` guard) can never see them. The eligibility
 * predicate mirrors `userHasConsumedTrial` — the durable
 * `user_trial_grants` marker (#3470, a grant for a DIFFERENT org)
 * OR-joined with the legacy any-owner-of-a-trialed-org proxy — so we
 * fail toward no-second-trial. A grant pointing AT the org itself does
 * NOT lock it: that's the crash-heal shape (#3469 claimed the grant but
 * the tier write failed), and the promote arm finishes the job. After
 * promoting, owners of the promoted orgs are stamped into
 * `user_trial_grants` (ON CONFLICT DO NOTHING) so the heal records
 * consumption through the same marker the hook reads. Two free orgs
 * sharing a never-trialed owner both promote in the same pass (neither
 * has `trial_ends_at` when the statement snapshots) — that matches the
 * pre-#3426 behaviour for legacy rows and is not reachable by farming
 * (the signup hook claims atomically per user).
 *
 * Wired through `BackfillSaasTrialLive` in
 * `packages/api/src/lib/effect/layers.ts`, which depends on `Migration`
 * so the `organization` table is guaranteed to exist before the UPDATE.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { getConfig } from "@atlas/api/lib/config";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { TRIAL_DAYS } from "@atlas/api/lib/billing/plans";

const log = createLogger("billing.backfill-saas-trial");

export interface BackfillResult {
  /** Number of organization rows promoted to 'trial'. Zero when skipped or already migrated. */
  readonly updatedCount: number;
  /** IDs of orgs flipped to trial. Empty when count is 0. */
  readonly orgIds: ReadonlyArray<string>;
  /** IDs of orgs demoted to 'locked' because an owner already consumed a trial (#3426). */
  readonly lockedOrgIds: ReadonlyArray<string>;
}

const SKIPPED: BackfillResult = { updatedCount: 0, orgIds: [], lockedOrgIds: [] };

/**
 * Run the backfill UPDATEs if conditions allow.
 *
 * Returns `SKIPPED` synchronously when deploy mode isn't SaaS or no
 * internal DB is configured. Errors during the UPDATEs are logged and
 * swallowed — backfill failure must not block API startup.
 */
export async function backfillSaasTrial(): Promise<BackfillResult> {
  if (getConfig()?.deployMode !== "saas") return SKIPPED;
  if (!hasInternalDB()) return SKIPPED;

  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

  try {
    // 1) One-trial-per-user arm (#3426): free orgs with an owner who
    //    already consumed a trial land on 'locked', trial stamped as
    //    consumed-now. Must run BEFORE the promote arm. "Consumed" =
    //    the durable grant marker for a DIFFERENT org (#3470) or the
    //    legacy owner-of-a-trialed-org proxy — mirror of
    //    `userHasConsumedTrial`.
    const lockedRows = await internalQuery<{ id: string }>(
      `UPDATE organization o
          SET plan_tier = 'locked',
              trial_ends_at = NOW()
        WHERE o.plan_tier = 'free'
          AND o.trial_ends_at IS NULL
          AND EXISTS (
            SELECT 1
              FROM member m_new
             WHERE m_new."organizationId" = o.id
               AND m_new.role = 'owner'
               AND (
                 EXISTS (
                   SELECT 1 FROM user_trial_grants g
                    WHERE g.user_id = m_new."userId"
                      AND g.org_id <> o.id
                 )
                 OR EXISTS (
                   SELECT 1
                     FROM member m_prior
                     JOIN organization o_prior ON o_prior.id = m_prior."organizationId"
                    WHERE m_prior."userId" = m_new."userId"
                      AND m_prior.role = 'owner'
                      AND o_prior.id <> o.id
                      AND o_prior.trial_ends_at IS NOT NULL
                 )
               )
          )
        RETURNING id`,
    );
    const lockedOrgIds = lockedRows.map((r) => r.id);

    // 2) Everyone left on the default tier gets the fresh trial window.
    const rows = await internalQuery<{ id: string }>(
      `UPDATE organization
          SET plan_tier = 'trial',
              trial_ends_at = $1
        WHERE plan_tier = 'free'
          AND trial_ends_at IS NULL
        RETURNING id`,
      [trialEndsAt.toISOString()],
    );
    const orgIds = rows.map((r) => r.id);

    // 3) Record consumption for the healed grants through the same
    //    durable marker the signup hook claims (#3469/#3470), so a
    //    later owner demotion can't reopen eligibility. ON CONFLICT
    //    keeps a crash-healed org's existing claim intact.
    if (orgIds.length > 0) {
      await internalQuery(
        `INSERT INTO user_trial_grants (user_id, org_id)
         SELECT m."userId", m."organizationId"
           FROM member m
          WHERE m."organizationId" = ANY($1)
            AND m.role = 'owner'
         ON CONFLICT (user_id) DO NOTHING`,
        [orgIds],
      );
    }
    log.info(
      { updatedCount: orgIds.length, orgIds, lockedOrgIds, trialEndsAt: trialEndsAt.toISOString() },
      orgIds.length === 0 && lockedOrgIds.length === 0
        ? "SaaS trial backfill: no free workspaces to promote"
        : "SaaS trial backfill: promoted free workspaces (trial-consumed owners landed on locked)",
    );
    return { updatedCount: orgIds.length, orgIds, lockedOrgIds };
  } catch (err) {
    log.error(
      { err: errorMessage(err) },
      "SaaS trial backfill failed — free workspaces remain on free until the next boot retries",
    );
    return SKIPPED;
  }
}
