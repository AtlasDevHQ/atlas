/**
 * One-time idempotent backfill: flip existing SaaS workspaces stuck on
 * `plan_tier='free'` onto `'trial'` with a fresh 14-day window.
 *
 * Pairs with the signup-time {@link assignSaasTrial} hook (#2465). New
 * orgs created after the hook lands take the happy path; this module
 * exists to retire the legacy `'free'` rows the hook didn't run for —
 * pre-launch this is the dogfood instance, but the pattern is safe for
 * any SaaS deploy that picks up the new code with existing orgs.
 *
 * Guarded on `deployMode === 'saas'` because self-hosted's free tier is
 * the legitimate free product — clobbering it would lock self-hosted
 * users into a trial they never asked for.
 *
 * Idempotent via the `WHERE trial_ends_at IS NULL` clause: subsequent
 * boots find zero candidates. Uses `NOW() + 14d` (not `createdAt + 14d`)
 * so the dogfood workspace gets a fresh window instead of landing
 * pre-expired the moment this code deploys.
 *
 * Wired through `BackfillSaasTrialLive` in
 * `packages/api/src/lib/effect/layers.ts`, scheduled after migrations
 * so the `organization` table is guaranteed to exist before the UPDATE.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { getConfig } from "@atlas/api/lib/config";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { TRIAL_DAYS } from "@atlas/api/lib/billing/plans";

const log = createLogger("billing.backfill-saas-trial");

export interface BackfillResult {
  /** Number of organization rows updated. Zero when skipped or already migrated. */
  readonly updatedCount: number;
  /** IDs of orgs flipped to trial. Empty when count is 0. */
  readonly orgIds: ReadonlyArray<string>;
}

const SKIPPED: BackfillResult = { updatedCount: 0, orgIds: [] };

/**
 * Run the backfill UPDATE if conditions allow.
 *
 * Returns `SKIPPED` synchronously when deploy mode isn't SaaS or no
 * internal DB is configured. Errors during the UPDATE are logged and
 * swallowed — backfill failure must not block API startup.
 */
export async function backfillSaasTrial(): Promise<BackfillResult> {
  if (getConfig()?.deployMode !== "saas") return SKIPPED;
  if (!hasInternalDB()) return SKIPPED;

  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

  try {
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
    log.info(
      { updatedCount: orgIds.length, orgIds, trialEndsAt: trialEndsAt.toISOString() },
      orgIds.length === 0
        ? "SaaS trial backfill: no free workspaces to promote"
        : "SaaS trial backfill: promoted free workspaces to trial",
    );
    return { updatedCount: orgIds.length, orgIds };
  } catch (err) {
    log.error(
      { err: errorMessage(err) },
      "SaaS trial backfill failed — free workspaces remain on free until the next boot retries",
    );
    return SKIPPED;
  }
}
