/**
 * Unclaimed-grace reaper (#3652, ADR-0018) — bounds the free pre-claim
 * window of a self-serve trial Workspace provisioned over MCP.
 *
 * `start_trial` (the anonymous onboarding caller) provisions a Workspace onto
 * `plan_tier='trial'` but narrows `trial_ends_at` to the short
 * {@link TRIAL_GRACE_HOURS} unclaimed-grace window rather than the full
 * {@link TRIAL_DAYS} — the 14-day clock only starts when a human *claims* the
 * account on the web (verify email → set credential → accept ToS). Until then
 * the owner's `emailVerified` bit is `false` and the Workspace is metered.
 *
 * This sweep reaps the abandoned ones: an UNCLAIMED Workspace whose grace
 * window has lapsed is demoted to the `'locked'` churn tier (#3421, zero
 * entitlements), so Gate 0 (`checkPlanLimits`) then blocks it on EVERY surface
 * including MCP with `subscription_required` — setup tools included. Abandoned
 * and spam signups self-clean instead of sitting on a free-MCP-querying window.
 *
 * What it must NEVER touch — pinned by `reap-unclaimed-grace.test.ts`:
 *   - A CLAIMED trial (owner `emailVerified = true`). Those run their full
 *     14-day clock and are handled by normal trial-expiry — the EXISTS arm
 *     below only matches an UNVERIFIED owner, so a claimed trial is invisible
 *     to this sweep regardless of its `trial_ends_at`.
 *   - A within-grace unclaimed Workspace (`trial_ends_at` still in the future).
 *   - A Workspace under an active operator plan-override window (#3427) — the
 *     same precedence the Stripe-webhook sync and `reconcilePlanTiers` honor.
 *
 * SaaS-only: a no-op off-SaaS (`deployMode !== 'saas'`) and when no internal DB
 * is configured — same self-contained gate shape as `backfillSaasTrial`. Wired
 * onto the existing scheduler as a periodic fiber in
 * `packages/api/src/lib/effect/layers.ts`, gated again on SaaS deploy mode.
 *
 * Idempotent and safe to run concurrently across instances: the reap is a
 * plain guarded `UPDATE`; an already-locked row no longer matches
 * `plan_tier = 'trial'`, so a second pass (or a peer instance) finds zero
 * candidates.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { getConfig } from "@atlas/api/lib/config";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { invalidatePlanCache } from "@atlas/api/lib/billing/enforcement";

const log = createLogger("billing.reap-unclaimed-grace");

export interface ReapResult {
  /** Number of unclaimed past-grace Workspaces demoted to 'locked' this pass. */
  readonly reapedCount: number;
  /** IDs of the reaped Workspaces. Empty when none qualified. */
  readonly orgIds: ReadonlyArray<string>;
}

const SKIPPED: ReapResult = { reapedCount: 0, orgIds: [] };

/**
 * Run one reaping pass.
 *
 * Returns `SKIPPED` synchronously when deploy mode isn't SaaS or no internal DB
 * is configured. Errors during the UPDATE are logged and swallowed — a failed
 * sweep must not crash the scheduler fiber; the next interval retries.
 */
export async function reapUnclaimedGraceWorkspaces(): Promise<ReapResult> {
  if (getConfig()?.deployMode !== "saas") return SKIPPED;
  if (!hasInternalDB()) return SKIPPED;

  try {
    // Demote unclaimed past-grace trials to the 'locked' churn tier. The
    // guards, in order:
    //   - `plan_tier = 'trial'`           — only a live trial can be reaped;
    //     an already-locked/paid row is skipped (idempotent, concurrency-safe).
    //   - `trial_ends_at < NOW()`         — the grace window has lapsed. A
    //     within-grace Workspace (future `trial_ends_at`) is left alone.
    //   - operator-override guard         — never clobber an active
    //     `plan_override_until` grant (#3427), matching `reconcilePlanTiers`.
    //   - EXISTS unverified owner         — UNCLAIMED. A claimed trial (owner
    //     `emailVerified = true`) never matches, so it is never touched.
    const reaped = await internalQuery<{ id: string }>(
      `UPDATE organization o
          SET plan_tier = 'locked'
        WHERE o.plan_tier = 'trial'
          AND o.trial_ends_at IS NOT NULL
          AND o.trial_ends_at < NOW()
          AND (o.plan_override_until IS NULL OR o.plan_override_until <= NOW())
          AND EXISTS (
            SELECT 1
              FROM member m
              JOIN "user" u ON u.id = m."userId"
             WHERE m."organizationId" = o.id
               AND m.role = 'owner'
               AND u."emailVerified" = false
          )
        RETURNING id`,
    );
    const orgIds = reaped.map((r) => r.id);

    // Evict the reaped orgs from this replica's plan cache so a request hitting
    // this instance sees the lock immediately rather than after TTL (≤60s).
    // Per-replica only (#3432) — peers self-heal on TTL expiry, same contract
    // as `reconcilePlanTiers`.
    for (const id of orgIds) invalidatePlanCache(id);

    if (orgIds.length > 0) {
      log.info(
        { reapedCount: orgIds.length, orgIds },
        "Reaped unclaimed past-grace trial Workspaces — demoted to 'locked' (Gate 0 now blocks on all surfaces)",
      );
    }
    return { reapedCount: orgIds.length, orgIds };
  } catch (err) {
    log.error(
      { err: errorMessage(err) },
      "Unclaimed-grace reaper failed — candidates remain on 'trial' until the next interval retries",
    );
    return SKIPPED;
  }
}
